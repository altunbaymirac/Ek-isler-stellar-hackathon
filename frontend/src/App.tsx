import { useCallback, useEffect, useMemo, useState } from "react";
import { AppCtx, type AppState, type Tab } from "./app-context.tsx";
import { CreateJob } from "./components/CreateJob.tsx";
import { Jobs } from "./components/Jobs.tsx";
import { Ramp } from "./components/Ramp.tsx";
import { AsyncButton, useToast } from "./components/ui.tsx";
import * as anchor from "./lib/anchor.ts";
import { CONTRACT_ID, expertAccount } from "./lib/config.ts";
import { friendlyError } from "./lib/contract.ts";
import { ensureReady, getBalances, type Balances } from "./lib/horizon.ts";
import { short, type Signer } from "./lib/signer.ts";
import { connectWallet, DEMO_ROLES, disconnectWallet, loadDemoSigners } from "./lib/wallet.ts";

const LS_ACTIVE = "ekisler.active";

export default function App() {
  const toast = useToast();
  const [demo] = useState(loadDemoSigners);
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
      const role = DEMO_ROLES.find((r) => demo[r.key]?.address === address);
      if (role) return `${role.emoji} ${role.label}`;
      if (wallet?.address === address) return "👛 Cüzdanım";
      return short(address);
    },
    [demo, wallet],
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
      toast("ok", "Tüm hesaplar testnet XLM ile fonlandı ve USDC trustline açıldı");
      await refreshBalances();
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const needsSetup = balances && (!balances.funded || balances.usdc === null);

  const activeRole = DEMO_ROLES.find((r) => r.key === activeKey);

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
              <div className="brand-sub">Kısa süreli işlerde güvenli ödeme</div>
            </div>
          </div>
          <div className="spacer" />
          <span className="net-pill">Stellar Testnet</span>
        </header>

        <div className="band-grid">
          <div id="roles">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <div className="who-label" style={{ margin: 0 }}>
                Demo rolünü seç · aynı tarayıcıda tüm tarafları oynayabilirsin
              </div>
            </div>
            <div className="roles" role="radiogroup" aria-label="Aktif rol">
              {DEMO_ROLES.map((r) => {
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
                      <span className="emoji" aria-hidden="true">
                        {r.emoji}
                      </span>
                      {active && <span className="role-check">✓ Seçili</span>}
                    </span>
                    <span className="name">{r.label}</span>
                    <span className="hint">{r.hint}</span>
                  </button>
                );
              })}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small" style={{ color: "var(--on-ink-muted)" }}>
                veya
              </span>
              {wallet ? (
                <button
                  role="radio"
                  aria-checked={activeKey === "wallet"}
                  className={`acct ${activeKey === "wallet" ? "active" : ""}`}
                  onClick={() => selectAccount("wallet")}
                >
                  <span className="emoji">👛</span>
                  <span className="name">Cüzdanım · {short(wallet.address)}</span>
                </button>
              ) : (
                <AsyncButton
                  className="acct connect"
                  title="Freighter, xBull, Lobstr ve diğer Stellar cüzdanları"
                  onClick={async () => {
                    try {
                      const w = await connectWallet();
                      setWallet(w);
                      selectAccount("wallet");
                      toast("ok", `Cüzdan bağlandı: ${short(w.address)}`);
                    } catch (e) {
                      toast("err", friendlyError(e));
                    }
                  }}
                >
                  <span className="emoji">👛</span>
                  <span className="name">Kendi cüzdanını bağla</span>
                </AsyncButton>
              )}
            </div>
          </div>

          <div className="balance-card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="label">Bakiye</span>
              <span className="who small">{signer ? nameOf(signer.address) : "—"}</span>
            </div>
            <div className="big">
              {balances === null ? "…" : balances.usdc != null ? Number(balances.usdc).toFixed(2) : "0.00"}
              <small>USDC</small>
            </div>
            <div className="try">{tryValue !== null ? `≈ ₺${tryValue.toLocaleString("tr-TR", { maximumFractionDigits: 2 })}` : " "}</div>
            {needsSetup ? (
              <AsyncButton className="btn" onClick={prepareAll}>
                Demo hesaplarını hazırla
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
                <AsyncButton className="btn ghost sm" onClick={prepareAll} title="Tüm demo hesaplarını fonla ve trustline aç">
                  Hazırla
                </AsyncButton>
                <AsyncButton className="btn ghost sm" onClick={refreshBalances} title="Bakiyeyi yenile">
                  ↻
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
                    Çıkış
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
            {activeRole?.emoji ?? "👛"}
          </span>
          <span>
            Şu an <b>{activeRole?.label ?? "Cüzdanım"}</b> olarak görüyorsun
            <span className="rolebar-hint"> · {activeRole?.hint ?? "Kendi cüzdanınla herhangi bir rolü oynayabilirsin"}</span>
          </span>
          <div className="spacer" />
          <span className="rolebar-bal">{balances?.usdc != null ? `${Number(balances.usdc).toFixed(2)} USDC` : ""}</span>
          <button className="btn sm dark" onClick={() => document.getElementById("roles")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            Rolü değiştir
          </button>
        </div>
      </div>

      <main className="shell">
        <nav className="tabs" role="tablist">
          {(
            [
              ["jobs", "İşler"],
              ["create", "Yeni iş"],
              ["ramp", "TL ⇄ USDC"],
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

        <footer className="small muted" style={{ marginTop: 48, textAlign: "center" }}>
          Para Ek İşler'de değil, her iş için açılan Trustless Work escrow'unda durur ·{" "}
          <a href={expertAccount(CONTRACT_ID)} target="_blank" rel="noreferrer">
            Ek İşler kontratı ↗
          </a>
        </footer>
      </main>
    </AppCtx.Provider>
  );
}
