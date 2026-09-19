import { useCallback, useEffect, useRef, useState } from "react";
import { twViewer } from "../lib/config.ts";
import { useApp } from "../app-context.tsx";
import { commitReading, decodeQr, distanceM, encodeQr, loadCodes, makeCodes, saveCodes, saveReading, TRANCHE_LABELS, TRANCHE_SHORT } from "../lib/codes.ts";
import {
  acceptJob,
  ALERT_LEFT_AREA,
  ALERT_REPORTED_ABSENT,
  arbiterRelease,
  claimTranche,
  completeJob,
  confirmPresence,
  continueClose,
  depositJob,
  friendlyError,
  fromE6,
  fromUnits,
  getEscrow,
  JobStatus,
  listJobs,
  netOfTwFee,
  releaseJob,
  resolveToClient,
  shareOf,
  STATUS_LABEL,
  submitLocation,
  trancheTarget,
  type Job,
  type Stakeholder,
  type TwEscrow,
} from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { trancheReleasedAt } from "../lib/events.ts";
import type { Signer } from "../lib/signer.ts";
import { Modal, QrImage, QrScanner } from "./Qr.tsx";
import { AsyncButton, useToast } from "./ui.tsx";

// Kod 2: kapora (Kod 1) serbest kaldıktan sonra işverene ne sıklıkla ve ne kadar süre hatırlatma yapılır.
const KOD2_REMINDER_EVERY_S = 2 * 60;
const KOD2_TIMEOUT_S = 15 * 60;
// Saha QR'ının (Kod 1 / gün sonu) ekranda görsel olarak açık kaldığı süre; doldurunca işveren tek
// tıkla yeniden gösterebilir. Tek kullanımlık garantisi zaten zincirdeki `released` bit maskesinde.
const QR_DISPLAY_TTL_S = 5 * 60;

/** `at` bir zaman damgasına ulaşınca saniyede bir yeniden render tetikler; yoksa null döner. */
function useElapsedSeconds(at: Date | null | undefined) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!at) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [at]);
  return at ? Math.floor((Date.now() - at.getTime()) / 1000) : null;
}

/** Bir dilimin zincirde ne zaman serbest bırakıldığını okur (event log'undan); bulunamazsa null. */
function useTrancheTimestamp(jobId: bigint, worker: string, tranche: number, enabled: boolean) {
  const [at, setAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    trancheReleasedAt(jobId, worker, tranche).then((d) => {
      if (!cancelled) setAt(d);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, worker, tranche, enabled]);
  return enabled ? at : null;
}

export function Jobs() {
  const { signer, jobsVersion, goTo } = useApp();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [onlyMine, setOnlyMine] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await listJobs());
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load, jobsVersion]);

  const involved = (j: Job) =>
    !!signer &&
    (j.terms.client === signer.address ||
      j.contractor === signer.address ||
      j.terms.arbiter === signer.address ||
      j.stakeholders.some((s) => s.address === signer.address));

  const visible = (jobs ?? []).filter((j) => !onlyMine || involved(j));

  return (
    <div className="stack">
      <div className="hero">
        <span className="eyebrow">Emeğin, kodla güvence altında</span>
        <h1>Para aracıda değil, escrow'da.</h1>
      </div>
      <div className="steps4">
        <div className="step4">
          <span className="tag">KOD 1</span>
          <span className="title">Varış</span>
          <span className="desc">Çalışan işverenin kodunu okutur, kapora anında yatar.</span>
        </div>
        <div className="step4">
          <span className="tag">KOD 2</span>
          <span className="title">Devam kontrolü</span>
          <span className="desc">İşveren "hâlâ burada" der, mesai payı ödenir.</span>
        </div>
        <div className="step4 final">
          <span className="tag">QR</span>
          <span className="title">Gün sonu</span>
          <span className="desc">Son QR okutulur, payın tamamı çalışanda.</span>
        </div>
        <div className="step4 dark">
          <span className="tag">KONUM</span>
          <span className="title">Sahada takip</span>
          <span className="desc">Alandan çıkılırsa işverene bildirim gider.</span>
        </div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <span className="section-title">İşler</span>
        <label className="row small muted" style={{ gap: 6, marginLeft: 8 }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          yalnızca benimkiler
        </label>
        <div className="spacer" />
        <AsyncButton className="btn ghost sm" onClick={load}>
          ↻ Yenile
        </AsyncButton>
        <button className="btn sm" onClick={() => goTo("create")}>
          + Yeni iş
        </button>
      </div>

      {error && (
        <div className="callout err">
          Kontrat okunamadı: {error}{" "}
          <button className="btn ghost sm" onClick={load}>
            Tekrar dene
          </button>
        </div>
      )}
      {jobs === null && !error && <div className="empty">İşler zincirden okunuyor…</div>}
      {jobs && visible.length === 0 && (
        <div className="card empty">
          {onlyMine ? "Bu hesabın dahil olduğu bir iş yok." : "Henüz iş oluşturulmamış."}{" "}
          <button className="btn ghost" onClick={() => goTo("create")}>
            İhaleci olarak iş oluştur →
          </button>
        </div>
      )}
      <div className="grid">
        {visible.map((j) => (
          <JobCard key={String(j.id)} job={j} onChange={load} />
        ))}
      </div>
    </div>
  );
}

