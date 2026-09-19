import { Check, Plus, RefreshCw, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppCtx, type AppState, type Tab } from "./app-context.tsx";
import { CreateJob } from "./components/CreateJob.tsx";
import { Jobs } from "./components/Jobs.tsx";
import { Ramp } from "./components/Ramp.tsx";
import { AsyncButton, RoleIcon, useToast } from "./components/ui.tsx";
import * as anchor from "./lib/anchor.ts";
import { CONTRACT_ID, expertAccount } from "./lib/config.ts";
import { friendlyError } from "./lib/contract.ts";
import { ensureReady, getBalances, type Balances } from "./lib/horizon.ts";
import { getLang, L, locale, setLang, subscribeLang } from "./lib/i18n.ts";
import { short, type Signer } from "./lib/signer.ts";
import { addCustomRole, allRoles, connectWallet, disconnectWallet, loadDemoSigners, removeCustomRole, roleText } from "./lib/wallet.ts";

const LS_ACTIVE = "ekisler.active";

export default function App() {
  const lang = useSyncExternalStore(subscribeLang, getLang);
  // Dil değişince tüm ağaç yeniden kurulur; L() her render'da güncel dili okur
  return <AppInner key={lang} />;
}

function AppInner() {
  const lang = getLang();
  const toast = useToast();
  const [demo, setDemo] = useState(loadDemoSigners);
  const [roles, setRoles] = useState(allRoles);
  const [newRole, setNewRole] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Signer | null>(null);
  const [activeKey, setActiveKey] = useState<string>(() => {
    try {
      return localStorage.getItem(LS_ACTIVE) ?? "contractor";
    } catch {
      return "contractor";
    }
  });
  const [tab, setTab] = useState<Tab>("jobs");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [tryPerUsdc, setRate] = useState<number | null>(null);
  const [jobsVersion, setJobsVersion] = useState(0);

  const signer: Signer | null = activeKey === "wallet" ? wallet : (demo[activeKey] ?? null);

  const selectAccount = (key: string) => {
    setActiveKey(key);
    try {
      localStorage.setItem(LS_ACTIVE, key);
    } catch {
      /* yok say */
    }
  };

  const refreshBalances = useCallback(async () => {
    if (!signer) return setBalances(null);
    try {
      setBalances(await getBalances(signer.address));
    } catch {
      setBalances(null);
    }
  }, [signer]);

  useEffect(() => {
    setBalances(null);
    refreshBalances();
  }, [refreshBalances]);

  useEffect(() => {
    anchor
      .discover()
      .then((info) => anchor.price(info, anchor.USDC_ASSET, anchor.TRY_ASSET, "100"))
      .then((p) => setRate(Number(p.buy_amount) / 100))
      .catch(() => setRate(null));
  }, []);

  const nameOf = useCallback(
    (address: string) => {
      const role = roles.find((r) => demo[r.key]?.address === address);
      if (role) return roleText(role).label;
      if (wallet?.address === address) return L("Cüzdanım", "My wallet");
      return short(address);
    },
    [demo, wallet, roles],
  );

  const ctx: AppState = useMemo(
    () => ({
      signer,
      demo,
      wallet,
      balances,
      refreshBalances,
      tryPerUsdc,
      nameOf,
      jobsVersion,
      bumpJobs: () => setJobsVersion((v) => v + 1),
      goTo: setTab,
    }),
    [signer, demo, wallet, balances, refreshBalances, tryPerUsdc, nameOf, jobsVersion],
  );

  const prepareAll = async () => {
    const all = [...Object.values(demo), ...(wallet ? [wallet] : [])];
    try {
      await Promise.all(all.map((s) => ensureReady(s)));
      toast("ok", L("Tüm hesaplar testnet XLM ile fonlandı ve USDC trustline açıldı", "All accounts funded with testnet XLM and USDC trustlines opened"));
      await refreshBalances();
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const needsSetup = balances && (!balances.funded || balances.usdc === null);

  const activeRole = roles.find((r) => r.key === activeKey);

  const createRole = async () => {
    const label = (newRole ?? "").trim();
    if (!label) return;
    const role = addCustomRole(label);
    const signers = loadDemoSigners();
    setDemo(signers);
    setRoles(allRoles());
    setNewRole(null);
    selectAccount(role.key);
    try {
      await ensureReady(signers[role.key]); // testnet XLM + USDC trustline
      setBalances(await getBalances(signers[role.key].address));
      toast("ok", L(`${label} rolü eklendi ve hesabı hazırlandı`, `${label} role added and its account set up`));
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const deleteRole = (key: string) => {
    removeCustomRole(key);
    setRoles(allRoles());
    if (activeKey === key) selectAccount("contractor");
  };

  // Telefonda roller yana kayar: açılışta seçili rol görünür olsun
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(".role.active");
    const row = el?.parentElement;
    if (el && row && row.scrollWidth > row.clientWidth) row.scrollLeft += el.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
  }, []);
  const tryValue = balances?.usdc != null && tryPerUsdc ? Number(balances.usdc) * tryPerUsdc : null;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="band">
        <header className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">Eİ</div>
            <div>
              <div className="brand-name">Ek İşler</div>
              <div className="brand-sub">{L("Kısa süreli işlerde güvenli ödeme", "Safe pay for short-term gigs")}</div>
            </div>
          </div>
          <div className="spacer" />
          <a className="net-pill" href={expertAccount(CONTRACT_ID)} target="_blank" rel="noreferrer" title={L("Ek İşler kontratını zincirde gör", "View the Ek İşler contract on-chain")}>
            Stellar Testnet · {L("kontrat", "contract")} {CONTRACT_ID.slice(0, 4)}…{CONTRACT_ID.slice(-4)} ↗
          </a>
          <div className="lang" role="group" aria-label="Language">
            {(["tr", "en"] as const).map((l) => (
              <button key={l} className={lang === l ? "active" : ""} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>

        <div className="band-grid">
          <div id="roles">
            <div className="who-label">{L("Demo rolünü seç · aynı tarayıcıda tüm tarafları oynayabilirsin", "Pick a demo role · you can play every party in one browser")}</div>
            <div className="roles" role="radiogroup" aria-label={L("Aktif rol", "Active role")}>
              {roles.map((r) => {
                const active = activeKey === r.key;
                return (
                  <button
                    key={r.key}
                    role="radio"
                    aria-checked={active}
                    className={`role ${active ? "active" : ""}`}
                    onClick={(e) => {
                      selectAccount(r.key);
                      e.currentTarget.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
                    }}
                  >
                    <span className="role-top">
                      <span className="role-icon">
                        <RoleIcon role={r.key} />
                      </span>
                      {active && (
                        <span className="role-check">
                          <Check size={12} strokeWidth={3} /> {L("Seçili", "Selected")}
                        </span>
                      )}
                    </span>
                    <span className="name">{roleText(r).label}</span>
                    <span className="hint">{roleText(r).hint}</span>
                    {r.key.startsWith("c") && (
                      <span
                        className="role-remove"
                        role="button"
                        aria-label={L("Rolü kaldır", "Remove role")}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteRole(r.key);
                        }}
                      >
                        <X size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
              {newRole === null ? (
                <button className="role add" onClick={() => setNewRole("")}>
                  <span className="role-icon">
                    <Plus size={18} />
                  </span>
                  <span className="name">{L("Rol ekle", "Add role")}</span>
                  <span className="hint">{L("Yeni bir çalışan hesabı (ör. Garson)", "A new worker account (e.g. Waiter)")}</span>
                </button>
              ) : (
                <form
                  className="role add editing"
                  onSubmit={(e) => {
                    e.preventDefault();
                    createRole();
                  }}
                >
                  <input autoFocus maxLength={28} placeholder={L("Rol adı, ör. Garson", "Role name, e.g. Waiter")} value={newRole} onChange={(e) => setNewRole(e.target.value)} />
                  <span className="row" style={{ gap: 6 }}>
                    <button className="btn sm" type="submit" disabled={!newRole.trim()}>
                      {L("Ekle", "Add")}
                    </button>
                    <button className="btn ghost sm" type="button" onClick={() => setNewRole(null)}>
                      {L("Vazgeç", "Cancel")}
                    </button>
                  </span>
                </form>
              )}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small" style={{ color: "var(--on-ink-muted)" }}>
                {L("veya", "or")}
              </span>
              {wallet ? (
                <button
                  role="radio"
                  aria-checked={activeKey === "wallet"}
                  className={`acct ${activeKey === "wallet" ? "active" : ""}`}
                  onClick={() => selectAccount("wallet")}
                >
                  <span className="emoji">
                    <Wallet size={17} />
                  </span>
                  <span className="name">
                    {L("Cüzdanım", "My wallet")} · {short(wallet.address)}
                  </span>
                </button>
              ) : (
                <AsyncButton
                  className="acct connect"
                  title={L("Freighter, xBull, Lobstr ve diğer Stellar cüzdanları", "Freighter, xBull, Lobstr and other Stellar wallets")}
                  onClick={async () => {
                    try {
                      const w = await connectWallet();
                      setWallet(w);
                      selectAccount("wallet");
                      toast("ok", `${L("Cüzdan bağlandı", "Wallet connected")}: ${short(w.address)}`);
                    } catch (e) {
                      toast("err", friendlyError(e));
                    }
                  }}
                >
                  <span className="emoji">
                    <Wallet size={17} />
                  </span>
                  <span className="name">{L("Kendi cüzdanını bağla", "Connect your own wallet")}</span>
                </AsyncButton>
              )}
            </div>
          </div>

          <div className="balance-card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="label">{L("Bakiye", "Balance")}</span>
              <span className="who small">{signer ? nameOf(signer.address) : "—"}</span>
            </div>
            <div className="big">
              {balances === null ? "…" : balances.usdc != null ? Number(balances.usdc).toFixed(2) : "0.00"}
              <small>USDC</small>
            </div>
            <div className="try">{tryValue !== null ? `≈ ₺${tryValue.toLocaleString(locale(), { maximumFractionDigits: 2 })}` : " "}</div>
            {needsSetup ? (
              <AsyncButton className="btn" onClick={prepareAll}>
                {L("Demo hesaplarını hazırla", "Set up demo accounts")}
              </AsyncButton>
            ) : (
              <div className="foot">
                {signer && (
                  <a className="mono" href={expertAccount(signer.address)} target="_blank" rel="noreferrer">
                    {short(signer.address)} ↗
                  </a>
                )}
                {balances && <span>· {balances.funded ? Number(balances.xlm).toFixed(0) : "0"} XLM</span>}
                <div className="spacer" />
                <AsyncButton className="btn ghost sm" onClick={prepareAll} title={L("Tüm demo hesaplarını fonla ve trustline aç", "Fund every demo account and open trustlines")}>
                  {L("Hazırla", "Set up")}
                </AsyncButton>
                <AsyncButton className="btn ghost sm" onClick={refreshBalances} title={L("Bakiyeyi yenile", "Refresh balance")}>
                  <RefreshCw size={15} />
                </AsyncButton>
                {activeKey === "wallet" && wallet && (
                  <button
                    className="btn ghost sm"
                    onClick={async () => {
                      await disconnectWallet().catch(() => {});
                      setWallet(null);
                      selectAccount("contractor");
                    }}
                  >
                    {L("Çıkış", "Disconnect")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rolebar" role="status">
        <div className="rolebar-inner">
          <span className="emoji" aria-hidden="true">
            <RoleIcon role={activeRole?.key} size={17} />
          </span>
          <span>
            {L("Şu an ", "Viewing as ")}
            <b>{activeRole ? roleText(activeRole).label : L("Cüzdanım", "My wallet")}</b>
            {L(" olarak görüyorsun", "")}
            <span className="rolebar-hint">
              {" "}
              · {activeRole ? roleText(activeRole).hint : L("Kendi cüzdanınla herhangi bir rolü oynayabilirsin", "Your own wallet can play any role")}
            </span>
          </span>
          <div className="spacer" />
          <span className="rolebar-bal">{balances?.usdc != null ? `${Number(balances.usdc).toFixed(2)} USDC` : ""}</span>
          <button className="btn sm dark" onClick={() => document.getElementById("roles")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            {L("Rolü değiştir", "Switch role")}
          </button>
        </div>
      </div>

      <main className="shell">
        <nav className="tabs" role="tablist">
          {(
            [
              ["jobs", L("İşler", "Jobs")],
              ["create", L("Yeni iş", "New job")],
              ["ramp", "TRY ⇄ USDC"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>

        {tab === "jobs" && <Jobs />}
        {tab === "create" && <CreateJob />}
        {tab === "ramp" && <Ramp />}

        <footer className="small muted" style={{ marginTop: 56, textAlign: "center" }}>
          {L(
            "Para Ek İşler'de değil, her iş için açılan Trustless Work escrow'unda durur",
            "The money never sits with Ek İşler; it stays in the Trustless Work escrow opened for each job",
          )}{" "}
          ·{" "}
          <a href={expertAccount(CONTRACT_ID)} target="_blank" rel="noreferrer">
            {L("Ek İşler kontratı", "Ek İşler contract")} ↗
          </a>
        </footer>
      </main>
    </AppCtx.Provider>
  );
}
