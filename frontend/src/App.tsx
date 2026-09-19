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
      refreshBalances();
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const needsSetup = balances && (!balances.funded || balances.usdc === null);

  return (
    <AppCtx.Provider value={ctx}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">Eİ</div>
            <div>
              Ek İşler
              <br />
              <small>Kısa süreli işler için güvenli ödeme paylaşımı</small>
            </div>
          </div>
          <div className="spacer" />
          <span className="net-pill">Stellar Testnet</span>
          <a className="small" href={expertAccount(CONTRACT_ID)} target="_blank" rel="noreferrer">
            Kontrat ↗
          </a>
        </div>
      </header>

      <main className="shell">
        <div className="accounts" role="radiogroup" aria-label="Aktif hesap">
          {DEMO_ROLES.map((r) => (
            <button
              key={r.key}
              role="radio"
              aria-checked={activeKey === r.key}
              className={`acct ${activeKey === r.key ? "active" : ""}`}
              onClick={() => selectAccount(r.key)}
              title={r.hint}
            >
              <span className="emoji">{r.emoji}</span>
              <span>
                <div className="name">{r.label}</div>
                <div className="addr mono">{short(demo[r.key].address)}</div>
              </span>
            </button>
          ))}
          {wallet ? (
            <button
              role="radio"
              aria-checked={activeKey === "wallet"}
              className={`acct ${activeKey === "wallet" ? "active" : ""}`}
              onClick={() => selectAccount("wallet")}
            >
              <span className="emoji">👛</span>
              <span>
                <div className="name">Cüzdanım</div>
                <div className="addr mono">{short(wallet.address)}</div>
              </span>
            </button>
          ) : (
            <AsyncButton
              className="acct"
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
              <span>
                <div className="name">Cüzdan bağla</div>
                <div className="addr">Freighter, xBull, Lobstr…</div>
              </span>
            </AsyncButton>
          )}
        </div>

        <div className="balance-bar">
          <div>
            <div className="label">Aktif hesap</div>
            <div style={{ fontWeight: 700 }}>{signer ? nameOf(signer.address) : "—"}</div>
            {signer && (
              <a className="mono small" href={expertAccount(signer.address)} target="_blank" rel="noreferrer">
                {short(signer.address)} ↗
              </a>
            )}
          </div>
          <div>
            <div className="label">USDC</div>
            <div className="big">{balances?.usdc != null ? Number(balances.usdc).toFixed(2) : "—"}</div>
            {balances?.usdc != null && tryPerUsdc && (
              <div className="small muted">≈ ₺{(Number(balances.usdc) * tryPerUsdc).toFixed(2)}</div>
            )}
          </div>
          <div>
            <div className="label">XLM (işlem ücreti)</div>
            <div className="big">{balances?.funded ? Number(balances.xlm).toFixed(0) : "—"}</div>
          </div>
          <div className="spacer" />
          {needsSetup && <span className="badge warn">Hesap hazır değil</span>}
          <AsyncButton className={needsSetup ? "btn" : "btn secondary sm"} onClick={prepareAll}>
            {needsSetup ? "Demo hesaplarını hazırla" : "Hesapları yenile"}
          </AsyncButton>
          <AsyncButton className="btn ghost sm" onClick={refreshBalances}>
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
              Bağlantıyı kes
            </button>
          )}
        </div>

        <nav className="tabs" role="tablist">
          {(
            [
              ["jobs", "İşler"],
              ["create", "Yeni iş oluştur"],
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
      </main>
    </AppCtx.Provider>
  );
}