// Bu sekmede otomatik devam eden kapanışlar (parça parça continue_close)
const closingHere = new Set<string>();

const STEPS = ["İş tanımlandı", "Çalışan onayları", "Escrow · iş sürüyor", "Kapandı"];
const isReleased = (s: Stakeholder, t: number) => (s.released & (1 << t)) !== 0;
const isDisputed = (s: Stakeholder, t: number) => (s.disputed & (1 << t)) !== 0;

function useRun(onChange: () => Promise<void>) {
  const toast = useToast();
  const { refreshBalances } = useApp();
  return async (label: string, fn: () => Promise<{ hash?: string }>) => {
    try {
      const { hash } = await fn();
      toast("ok", label, hash);
      await Promise.all([onChange(), refreshBalances()]);
      return true;
    } catch (e) {
      toast("err", friendlyError(e));
      return false;
    }
  };
}

function JobCard({ job, onChange }: { job: Job; onChange: () => Promise<void> }) {
  const { signer, nameOf, tryPerUsdc, balances, goTo } = useApp();
  const run = useRun(onChange);
  const t = job.terms;
  const me = signer?.address;
  const isClient = me === t.client;
  const isContractor = me === job.contractor;
  const isArbiter = me === t.arbiter;
  const myStake = job.stakeholders.find((s) => s.address === me);
  const isWorker = !!myStake && !isContractor;
  const deadline = new Date(Number(t.deadline) * 1000);
  const deadlinePassed = Date.now() >= deadline.getTime();
  const total = fromUnits(t.total_amount);
  const accepted = job.stakeholders.filter((s) => s.accepted).length;
  const venue = { lat: fromE6(t.venue_lat_e6), lng: fromE6(t.venue_lng_e6) };

  const currentStep =
    job.status === JobStatus.PendingApproval ? 1 : job.status === JobStatus.Approved ? 2 : job.status === JobStatus.Funded ? 3 : 4;

  const clientUsdc = isClient && balances?.usdc != null ? Number(balances.usdc) : null;
  const insufficient = clientUsdc !== null && clientUsdc < Number(fromUnits(t.total_amount, 7));

  const lock = async () => {
    if (!signer) return;
    const { codes, commitments } = await makeCodes(job.stakeholders.length);
    saveCodes(job.id, codes); // kodlar tx'ten önce kaydedilir ki kaybolmasın
    await run(`${total} USDC kilitlendi, saha QR kodları hazır`, () => depositJob(signer, job.id, commitments));
  };

  return (
    <article className={`card job s${job.status}`}>
      <div className="job-head">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <span className="job-id">#{String(job.id)}</span>
            <span
              className={`badge ${
                job.status === JobStatus.Completed ? "ok" : job.status === JobStatus.Refunded ? "err" : job.status === JobStatus.Funded ? "primary" : "warn"
              }`}
            >
              {STATUS_LABEL[job.status]}
            </span>
            <span className="small muted">
              {isClient ? "işverensin" : isContractor ? "ihalecisin" : isWorker ? "çalışansın" : isArbiter ? "hakemsin" : ""}
            </span>
          </div>
          <div className="job-amount">
            {total}
            <small>USDC</small>
          </div>
          {tryPerUsdc && <div className="small muted">≈ ₺{(Number(total) * tryPerUsdc).toLocaleString("tr-TR", { maximumFractionDigits: 0 })}</div>}
        </div>
        <div className="job-side">
          <span className="k">İşveren</span>
          <span className="v">{nameOf(t.client)}</span>
          <span className="k" style={{ marginTop: 6 }}>
            Son tarih
          </span>
          <span className="v" style={{ color: deadlinePassed && job.status === JobStatus.Funded ? "var(--warn)" : undefined }}>
            {deadline.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </div>
      </div>

      <div className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
        Kapora %{t.arrival_bps / 100} · Kod 2 ile %{t.mid_bps / 100} · Hakem {nameOf(t.arbiter)} ·{" "}
        <a href={`https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=17/${venue.lat}/${venue.lng}`} target="_blank" rel="noreferrer">
          konum ({t.radius_m} m)
        </a>{" "}
        ·{" "}
        <span title="Para Ek İşler'de değil; her paydaşın payı kendi Trustless Work escrow'unda duruyor">
          her paydaşın ayrı Trustless Work escrow'u
        </span>
      </div>

      {job.status !== JobStatus.Refunded && (
        <div className="stepper">
          {STEPS.map((s, i) => (
            <div key={s} className={`step ${i < currentStep ? "done" : i === currentStep ? "current" : ""}`}>
              <div className="bar" />
              {s}
              {i === 1 && ` (${accepted}/${job.stakeholders.length})`}
            </div>
          ))}
        </div>
      )}

      <div className="stake-list">
        {job.stakeholders.map((s) => {
          const contractorRow = s.address === job.contractor;
          return (
            <div key={s.address} className={`stake ${s.address === me ? "me" : ""}`}>
              <div>
                <div className="who">
                  {nameOf(s.address)}
                  {contractorRow && <span className="muted small" style={{ fontWeight: 500 }}> · ihaleci</span>}
                  <a className="small" style={{ fontWeight: 500, marginLeft: 8 }} href={twViewer(s.escrow)} target="_blank" rel="noreferrer" title="Bu paydaşın Trustless Work escrow'u">
                    escrow ↗
                  </a>
                </div>
                <div className="paybar" aria-label={`Ödenen ${fromUnits(s.paid)} / ${fromUnits(shareOf(job, s))} USDC`}>
                  <span style={{ width: `${Math.min(100, Number((s.paid * 100n) / (shareOf(job, s) || 1n)))}%` }} />
                </div>
              </div>
              <div className="small muted" style={{ textAlign: "right" }}>
                {!contractorRow &&
                  TRANCHE_SHORT.map((l, i) => (
                    <span
                      key={l}
                      title={isDisputed(s, i) ? `${TRANCHE_LABELS[i]}: Trustless Work'te hakemde` : TRANCHE_LABELS[i]}
                      style={{
                        marginLeft: 10,
                        color: isReleased(s, i) ? "var(--ok)" : isDisputed(s, i) ? "var(--err)" : undefined,
                        fontWeight: isReleased(s, i) || isDisputed(s, i) ? 700 : 400,
                      }}
                    >
                      {isReleased(s, i) ? "✓" : isDisputed(s, i) ? "⚖" : "○"} {l}
                    </span>
                  ))}
                {contractorRow && isDisputed(s, 0) && <span style={{ color: "var(--err)", fontWeight: 700 }}>⚖ hakemde</span>}
              </div>
              <div style={{ textAlign: "right", minWidth: 120 }}>
                <div style={{ fontWeight: 700 }}>
                  {fromUnits(s.paid)} <span className="muted small">/ {fromUnits(shareOf(job, s))}</span>
                </div>
                <div className="small muted">
                  %{(s.share_bps / 100).toLocaleString("tr-TR")} pay{!s.accepted && <span style={{ color: "var(--warn)" }}> · onay bekliyor</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="job-actions">
        {signer && job.status === JobStatus.PendingApproval && myStake && !myStake.accepted && (
          <AsyncButton
            className="btn ok"
            onClick={() =>
              run("Şartları onayladın. Artık oran değiştirilemez.", async () => {
                await ensureReady(signer); // ödemeyi alabilmek için USDC trustline
                return acceptJob(signer, job.id);
              })
            }
          >
            Payımı ve şartları onayla · %{myStake.share_bps / 100}
          </AsyncButton>
        )}
        {job.status === JobStatus.PendingApproval && isClient && (
          <div className="callout">Tüm çalışanlar payını onaylayınca parayı kilitleyebileceksin. Böylece gizli oran değişikliği yapılamaz.</div>
        )}

        {signer && job.status === JobStatus.Approved && isClient && (
          <>
            <AsyncButton className="btn" disabled={insufficient} onClick={lock}>
              Parayı kilitle ve saha QR kodlarını oluştur · {total} USDC
            </AsyncButton>
            {insufficient && (
              <div className="callout warn">
                USDC bakiyen yetersiz ({clientUsdc?.toFixed(2)}).{" "}
                <button className="btn ghost sm" onClick={() => goTo("ramp")}>
                  TL havalesiyle yükle →
                </button>
              </div>
            )}
          </>
        )}
        {job.status === JobStatus.Approved && !isClient && <div className="callout">Tüm paylar onaylandı. İşverenin parayı kilitlemesi bekleniyor.</div>}
      </div>

      {signer && job.status === JobStatus.Funded && isClient && <ClientCodes job={job} signer={signer} run={run} />}
      {signer && job.status === JobStatus.Funded && isWorker && myStake && (
        <WorkerPanel job={job} me={myStake} signer={signer} run={run} venue={venue} />
      )}
      {signer && job.status === JobStatus.Funded && isArbiter && <ArbiterPanel job={job} signer={signer} run={run} venue={venue} />}
      {signer && isArbiter && job.stakeholders.some((s) => s.disputed !== 0) && <DisputePanel job={job} signer={signer} run={run} />}

      <div className="job-actions">
        {signer && job.status === JobStatus.Funded && isClient && (
          <AsyncButton
            className="btn ok"
            onClick={async () => {
              closingHere.add(String(job.id));
              try {
                await run("İş kapandı, kalan paylar dağıtıldı", () => completeJob(signer, job.id));
              } finally {
                closingHere.delete(String(job.id));
              }
            }}
          >
            İşi kapat · kalan ödemeleri dağıt
          </AsyncButton>
        )}
        {job.status === JobStatus.Closing && closingHere.has(String(job.id)) && (
          <div className="callout row" role="status">
            <span className="spinner" /> Trustless Work milestone'ları parça parça serbest bırakılıyor…
          </div>
        )}
        {signer && job.status === JobStatus.Closing && !closingHere.has(String(job.id)) && (
          <AsyncButton className="btn" onClick={() => run("Kapanış tamamlandı", () => continueClose(signer, job.id))}>
            Kapanışa devam et
          </AsyncButton>
        )}
        {signer && job.status === JobStatus.Funded && deadlinePassed && (
          <AsyncButton
            className="btn secondary"
            onClick={async () => {
              closingHere.add(String(job.id));
              try {
                await run("Son tarih geçti, ödemeler dağıtıldı", () => releaseJob(signer, job.id));
              } finally {
                closingHere.delete(String(job.id));
              }
            }}
          >
            Son tarih doldu · dağıtımı başlat
          </AsyncButton>
        )}
        {job.status === JobStatus.Funded && !isClient && !deadlinePassed && (
          <div className="callout small">
            İşveren kapatmazsa {deadline.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} sonrasında herkes dağıtımı
            başlatabilir: işe gelen (kaporası açılmış) çalışanlar kalan paylarını alır, hiç gelmeyenlerin payı hakem kararıyla işverene döner.
          </div>
        )}
        {job.status === JobStatus.Completed && myStake && (
          <div className="callout ok">
            Toplam {fromUnits(netOfTwFee(myStake.paid))} USDC hesabına geçti (Trustless Work %0,3 protokol ücreti düşülerek).{" "}
            <button className="btn ghost sm" onClick={() => goTo("ramp")}>
              TL olarak IBAN'a çek →
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

const hhmm = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const lastAlert = (job: Job, worker: string, kind: number) =>
  [...job.alerts].reverse().find((a) => a.worker === worker && a.kind === kind);

/** İşveren saha paneli: Kod 1 (varış QR'ı), Kod 2 (hâlâ burada mı?), gün sonu QR'ı ve alan dışı bildirimleri */
function ClientCodes({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const codes = loadCodes(job.id);
  const [open, setOpen] = useState<{ idx: number; tranche: number } | null>(null);
  const workers = job.stakeholders.map((s, idx) => ({ s, idx })).filter(({ s }) => s.address !== job.contractor);
  const openItem = open && workers.find((w) => w.idx === open.idx);

  return (
    <div className="panel">
      <div className="panel-title">📱 Saha kontrolü · her adım çalışana anında ödeme açar</div>
      {!codes && (
        <div className="callout warn small">
          Kod 1 ve gün sonu QR'ı parayı kilitleyen cihazda üretildi, bu cihazda yok. Kod 2 onayı ve işi kapatma yine çalışır.
        </div>
      )}
      {workers.map(({ s, idx }) => {
        const left = lastAlert(job, s.address, ALERT_LEFT_AREA);
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn secondary sm" disabled={!codes || isReleased(s, 0)} onClick={() => setOpen({ idx, tranche: 0 })}>
                  {isReleased(s, 0) ? "✓ Kod 1" : "Kod 1 · Varış QR"}
                </button>
                <button className="btn secondary sm" disabled={!codes || isReleased(s, 2)} onClick={() => setOpen({ idx, tranche: 2 })}>
                  {isReleased(s, 2) ? "✓ Gün sonu" : "Gün sonu QR"}
                </button>
              </span>
            </div>
            {isReleased(s, 0) && !isReleased(s, 1) && (
              <div className="row small">
                <span>
                  <b>Kod 2</b> · {nameOf(s.address)} hâlâ iş yerinde mi?
                </span>
                <AsyncButton
                  className="btn ok sm"
                  onClick={() => run("Kod 2 onaylandı, mesai ödemesi gönderildi", () => confirmPresence(signer, job.id, s.address, true))}
                >
                  Evet, burada
                </AsyncButton>
                <AsyncButton
                  className="btn secondary sm"
                  onClick={() =>
                    run("Çalışana \"iş yerinde değil\" bildirimi gönderildi", () => confirmPresence(signer, job.id, s.address, false))
                  }
                >
                  Hayır, burada değil
                </AsyncButton>
              </div>
            )}
            {isReleased(s, 0) && !isReleased(s, 1) && <Kod2Waiting job={job} worker={s.address} workerName={nameOf(s.address)} />}
            {isReleased(s, 1) && <span className="small muted">✓ Kod 2 onaylandı</span>}
            {left && !isReleased(s, 2) && (
              <div className="callout warn small" role="alert">
                ⚠️ {hhmm(left.timestamp)} · {nameOf(s.address)} etkinlik alanından çıktı (etkinliğe {left.distance_m} m)
              </div>
            )}
          </div>
        );
      })}
      {open && openItem && codes && (
        <Modal title={`${TRANCHE_LABELS[open.tranche]} · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <ExpiringQr text={encodeQr({ jobId: job.id, tranche: open.tranche, worker: openItem.s.address, code: codes[open.idx * 3 + open.tranche] })} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            Okutulunca çalışanın ödenen tutarı {fromUnits(trancheTarget(job, openItem.s, open.tranche))} USDC'ye çıkar.
            <br />
            Bu kodu sadece çalışan yanındayken göster.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** İşverene Kod 2 için hatırlatma: 2 dk'da bir toast, 15 dk sonunda "cevapsız" rozeti. */
function Kod2Waiting({ job, worker, workerName }: { job: Job; worker: string; workerName: string }) {
  const toast = useToast();
  const at = useTrancheTimestamp(job.id, worker, 0, true);
  const elapsed = useElapsedSeconds(at);
  const lastTick = useRef(0);

  useEffect(() => {
    if (elapsed == null || elapsed >= KOD2_TIMEOUT_S) return;
    const tick = Math.floor(elapsed / KOD2_REMINDER_EVERY_S);
    if (tick > lastTick.current) {
      lastTick.current = tick;
      if (tick > 0) toast("info", `Hatırlatma: ${workerName} hâlâ iş yerinde mi? Kod 2'yi onayla.`);
    }
  }, [elapsed, toast, workerName]);

  if (elapsed == null) return null;
  if (elapsed >= KOD2_TIMEOUT_S) {
    return <span className="badge warn">Kod 2 · 15 dk cevapsız, çalışana bildirildi</span>;
  }
  const remaining = KOD2_TIMEOUT_S - elapsed;
  return (
    <span className="small muted">
      Kod 2 bekleniyor · {Math.ceil(remaining / 60)} dk içinde cevapsız kalırsa çalışana bilgi verilecek
    </span>
  );
}

/** Kod 1 ve gün sonu QR'ı: 5 dk görsel geçerlilik, dolunca işveren tek tıkla yeniden gösterir.
 * Tek kullanımlık garantisi zincirdeki `released` bit maskesinde; bu sadece ekranda açık kalma süresi. */
function ExpiringQr({ text }: { text: string }) {
  const [expiresAt, setExpiresAt] = useState(() => Date.now() + QR_DISPLAY_TTL_S * 1000);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));

  if (remaining <= 0) {
    return (
      <div className="callout warn" style={{ textAlign: "center" }}>
        QR'ın 5 dakikalık gösterim süresi doldu. Çalışan bu sürede okutamadıysa sorun değil, tekrar gösterebilirsin.
        <div style={{ marginTop: 8 }}>
          <button className="btn secondary sm" onClick={() => setExpiresAt(Date.now() + QR_DISPLAY_TTL_S * 1000)}>
            Yeniden göster · 5 dk
          </button>
        </div>
      </div>
    );
  }
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <div className="stack" style={{ alignItems: "center", gap: 8 }}>
      <QrImage text={text} />
      <span className="badge">Kalan süre {mm}:{ss}</span>
    </div>
  );
}

/** Kod 1'den gün sonu QR'ına kadar konum takibi: cihazda yapılır, yalnızca alandan çıkış zincire yazılır */
function LocationTracker({
  job,
  me,
  signer,
  run,
  venue,
}: {
  job: Job;
  me: Stakeholder;
  signer: Signer;
  run: ReturnType<typeof useRun>;
  venue: { lat: number; lng: number };
}) {
  const toast = useToast();
  const [on, setOn] = useState(false);
  const [dist, setDist] = useState<number | null>(null);
  const inside = useRef<boolean | null>(null);
  const radius = job.terms.radius_m;

  const report = useCallback(
    (d: number, lat: number, lng: number) =>
      run(`Alandan çıkış işverene bildirildi (${d} m)`, async () => {
        const { reading, hash } = await commitReading({ lat, lng, at: Date.now() });
        saveReading(job.id, me.address, reading);
        return submitLocation(signer, job.id, d, hash);
      }),
    [run, job.id, me.address, signer],
  );

  useEffect(() => {
    if (!on) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const d = Math.round(distanceM(p.coords.latitude, p.coords.longitude, venue.lat, venue.lng));
        setDist(d);
        const nowInside = d <= radius;
        if (inside.current !== false && !nowInside) report(d, p.coords.latitude, p.coords.longitude);
        inside.current = nowInside;
      },
      (e) => {
        toast("err", friendlyError(new Error(e.message || "geolocation")));
        setOn(false);
      },
      { enableHighAccuracy: true, maximumAge: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [on, venue.lat, venue.lng, radius, report, toast]);

  return (
    <>
      <div className="panel-title" style={{ marginTop: 8 }}>
        📍 Konum takibi (Kod 1'den gün sonu QR'ına kadar)
      </div>
      <div className="small muted">
        Konumun yalnızca bu cihazda izlenir. Etkinlik alanından ({radius} m) çıkarsan sadece mesafe bilgisi zincire yazılır ve işverene
        bildirim gider; ham koordinatların hiçbir yere gönderilmez.
      </div>
      <div className="row">
        <button className={on ? "btn secondary sm" : "btn sm"} onClick={() => setOn(!on)}>
          {on ? "Takibi durdur" : "Konum takibini başlat"}
        </button>
        {on && dist !== null && (
          <span className={`badge ${dist <= radius ? "ok" : "warn"}`}>
            Etkinliğe {dist} m {dist <= radius ? "· alan içinde" : "· alan dışında"}
          </span>
        )}
        <AsyncButton
          className="btn ghost sm"
          title="Demo: etkinlik noktasından ~650 m uzaklaşmış gibi davran"
          onClick={() => report(650, venue.lat + 0.0058, venue.lng)}
        >
          Demo: alandan çık
        </AsyncButton>
      </div>
    </>
  );
}

function WorkerPanel({
  job,
  me,
  signer,
  run,
  venue,
}: {
  job: Job;
  me: Stakeholder;
  signer: Signer;
  run: ReturnType<typeof useRun>;
  venue: { lat: number; lng: number };
}) {
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [pos, setPos] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const next = [0, 1, 2].find((t) => !isReleased(me, t));
  const idx = job.stakeholders.findIndex((s) => s.address === me.address);
  const demoCodes = loadCodes(job.id); // yalnızca aynı tarayıcıda işveren rolü de oynanıyorsa (demo)
  const myProofs = job.locations.filter((l) => l.worker === me.address);
  const absent = lastAlert(job, me.address, ALERT_REPORTED_ABSENT);
  // Kod 2 işverenin onayıdır; çalışan sıradaki okutulabilir kodu (Kod 1 ya da gün sonu QR'ı) okutur
  const scannable = next === 0 ? 0 : 2;

  const applyCode = async (text: string) => {
    const p = decodeQr(text);
    if (!p) return toast("err", "Bu bir Ek İşler ödeme QR'ı değil");
    if (p.jobId !== job.id) return toast("err", `Bu QR başka bir işe ait (#${p.jobId})`);
    if (p.worker !== me.address) return toast("err", "Bu QR başka bir çalışan için üretilmiş");
    setScanning(false);
    setProcessing(TRANCHE_LABELS[p.tranche]);
    try {
      await run(`${TRANCHE_LABELS[p.tranche]} ödemesi hesabına geçti`, () => claimTranche(signer, job.id, p.tranche, p.code));
    } finally {
      setProcessing(null);
    }
  };

  const locate = () =>
    new Promise<{ lat: number; lng: number; acc?: number }>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(new Error(e.message || "geolocation")),
        { enableHighAccuracy: true, timeout: 15_000 },
      ),
    );

  const dist = pos ? Math.round(distanceM(pos.lat, pos.lng, venue.lat, venue.lng)) : null;

  if (next === undefined) return <div className="callout ok" style={{ marginTop: 14 }}>Tüm dilimlerin ödendi.</div>;

  return (
    <div className="panel">
      {absent && !isReleased(me, 1) && (
        <div className="callout err small" role="alert">
          🔔 İşveren {hhmm(absent.timestamp)} itibarıyla iş yerinde olmadığını bildirdi. Oradaysan işverenle konuş ya da konum takibinle
          kanıt oluştur; hakem inceleyebilir.
        </div>
      )}
      <div className="panel-title">
        📷 Sıradaki ödeme: <b>{TRANCHE_LABELS[next]}</b> → toplam {fromUnits(trancheTarget(job, me, next))} USDC
      </div>
      {next === 1 && (
        <>
          <div className="small muted">Kod 2 işverenin "hâlâ burada" onayıyla açılır. Gün sonunda işverenin QR'ını okutarak kalan payını alırsın.</div>
          <Kod2TimeoutBanner job={job} worker={me.address} />
        </>
      )}
      {processing && (
        <div className="callout row" role="status">
          <span className="spinner" /> QR doğrulandı · {processing} ödemesi Trustless Work escrow'undan hesabına gönderiliyor…
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={!!processing} onClick={() => setScanning(true)}>
          {scannable === 0 ? "Kod 1'i okut (varış)" : "Gün sonu QR'ını okut"}
        </button>
        {demoCodes && (
          <AsyncButton
            className="btn secondary sm"
            title="Demo: işveren rolü aynı tarayıcıda oynandığı için kod bu cihazda duruyor"
            onClick={() => applyCode(encodeQr({ jobId: job.id, tranche: scannable, worker: me.address, code: demoCodes[idx * 3 + scannable] }))}
          >
            Demo: işverenin ekranındaki {scannable === 0 ? "Kod 1" : "gün sonu QR'ı"}
          </AsyncButton>
        )}
      </div>

      {isReleased(me, 0) && <LocationTracker job={job} me={me} signer={signer} run={run} venue={venue} />}
      {!isReleased(me, 0) && (
      <>
      <div className="panel-title" style={{ marginTop: 8 }}>
        📍 İşveren Kod 1'i vermiyor mu? Konumunu kanıt olarak kaydet, hakem kaporayı serbest bıraksın.
      </div>
      <div className="row">
        <AsyncButton
          className="btn secondary sm"
          onClick={async () => {
            try {
              setPos(await locate());
            } catch (e) {
              toast("err", friendlyError(e));
            }
          }}
        >
          Konumumu al
        </AsyncButton>
        <button
          className="btn ghost sm"
          title="Demo: sahnede konum izni olmayabilir; etkinlik noktasına ~40 m mesafede bir konum kullanılır"
          onClick={() => setPos({ lat: venue.lat + 0.0003, lng: venue.lng + 0.0002 })}
        >
          Demo: etkinlik alanındayım
        </button>
        {pos && (
          <>
            <span className={`badge ${dist! <= job.terms.radius_m ? "ok" : "warn"}`}>
              Etkinliğe {dist} m {dist! <= job.terms.radius_m ? "· alan içinde" : "· alan dışında"}
            </span>
            <AsyncButton
              className="btn sm"
              title="Zincire yalnızca mesafe ve ölçümün hash'i yazılır; ham koordinat bu cihazda kalır"
              onClick={() =>
                run("Konum kanıtı kaydedildi (zincirde yalnızca mesafe ve hash)", async () => {
                  const { reading, hash } = await commitReading({ lat: pos.lat, lng: pos.lng, at: Date.now() });
                  saveReading(job.id, me.address, reading);
                  return submitLocation(signer, job.id, dist!, hash);
                })
              }
            >
              Kanıt olarak gönder
            </AsyncButton>
          </>
        )}
      </div>
      {myProofs.length > 0 && (
        <div className="small muted">
          Zincirdeki konum kanıtların: {myProofs.length} · son:{" "}
          {new Date(Number(myProofs[myProofs.length - 1].timestamp) * 1000).toLocaleTimeString("tr-TR")}
        </div>
      )}
      </>
      )}

      {scanning && (
        <Modal title={`${TRANCHE_LABELS[scannable]} okut`} onClose={() => setScanning(false)}>
          <QrScanner onResult={applyCode} />
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input style={{ flex: 1 }} placeholder="veya QR içeriğini yapıştır (EKISLER:…)" value={manual} onChange={(e) => setManual(e.target.value)} />
            <AsyncButton className="btn sm" disabled={!manual} onClick={() => applyCode(manual)}>
              Gönder
            </AsyncButton>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** İşveren Kod 2'ye 15 dk içinde cevap vermezse çalışana bilgi verir (bkz. Kod2Waiting, işveren tarafı). */
function Kod2TimeoutBanner({ job, worker }: { job: Job; worker: string }) {
  const at = useTrancheTimestamp(job.id, worker, 0, true);
  const elapsed = useElapsedSeconds(at);
  if (elapsed == null || elapsed < KOD2_TIMEOUT_S) return null;
  return (
    <div className="callout warn small" role="alert">
      🔔 İşvereniniz Kod 2'ye 15 dakikadır cevap vermedi. Hâlâ sahadaysanız işvereninizle iletişime geçebilirsiniz.
    </div>
  );
}

function ArbiterPanel({
  job,
  signer,
  run,
  venue,
}: {
  job: Job;
  signer: Signer;
  run: ReturnType<typeof useRun>;
  venue: { lat: number; lng: number };
}) {
  const { nameOf } = useApp();
  const workers = job.stakeholders.filter((s) => s.address !== job.contractor);
  return (
    <div className="panel">
      <div className="panel-title">⚖️ Hakem paneli · konum kanıtlarını incele</div>
      {job.locations.length === 0 && <div className="small muted">Henüz konum kanıtı gönderilmedi.</div>}
      {workers.map((s) => {
        const proofs = job.locations.filter((l) => l.worker === s.address);
        if (!proofs.length) return null;
        const last = proofs[proofs.length - 1];
        const d = last.distance_m;
        const inside = d <= job.terms.radius_m;
        const next = [0, 1].find((t) => !isReleased(s, t));
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className={`badge ${inside ? "ok" : "err"}`}>
                {d} m · {inside ? "etkinlik alanında" : "alan dışında"}
              </span>
            </div>
            <div className="small muted">
              {proofs.length} kanıt · son {new Date(Number(last.timestamp) * 1000).toLocaleString("tr-TR")} · ham koordinat zincirde yok, gerekirse
              çalışandan istenip hash'le doğrulanır
            </div>
            {next !== undefined ? (
              <div className="row">
                <AsyncButton
                  className="btn sm"
                  onClick={() => run(`${TRANCHE_LABELS[next]} dilimi hakem kararıyla ödendi`, () => arbiterRelease(signer, job.id, s.address, next))}
                >
                  {TRANCHE_LABELS[next]} dilimini serbest bırak · {fromUnits(trancheTarget(job, s, next) - s.paid)} USDC
                </AsyncButton>
              </div>
            ) : (
              <span className="badge ok">Kapora ve mesai ödendi</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Hakem: Trustless Work'te dispute'a alınmış milestone'ları (ör. hiç gelmeyen çalışan) işverene iade eder */
function DisputePanel({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const escrows = job.stakeholders.filter((s) => s.disputed !== 0).map((s) => s.escrow);
  const key = escrows.join(",");
  const [data, setData] = useState<{ escrow: string; e: TwEscrow }[] | null>(null);
  const load = useCallback(
    () =>
      Promise.all(key.split(",").filter(Boolean).map(async (escrow) => ({ escrow, e: await getEscrow(escrow) })))
        .then(setData)
        .catch(() => setData(null)),
    [key],
  );
  useEffect(() => {
    load();
  }, [load, job]);

  const open = (data ?? []).flatMap(({ escrow, e }) =>
    e.milestones
      .map((m, index) => ({ escrow, m, index }))
      .filter(({ m }) => m.flags.disputed && !m.flags.resolved && !m.flags.released),
  );
  const label = (d: string) => ({ varis: "Kod 1 · Varış", mesai: "Kod 2 · Devam", bitis: "Gün sonu", ihaleci: "İhaleci payı" })[d] ?? d;
  const total = open.reduce((a, { m }) => a + m.amount, 0n);

  return (
    <div className="panel">
      <div className="panel-title">⚖️ Trustless Work dispute'ları · karar hakemde</div>
      {!data && <div className="small muted">Escrow'lar okunuyor…</div>}
      {data && open.length === 0 && <div className="small muted">Açık dispute yok, hepsi çözüldü.</div>}
      {open.length > 1 && (
        <AsyncButton
          className="btn"
          onClick={async () => {
            for (const { escrow, m, index } of open) {
              if (!(await run(`${label(m.description)} işverene iade edildi`, () => resolveToClient(signer, job, escrow, index, m.amount)))) break;
            }
            await load();
          }}
        >
          Tümünü işverene iade et · {fromUnits(total)} USDC
        </AsyncButton>
      )}
      {open.map(({ escrow, m, index }) => (
        <div key={`${escrow}-${index}`} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <b>{nameOf(m.receiver)}</b> · {label(m.description)} · {fromUnits(m.amount)} USDC
          </span>
          <AsyncButton
            className="btn sm"
            onClick={async () => {
              await run("Dispute çözüldü, tutar işverene iade edildi", () => resolveToClient(signer, job, escrow, index, m.amount));
              await load();
            }}
          >
            İşverene iade et
          </AsyncButton>
        </div>
      ))}
    </div>
  );
}
