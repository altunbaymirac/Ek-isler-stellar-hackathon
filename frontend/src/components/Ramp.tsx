import { useEffect, useRef, useState } from "react";
import { useApp } from "../app-context.tsx";
import * as anchor from "../lib/anchor.ts";
import { expertTx } from "../lib/config.ts";
import { friendlyError } from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { AsyncButton, useToast } from "./ui.tsx";

interface Session {
  info: anchor.AnchorInfo;
  token: string;
  kyc: string;
}

// Anchor oturumları hesap bazında bellekte tutulur (JWT localStorage'a yazılmaz)
const sessions = new Map<string, Session>();

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Ramp() {
  const { signer, balances, refreshBalances, nameOf } = useApp();
  const toast = useToast();
  const [session, setSession] = useState<Session | null>(signer ? (sessions.get(signer.address) ?? null) : null);
  const [info, setInfo] = useState<anchor.AnchorInfo | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const afterTransfer = async () => {
    setHistoryVersion((v) => v + 1);
    await refreshBalances();
  };

  useEffect(() => {
    setSession(signer ? (sessions.get(signer.address) ?? null) : null);
  }, [signer]);

  useEffect(() => {
    anchor.discover().then(setInfo).catch((e) => toast("err", friendlyError(e)));
  }, [toast]);

  const login = async () => {
    if (!signer) return;
    try {
      const i = info ?? (await anchor.discover());
      await ensureReady(signer);
      const token = await anchor.login(i, signer);
      const kyc = await anchor.ensureKyc(i, token, signer.address);
      const s = { info: i, token, kyc };
      sessions.set(signer.address, s);
      setSession(s);
      refreshBalances();
      toast("ok", `Anchor oturumu açıldı · KYC: ${kyc}`);
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  if (!signer) return <div className="card empty">Önce bir hesap seç.</div>;

  return (
    <div className="stack">
      <div className="hero">
        <h1>Türk Lirası ile gir, Türk Lirası ile çık.</h1>
        <p>
          Müşteri banka havalesiyle TL yatırır, anchor bunu USDC'ye çevirir. Çalışanlar kazandıkları USDC'yi tek tıkla IBAN'larına TL
          olarak çeker. Akış TR Mock Anchor üzerinden SEP-1, SEP-10, SEP-12, SEP-38 ve SEP-6 standartlarıyla çalışır.
        </p>
      </div>

      <section className="card">
        <div className="vstep-row row">
          <div>
            <h3 style={{ margin: 0 }}>
              1 · Anchor'a giriş <span className="sep-tag">SEP-10</span>
              <span className="sep-tag">SEP-12</span>
            </h3>
            <div className="small muted">
              {nameOf(signer.address)} hesabı, anchor'ın gönderdiği challenge işlemini imzalayarak kimliğini kanıtlar.
            </div>
          </div>
          <div className="spacer" />
          {session ? (
            <span className="row" style={{ gap: 6 }}>
              <span className="badge ok">✓ JWT alındı</span>
              <span className={`badge ${session.kyc === "ACCEPTED" ? "ok" : "warn"}`}>KYC: {session.kyc}</span>
            </span>
          ) : (
            <AsyncButton onClick={login}>Cüzdanla giriş yap</AsyncButton>
          )}
        </div>
      </section>

      <div className="grid-2">
        <Deposit session={session} onDone={afterTransfer} />
        <Withdraw session={session} usdc={balances?.usdc ?? null} onDone={afterTransfer} />
      </div>

      {session && <History session={session} version={historyVersion} />}
    </div>
  );
}

function Deposit({ session, onDone }: { session: Session | null; onDone: () => Promise<void> }) {
  const { signer } = useApp();
  const toast = useToast();
  const [amount, setAmount] = useState("1000");
  const debounced = useDebounced(amount);
  const [quote, setQuote] = useState<anchor.Quote | null>(null);
  const [dep, setDep] = useState<(anchor.DepositInstructions & { quote?: anchor.Quote }) | null>(null);
  const [status, setStatus] = useState<anchor.AnchorTx | null>(null);

  useEffect(() => {
    if (!session || !(Number(debounced) > 0)) return setQuote(null);
    anchor
      .price(session.info, anchor.TRY_ASSET, anchor.USDC_ASSET, debounced)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [session, debounced]);

  const start = async () => {
    if (!session || !signer) return;
    try {
      setStatus(null);
      const q = await anchor.firmQuote(session.info, session.token, anchor.TRY_ASSET, anchor.USDC_ASSET, amount);
      let d: anchor.DepositInstructions;
      try {
        d = await anchor.startDeposit(session.info, session.token, signer.address, amount, q.id);
      } catch {
        d = await anchor.startDeposit(session.info, session.token, signer.address, amount);
      }
      setDep({ ...d, quote: q });
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const simulate = async () => {
    if (!session || !dep) return;
    try {
      await anchor.simulateBankTransfer(session.info, dep.id, amount);
      const t = await anchor.pollTx(session.info, session.token, dep.id, setStatus);
      if (t.status === "completed") {
        toast("ok", `${Number(t.amount_out).toFixed(2)} USDC hesabına geçti`, t.stellar_transaction_id);
        setDep(null);
        await onDone();
      } else toast("err", `Anchor işlemi: ${t.status} ${t.message ?? ""}`);
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>
        2 · TL yatır → USDC al <span className="sep-tag">SEP-38</span>
        <span className="sep-tag">SEP-6</span>
      </h3>
      <p className="small muted" style={{ margin: 0 }}>
        Müşteri, işin bedelini banka havalesiyle öder. Anchor kilitli kur üzerinden USDC gönderir.
      </p>
      <label className="field">
        Tutar (TRY)
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} disabled={!session || !!dep} />
      </label>
      {quote && (
        <dl className="kv">
          <dt>Alacağın</dt>
          <dd>{Number(quote.buy_amount).toFixed(2)} USDC</dd>
          <dt>Kur</dt>
          <dd>1 USDC = ₺{Number(quote.price).toFixed(2)}</dd>
          <dt>Ücret</dt>
          <dd>₺{quote.fee?.total ?? "0"} (spread)</dd>
        </dl>
      )}
      {!dep ? (
        <AsyncButton disabled={!session || !(Number(amount) > 0)} onClick={start}>
          Havale talimatı al
        </AsyncButton>
      ) : (
        <>
          <div className="callout">
            <dl className="kv">
              <dt>Banka</dt>
              <dd>{dep.bank}</dd>
              <dt>IBAN</dt>
              <dd className="mono">{dep.iban}</dd>
              <dt>Açıklama</dt>
              <dd className="mono">{dep.reference}</dd>
              {dep.quote?.id && (
                <>
                  <dt>Kur teklifi</dt>
                  <dd className="mono">{dep.quote.id}</dd>
                </>
              )}
            </dl>
          </div>
          <div className="row">
            <AsyncButton className="btn ok" onClick={simulate}>
              Havaleyi gönder (sandbox)
            </AsyncButton>
            <button className="btn ghost sm" onClick={() => setDep(null)}>
              Vazgeç
            </button>
            {status && <span className="badge primary">{status.status}</span>}
          </div>
        </>
      )}
    </section>
  );
}

function Withdraw({ session, usdc, onDone }: { session: Session | null; usdc: string | null; onDone: () => Promise<void> }) {
  const { signer } = useApp();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [iban, setIban] = useState(() => anchor.randomTestIban());
  const debounced = useDebounced(amount);
  const [quote, setQuote] = useState<anchor.Quote | null>(null);
  const [status, setStatus] = useState<anchor.AnchorTx | null>(null);
  const kycIban = useRef<string | null>(null);

  useEffect(() => {
    if (!session || !(Number(debounced) > 0)) return setQuote(null);
    anchor
      .price(session.info, anchor.USDC_ASSET, anchor.TRY_ASSET, debounced)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [session, debounced]);

  const ibanOk = anchor.isValidTrIban(iban);
  const tooMuch = usdc != null && Number(amount) > Number(usdc);

  const go = async () => {
    if (!session || !signer) return;
    try {
      setStatus(null);
      const clean = iban.replace(/\s+/g, "").toUpperCase();
      if (kycIban.current !== clean) {
        await anchor.ensureKyc(session.info, session.token, signer.address, { bank_account_number: clean });
        kycIban.current = clean;
      }
      const { id, hash } = await anchor.withdraw(session.info, session.token, signer, amount);
      toast("info", "USDC anchor'a gönderildi, TL ödemesi bekleniyor", hash);
      await onDone();
      const t = await anchor.pollTx(session.info, session.token, id, setStatus);
      if (t.status === "completed") {
        toast("ok", `₺${t.amount_out} IBAN'ına gönderildi`);
        setAmount("");
        await onDone();
      } else toast("err", `Anchor işlemi: ${t.status} ${t.message ?? ""}`);
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>
        3 · USDC → TL olarak IBAN'a çek <span className="sep-tag">SEP-38</span>
        <span className="sep-tag">SEP-6</span>
      </h3>
      <p className="small muted" style={{ margin: 0 }}>
        Çalışan, kontrattan gelen payını TL'ye çevirip banka hesabına çeker.
      </p>
      <label className="field">
        Tutar (USDC)
        <span className="row" style={{ flexWrap: "nowrap" }}>
          <input
            style={{ flex: 1 }}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(",", "."))}
            disabled={!session}
            placeholder="0.00"
          />
          <button className="btn secondary sm" disabled={!session || !usdc} onClick={() => setAmount(Number(usdc).toFixed(7).replace(/\.?0+$/, ""))}>
            Tümü
          </button>
        </span>
        {tooMuch && <span className="small" style={{ color: "var(--err)" }}>Bakiyen {Number(usdc).toFixed(2)} USDC</span>}
      </label>
      <label className="field">
        IBAN
        <input className="mono" value={iban} onChange={(e) => setIban(e.target.value)} disabled={!session} />
        {!ibanOk && <span className="small" style={{ color: "var(--err)" }}>Geçerli bir TR IBAN gir</span>}
      </label>
      {quote && (
        <dl className="kv">
          <dt>Hesabına geçecek</dt>
          <dd>₺{Number(quote.buy_amount).toLocaleString("tr-TR", { minimumFractionDigits: 2 })}</dd>
          <dt>Ücret</dt>
          <dd>{Number(quote.fee?.total ?? 0).toFixed(4)} USDC</dd>
        </dl>
      )}
      <div className="row">
        <AsyncButton disabled={!session || !(Number(amount) > 0) || !ibanOk || tooMuch} onClick={go}>
          TL olarak çek
        </AsyncButton>
        {status && <span className="badge primary">{status.status}</span>}
      </div>
    </section>
  );
}

function History({ session, version }: { session: Session; version: number }) {
  const [txs, setTxs] = useState<anchor.AnchorTx[] | null>(null);
  const load = () => anchor.listTxs(session.info, session.token).then(setTxs).catch(() => setTxs([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, version]);

  return (
    <section className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>Anchor işlem geçmişi</h3>
        <div className="spacer" />
        <AsyncButton className="btn secondary sm" onClick={load}>
          Yenile
        </AsyncButton>
      </div>
      {!txs?.length ? (
        <div className="empty small">Henüz işlem yok.</div>
      ) : (
        <div className="table-wrap">
          <table className="tx">
            <thead>
              <tr>
                <th>Tür</th>
                <th>Durum</th>
                <th>Giren</th>
                <th>Çıkan</th>
                <th>Zaman</th>
                <th>Stellar tx</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td>{t.kind.startsWith("deposit") ? "TL → USDC" : "USDC → TL"}</td>
                  <td>
                    <span className={`badge ${t.status === "completed" ? "ok" : t.status === "error" ? "err" : "warn"}`}>{t.status}</span>
                  </td>
                  <td>{t.amount_in ?? "—"}</td>
                  <td>{t.amount_out ?? "—"}</td>
                  <td>{t.started_at ? new Date(t.started_at).toLocaleString("tr-TR") : "—"}</td>
                  <td>
                    {t.stellar_transaction_id ? (
                      <a href={expertTx(t.stellar_transaction_id)} target="_blank" rel="noreferrer" className="mono">
                        {t.stellar_transaction_id.slice(0, 8)}… ↗
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
