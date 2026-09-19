import { Bell, Check, Circle, FileCode2, Gavel, MapPin, Plus, QrCode, RefreshCw, ScanLine, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONTRACT_ID, expertAccount, twViewer } from "../lib/config.ts";
import { useApp } from "../app-context.tsx";
import { requestCameraAccess } from "../lib/camera.ts";
import { commitReading, decodeQr, distanceM, encodeQr, loadCodes, makeCodes, saveCodes, saveReading, trancheLabel, trancheShort } from "../lib/codes.ts";
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
  statusLabel,
  submitLocation,
  trancheTarget,
  type Job,
  type Stakeholder,
  type TwEscrow,
} from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { invalidateActivity, jobActivity, trancheReleasedAt, type Activity } from "../lib/events.ts";
import { L, locale } from "../lib/i18n.ts";
import type { Signer } from "../lib/signer.ts";
import { Modal, QrImage, QrScanner } from "./Qr.tsx";
import { AsyncButton, ContractCallChip, useToast } from "./ui.tsx";

// Kod 2: kapora (Kod 1) serbest kaldıktan sonra işverene ne sıklıkla ve ne kadar süre hatırlatma yapılır.
const KOD2_REMINDER_EVERY_S = 2 * 60;
const KOD2_TIMEOUT_S = 15 * 60;
// Saha QR'ının (Kod 1 / gün sonu) ekranda görsel olarak açık kaldığı süre; doldurunca işveren tek
// tıkla yeniden gösterebilir. Tek kullanımlık garantisi zaten zincirdeki `released` bit maskesinde.
const QR_DISPLAY_TTL_S = 5 * 60;

const pct = (n: number) => L(`%${n.toLocaleString("tr-TR")}`, `${n}%`);

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

/** İşin zincirdeki adım kayıtları; iş değiştikçe (ödeme, onay, uyarı) yeniden okunur */
function useActivity(job: Job) {
  const sig = `${job.status}|${job.stakeholders.map((s) => `${s.accepted}${s.released}${s.disputed}`).join(",")}|${job.alerts.length}|${job.locations.length}`;
  const [list, setList] = useState<Activity[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    jobActivity(job.id).then((l) => !cancelled && setList(l));
    return () => {
      cancelled = true;
    };
  }, [job.id, sig]);
  return list;
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

  const steps: [string, string, string, string][] = [
    ["01", L("Kod 1 · Varış", "Code 1 · Arrival"), L("Çalışan işverenin kodunu okutur, kapora anında yatar.", "The worker scans the employer's code; the deposit is paid instantly."), ""],
    ["02", L("Kod 2 · Devam", "Code 2 · Still here"), L("İşveren \"hâlâ burada\" der, mesai payı ödenir.", "The employer confirms \"still here\"; the mid-shift share is paid."), ""],
    ["03", L("QR · Gün sonu", "QR · End of day"), L("Son QR okutulur, payın tamamı çalışanda.", "The final QR is scanned; the worker has the full share."), "final"],
    ["04", L("Konum", "Location"), L("Alandan çıkılırsa işverene bildirim gider.", "If a worker leaves the venue, the employer is notified."), "dark"],
  ];

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Stellar · Soroban · Trustless Work</span>
        <h1>{L("Para aracıda değil, escrow'da.", "The money sits in escrow, not with a middleman.")}</h1>
        <p>
          {L(
            "İşveren ödemeyi baştan kilitler. Çalışan sahadaki her adımı kodla kanıtladıkça payı Trustless Work escrow'undan doğrudan hesabına geçer.",
            "The employer locks the payment up front. Each time a worker proves a step on site with a code, their share moves from the Trustless Work escrow straight to their account.",
          )}
        </p>
      </section>
      <div className="steps4">
        {steps.map(([n, title, desc, cls]) => (
          <div key={n} className={`step4 ${cls}`}>
            <span className="tag">{n}</span>
            <span className="title">{title}</span>
            <span className="desc">{desc}</span>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 18 }}>
        <span className="section-title">{L("İşler", "Jobs")}</span>
        <label className="row small muted" style={{ gap: 6, marginLeft: 8 }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          {L("yalnızca benimkiler", "only mine")}
        </label>
        <div className="spacer" />
        <AsyncButton className="btn ghost sm" onClick={load}>
          <RefreshCw size={15} /> {L("Yenile", "Refresh")}
        </AsyncButton>
        <button className="btn sm" onClick={() => goTo("create")}>
          <Plus size={16} /> {L("Yeni iş", "New job")}
        </button>
      </div>

      {error && (
        <div className="callout err">
          {L("Kontrat okunamadı", "Could not read the contract")}: {error}{" "}
          <button className="btn ghost sm" onClick={load}>
            {L("Tekrar dene", "Try again")}
          </button>
        </div>
      )}
      {jobs === null && !error && <div className="empty">{L("İşler zincirden okunuyor…", "Reading jobs from the chain…")}</div>}
      {jobs && visible.length === 0 && (
        <div className="card empty">
          {onlyMine ? L("Bu hesabın dahil olduğu bir iş yok.", "This account is not part of any job.") : L("Henüz iş oluşturulmamış.", "No jobs yet.")}{" "}
          <button className="btn ghost" onClick={() => goTo("create")}>
            {L("İhaleci olarak iş oluştur →", "Create a job as the contractor →")}
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

const isReleased = (s: Stakeholder, t: number) => (s.released & (1 << t)) !== 0;
const isDisputed = (s: Stakeholder, t: number) => (s.disputed & (1 << t)) !== 0;

function useRun(onChange: () => Promise<void>) {
  const toast = useToast();
  const { refreshBalances } = useApp();
  return async (label: string, fn: () => Promise<{ hash?: string }>) => {
    try {
      const { hash } = await fn();
      toast("ok", label, hash);
      invalidateActivity();
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
  const activity = useActivity(job);
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

  const find = (kind: Activity["kind"], pred: (a: Activity) => boolean = () => true) => activity?.filter((a) => a.kind === kind && pred(a)).at(-1);
  const trancheTx = (worker: string, tr: number) => find("tranche_released", (a) => a.worker === worker && Number(a.data.tranche) === tr)?.txHash;

  const STEPS: { label: string; tx?: string }[] = [
    { label: L("İş tanımlandı", "Job defined"), tx: find("job_created")?.txHash },
    { label: `${L("Çalışan onayları", "Worker approvals")} (${accepted}/${job.stakeholders.length})`, tx: find("job_accepted")?.txHash },
    { label: L("Escrow · iş sürüyor", "Escrow · in progress"), tx: find("job_funded")?.txHash },
    { label: L("Kapandı", "Closed"), tx: find("job_closed")?.txHash },
  ];

  const lock = async () => {
    if (!signer) return;
    const { codes, commitments } = await makeCodes(job.stakeholders.length);
    saveCodes(job.id, codes); // kodlar tx'ten önce kaydedilir ki kaybolmasın
    await run(L(`${total} USDC kilitlendi, saha QR kodları hazır`, `${total} USDC locked, on-site QR codes ready`), () => depositJob(signer, job.id, commitments));
  };

  const myRole = isClient ? L("işverensin", "you're the employer") : isContractor ? L("ihalecisin", "you're the contractor") : isWorker ? L("çalışansın", "you're a worker") : isArbiter ? L("hakemsin", "you're the arbiter") : "";

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
              {statusLabel(job.status)}
            </span>
            {myRole && <span className="small muted">{myRole}</span>}
          </div>
          <div className="job-amount">
            {total}
            <small>USDC</small>
          </div>
          {tryPerUsdc && <div className="small muted">≈ ₺{(Number(total) * tryPerUsdc).toLocaleString(locale(), { maximumFractionDigits: 0 })}</div>}
        </div>
        <div className="job-side">
          <span className="k">{L("İşveren", "Employer")}</span>
          <span className="v">{nameOf(t.client)}</span>
          <span className="k" style={{ marginTop: 6 }}>
            {L("Son tarih", "Deadline")}
          </span>
          <span className="v" style={{ color: deadlinePassed && job.status === JobStatus.Funded ? "var(--warn)" : undefined }}>
            {deadline.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </div>
      </div>

      <div className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
        {L("Kapora", "Deposit")} {pct(t.arrival_bps / 100)} · {L("Kod 2 ile", "after Code 2")} {pct(t.mid_bps / 100)} · {L("Hakem", "Arbiter")} {nameOf(t.arbiter)} ·{" "}
        <a href={`https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=17/${venue.lat}/${venue.lng}`} target="_blank" rel="noreferrer">
          {L("konum", "venue")} ({t.radius_m} m)
        </a>
      </div>

      {job.status !== JobStatus.Refunded && (
        <div className="stepper">
          {STEPS.map((s, i) => (
            <div key={i} className={`step ${i < currentStep ? "done" : i === currentStep ? "current" : ""}`}>
              <div className="bar" />
              <span>{s.label}</span>
              {i < currentStep && <ContractCallChip hash={s.tx} compact />}
            </div>
          ))}
        </div>
      )}

      <ContractStage job={job} last={activity?.at(-1)?.txHash} />

      <div className="stake-list">
        {job.stakeholders.map((s) => {
          const contractorRow = s.address === job.contractor;
          return (
            <div key={s.address} className={`stake ${s.address === me ? "me" : ""}`}>
              <div>
                <div className="who">
                  {nameOf(s.address)}
                  {contractorRow && <span className="muted small" style={{ fontWeight: 500 }}> · {L("ihaleci", "contractor")}</span>}
                  <a
                    className="small"
                    style={{ fontWeight: 500, marginLeft: 8 }}
                    href={twViewer(s.escrow)}
                    target="_blank"
                    rel="noreferrer"
                    title={L("Bu paydaşın Trustless Work escrow'u", "This stakeholder's Trustless Work escrow")}
                  >
                    escrow ↗
                  </a>
                </div>
                <div className="paybar" aria-label={`${fromUnits(s.paid)} / ${fromUnits(shareOf(job, s))} USDC`}>
                  <span style={{ width: `${Math.min(100, Number((s.paid * 100n) / (shareOf(job, s) || 1n)))}%` }} />
                </div>
              </div>
              <div className="tranches">
                {!contractorRow &&
                  [0, 1, 2].map((i) => {
                    const state = isReleased(s, i) ? "paid" : isDisputed(s, i) ? "disputed" : "open";
                    const tx = state === "paid" ? trancheTx(s.address, i) : undefined;
                    const inner = (
                      <>
                        {state === "paid" ? <Check size={13} strokeWidth={3} /> : state === "disputed" ? <Gavel size={13} /> : <Circle size={11} />}
                        {trancheShort(i)}
                        {tx && " ↗"}
                      </>
                    );
                    const title = state === "disputed" ? `${trancheLabel(i)}: ${L("Trustless Work'te hakemde", "with the arbiter in Trustless Work")}` : trancheLabel(i);
                    return tx ? (
                      <a key={i} className={`tranche ${state}`} href={`https://stellar.expert/explorer/testnet/tx/${tx}`} target="_blank" rel="noreferrer" title={`${title} · ${L("zincirdeki işlemi gör", "view on-chain transaction")}`}>
                        {inner}
                      </a>
                    ) : (
                      <span key={i} className={`tranche ${state}`} title={title}>
                        {inner}
                      </span>
                    );
                  })}
                {contractorRow && isDisputed(s, 0) && (
                  <span className="tranche disputed">
                    <Gavel size={13} /> {L("hakemde", "with arbiter")}
                  </span>
                )}
              </div>
              <div style={{ textAlign: "right", minWidth: 120 }}>
                <div style={{ fontWeight: 700 }}>
                  {fromUnits(s.paid)} <span className="muted small">/ {fromUnits(shareOf(job, s))}</span>
                </div>
                <div className="small muted">
                  {pct(s.share_bps / 100)} {L("pay", "share")}
                  {!s.accepted && <span style={{ color: "var(--warn)" }}> · {L("onay bekliyor", "awaiting approval")}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="job-actions">
        {signer && job.status === JobStatus.PendingApproval && myStake && !myStake.accepted && (
          <>
            <AsyncButton
              className="btn ok"
              onClick={() =>
                run(L("Şartları onayladın. Artık oran değiştirilemez.", "You accepted the terms. Shares can no longer change."), async () => {
                  if (!isContractor) await requestCameraAccess(); // sahada izin penceresiyle uğraşılmasın; reddedilse de akış sürer
                  await ensureReady(signer); // ödemeyi alabilmek için USDC trustline
                  return acceptJob(signer, job.id);
                })
              }
            >
              {L("Payımı ve şartları onayla", "Accept my share and the terms")} · {pct(myStake.share_bps / 100)}
            </AsyncButton>
            {!isContractor && (
              <span className="small muted">
                {L(
                  "Onaylarken tarayıcı kamera izni ister: sahada QR'ları okutmak için. Görüntü cihazından çıkmaz.",
                  "Your browser will ask for camera access so you can scan QR codes on site. The video never leaves your device.",
                )}
              </span>
            )}
          </>
        )}
        {job.status === JobStatus.PendingApproval && isClient && (
          <div className="callout">
            {L(
              "Tüm çalışanlar payını onaylayınca parayı kilitleyebileceksin. Böylece gizli oran değişikliği yapılamaz.",
              "You can lock the money once every worker has accepted their share, so nobody can quietly change the split.",
            )}
          </div>
        )}

        {signer && job.status === JobStatus.Approved && isClient && (
          <>
            <AsyncButton className="btn" disabled={insufficient} onClick={lock}>
              {L("Parayı kilitle ve saha QR kodlarını oluştur", "Lock the money and create the on-site QR codes")} · {total} USDC
            </AsyncButton>
            {insufficient && (
              <div className="callout warn">
                {L("USDC bakiyen yetersiz", "Not enough USDC")} ({clientUsdc?.toFixed(2)}).{" "}
                <button className="btn ghost sm" onClick={() => goTo("ramp")}>
                  {L("TL havalesiyle yükle →", "Top up with a TRY bank transfer →")}
                </button>
              </div>
            )}
          </>
        )}
        {job.status === JobStatus.Approved && !isClient && (
          <div className="callout">{L("Tüm paylar onaylandı. İşverenin parayı kilitlemesi bekleniyor.", "All shares accepted. Waiting for the employer to lock the money.")}</div>
        )}
      </div>

      {signer && job.status === JobStatus.Funded && isClient && <ClientCodes job={job} signer={signer} run={run} />}
      {signer && job.status === JobStatus.Funded && isWorker && myStake && <WorkerPanel job={job} me={myStake} signer={signer} run={run} venue={venue} />}
      {signer && job.status === JobStatus.Funded && isArbiter && <ArbiterPanel job={job} signer={signer} run={run} />}
      {signer && isArbiter && job.stakeholders.some((s) => s.disputed !== 0) && <DisputePanel job={job} signer={signer} run={run} />}

      <div className="job-actions">
        {signer && job.status === JobStatus.Funded && isClient && (
          <AsyncButton
            className="btn ok"
            onClick={async () => {
              closingHere.add(String(job.id));
              try {
                await run(L("İş kapandı, kalan paylar dağıtıldı", "Job closed, remaining shares paid out"), () => completeJob(signer, job.id));
              } finally {
                closingHere.delete(String(job.id));
              }
            }}
          >
            {L("İşi kapat · kalan ödemeleri dağıt", "Close the job · pay out the rest")}
          </AsyncButton>
        )}
        {job.status === JobStatus.Closing && closingHere.has(String(job.id)) && (
          <div className="callout row" role="status">
            <span className="spinner" /> {L("Trustless Work milestone'ları parça parça serbest bırakılıyor…", "Releasing Trustless Work milestones in batches…")}
          </div>
        )}
        {signer && job.status === JobStatus.Closing && !closingHere.has(String(job.id)) && (
          <AsyncButton className="btn" onClick={() => run(L("Kapanış tamamlandı", "Closing finished"), () => continueClose(signer, job.id))}>
            {L("Kapanışa devam et", "Continue closing")}
          </AsyncButton>
        )}
        {signer && job.status === JobStatus.Funded && deadlinePassed && (
          <AsyncButton
            className="btn secondary"
            onClick={async () => {
              closingHere.add(String(job.id));
              try {
                await run(L("Son tarih geçti, ödemeler dağıtıldı", "Deadline passed, payments distributed"), () => releaseJob(signer, job.id));
              } finally {
                closingHere.delete(String(job.id));
              }
            }}
          >
            {L("Son tarih doldu · dağıtımı başlat", "Deadline passed · start the payout")}
          </AsyncButton>
        )}
        {job.status === JobStatus.Funded && !isClient && !deadlinePassed && (
          <div className="callout small">
            {L(
              `İşveren kapatmazsa ${deadline.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} sonrasında herkes dağıtımı başlatabilir: işe gelen (kaporası açılmış) çalışanlar kalan paylarını alır, hiç gelmeyenlerin payı hakem kararıyla işverene döner.`,
              `If the employer doesn't close the job, anyone can start the payout after ${deadline.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}: workers who showed up get the rest of their share, and the share of no-shows goes back to the employer by the arbiter's decision.`,
            )}
          </div>
        )}
        {job.status === JobStatus.Completed && myStake && (
          <div className="callout ok">
            {L(
              `Toplam ${fromUnits(netOfTwFee(myStake.paid))} USDC hesabına geçti (Trustless Work %0,3 protokol ücreti düşülerek).`,
              `${fromUnits(netOfTwFee(myStake.paid))} USDC reached your account in total (after the 0.3% Trustless Work protocol fee).`,
            )}{" "}
            <button className="btn ghost sm" onClick={() => goTo("ramp")}>
              {L("TL olarak IBAN'a çek →", "Withdraw to your IBAN in TRY →")}
            </button>
          </div>
        )}
      </div>

      <ChainLog job={job} activity={activity} />
    </article>
  );
}

/**
 * Jüri: "kontratı her aşamada görmek istiyoruz". Her aşamada kontrat adresi, o aşamada çağrılabilen
 * fonksiyonlar (kimin çağırdığıyla) ve zincirdeki son çağrı gösterilir.
 */
function ContractStage({ job, last }: { job: Job; last: string | undefined }) {
  const W = L("çalışan", "worker");
  const C = L("işveren", "employer");
  const A = L("hakem", "arbiter");
  const ANY = L("herkes", "anyone");
  const fns: [string, string][] =
    job.status === JobStatus.PendingApproval
      ? [["accept_job(job_id, worker)", W]]
      : job.status === JobStatus.Approved
        ? [["deposit(job_id, commitments)", C]]
        : job.status === JobStatus.Funded
          ? [
              ["claim(job_id, worker, tranche, code)", W],
              ["confirm_presence(job_id, worker, present)", C],
              ["submit_location(job_id, worker, distance_m, hash)", W],
              ["arbiter_release(job_id, worker, tranche)", A],
              ["complete_and_split(job_id)", C],
              ["release_after_deadline(job_id)", ANY],
            ]
          : job.status === JobStatus.Closing
            ? [["continue_close(job_id)", ANY]]
            : [["get_job(job_id)", L("salt okunur", "read-only")]];
  return (
    <div className="contract-stage">
      <div className="row" style={{ gap: 8 }}>
        <FileCode2 size={16} />
        <b>{L("Kontrat · bu aşama", "Contract · this stage")}</b>
        <a className="mono small" href={expertAccount(CONTRACT_ID)} target="_blank" rel="noreferrer" title={CONTRACT_ID}>
          EkIsler {CONTRACT_ID.slice(0, 4)}…{CONTRACT_ID.slice(-4)} ↗
        </a>
        <span className="muted small">· Soroban · Stellar testnet</span>
      </div>
      <div className="fns">
        {fns.map(([f, who]) => (
          <span key={f} className="fn">
            <code>{f}</code>
            <span className="who">{who}</span>
          </span>
        ))}
      </div>
      {last && (
        <div className="row small" style={{ gap: 6 }}>
          <span className="muted">{L("Son çağrı", "Last call")}:</span>
          <ContractCallChip hash={last} />
        </div>
      )}
    </div>
  );
}

/** İşin zincirdeki tüm adımları, her biri kendi işlemine linkli */
function ChainLog({ job, activity }: { job: Job; activity: Activity[] | null }) {
  const { nameOf } = useApp();
  const describe = (a: Activity): string => {
    const who = a.worker ? nameOf(a.worker) : "";
    const amount = typeof a.data.amount === "bigint" ? `${fromUnits(a.data.amount)} USDC` : "";
    switch (a.kind) {
      case "job_created":
        return L(`İş zincire yazıldı · ${a.data.escrows ?? ""} Trustless Work escrow'u açıldı`, `Job written on-chain · ${a.data.escrows ?? ""} Trustless Work escrows opened`);
      case "job_accepted":
        return L(`${who} payını onayladı`, `${who} accepted their share`);
      case "job_funded":
        return L(`${amount} escrow'lara kilitlendi`, `${amount} locked in the escrows`);
      case "tranche_released":
        return `${who} · ${trancheLabel(Number(a.data.tranche))} · ${amount}${a.data.by_arbiter ? L(" · hakem kararıyla", " · by the arbiter") : ""}`;
      case "presence_checked":
        return a.data.present
          ? L(`Kod 2 · işveren onayladı: ${who} iş yerinde`, `Code 2 · employer confirmed ${who} is on site`)
          : L(`Kod 2 · işveren bildirdi: ${who} iş yerinde değil`, `Code 2 · employer reported ${who} is not on site`);
      case "location_submitted":
        return L(`${who} konum kanıtı · etkinliğe ${a.data.distance_m} m`, `${who} location proof · ${a.data.distance_m} m from the venue`);
      case "alert_raised":
        return Number(a.data.kind) === ALERT_LEFT_AREA
          ? L(`Uyarı · ${who} etkinlik alanından çıktı`, `Alert · ${who} left the venue`)
          : L(`Uyarı · ${who} iş yerinde değil`, `Alert · ${who} is not on site`);
      case "job_closed":
        return Number(a.data.status) === JobStatus.Refunded ? L("İş iptal edildi, para iade edildi", "Job cancelled, money refunded") : L("İş kapandı", "Job closed");
      default:
        return a.kind;
    }
  };

  return (
    <details className="chainlog">
      <summary>
        <ShieldCheck size={16} /> {L("Zincir kaydı", "On-chain record")}
        <span className="muted small"> · {activity === null ? "…" : L(`${activity.length} işlem`, `${activity.length} transactions`)}</span>
      </summary>
      {activity && activity.length === 0 && (
        <div className="small muted" style={{ padding: "8px 0" }}>
          {L(
            "Bu işin adımları RPC'nin ~11 saatlik event penceresinin dışında. Escrow linkleri ve kontrat yine doğrulanabilir.",
            "This job's steps are outside the RPC's ~11-hour event window. The escrow links and the contract can still be verified.",
          )}
        </div>
      )}
      <ol>
        {(activity ?? []).map((a, i) => (
          <li key={`${a.txHash}-${i}`}>
            <span className="t">{a.at.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="d">
              {describe(a)}
              <br />
              <ContractCallChip hash={a.txHash} />
            </span>
          </li>
        ))}
      </ol>
      <div className="small muted">
        {L("İş", "Job")} #{String(job.id)} · {L("her satır Stellar testnet'teki gerçek bir işlem", "every row is a real Stellar testnet transaction")}
      </div>
    </details>
  );
}

const hhmm = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
const lastAlert = (job: Job, worker: string, kind: number) => [...job.alerts].reverse().find((a) => a.worker === worker && a.kind === kind);

/** İşveren saha paneli: Kod 1 (varış QR'ı), Kod 2 (hâlâ burada mı?), gün sonu QR'ı ve alan dışı bildirimleri */
function ClientCodes({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const codes = loadCodes(job.id);
  const [open, setOpen] = useState<{ idx: number; tranche: number } | null>(null);
  const workers = job.stakeholders.map((s, idx) => ({ s, idx })).filter(({ s }) => s.address !== job.contractor);
  const openItem = open && workers.find((w) => w.idx === open.idx);

  return (
    <div className="panel">
      <div className="panel-title">
        <QrCode size={17} /> {L("Saha kontrolü · her adım çalışana anında ödeme açar", "On-site checks · every step pays the worker instantly")}
      </div>
      {!codes && (
        <div className="callout warn small">
          {L(
            "Kod 1 ve gün sonu QR'ı parayı kilitleyen cihazda üretildi, bu cihazda yok. Kod 2 onayı ve işi kapatma yine çalışır.",
            "Code 1 and the end-of-day QR were created on the device that locked the money, not this one. Code 2 and closing the job still work.",
          )}
        </div>
      )}
      {workers.map(({ s, idx }) => {
        const left = lastAlert(job, s.address, ALERT_LEFT_AREA);
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn secondary sm" disabled={!codes || isReleased(s, 0)} onClick={() => setOpen({ idx, tranche: 0 })}>
                  {isReleased(s, 0) ? <Check size={14} /> : <QrCode size={14} />} {L("Kod 1 · Varış", "Code 1 · Arrival")}
                </button>
                <button className="btn secondary sm" disabled={!codes || isReleased(s, 2)} onClick={() => setOpen({ idx, tranche: 2 })}>
                  {isReleased(s, 2) ? <Check size={14} /> : <QrCode size={14} />} {L("Gün sonu QR", "End-of-day QR")}
                </button>
              </span>
            </div>
            {isReleased(s, 0) && !isReleased(s, 1) && (
              <div className="row small">
                <span>
                  <b>{L("Kod 2", "Code 2")}</b> · {L(`${nameOf(s.address)} hâlâ iş yerinde mi?`, `Is ${nameOf(s.address)} still on site?`)}
                </span>
                <AsyncButton
                  className="btn ok sm"
                  onClick={() =>
                    run(L("Kod 2 onaylandı, mesai ödemesi gönderildi", "Code 2 confirmed, mid-shift payment sent"), () => confirmPresence(signer, job.id, s.address, true))
                  }
                >
                  {L("Evet, burada", "Yes, here")}
                </AsyncButton>
                <AsyncButton
                  className="btn secondary sm"
                  onClick={() =>
                    run(L("Çalışana \"iş yerinde değil\" bildirimi gönderildi", "The worker was notified they're marked absent"), () =>
                      confirmPresence(signer, job.id, s.address, false),
                    )
                  }
                >
                  {L("Hayır, burada değil", "No, not here")}
                </AsyncButton>
              </div>
            )}
            {isReleased(s, 0) && !isReleased(s, 1) && <Kod2Waiting job={job} worker={s.address} workerName={nameOf(s.address)} />}
            {isReleased(s, 1) && (
              <span className="small muted row" style={{ gap: 4 }}>
                <Check size={14} /> {L("Kod 2 onaylandı", "Code 2 confirmed")}
              </span>
            )}
            {left && !isReleased(s, 2) && (
              <div className="callout warn small row" role="alert" style={{ flexWrap: "nowrap" }}>
                <TriangleAlert size={16} style={{ flex: "none" }} />
                <span>
                  {hhmm(left.timestamp)} ·{" "}
                  {L(`${nameOf(s.address)} etkinlik alanından çıktı (etkinliğe ${left.distance_m} m)`, `${nameOf(s.address)} left the venue (${left.distance_m} m away)`)}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {open && openItem && codes && (
        <Modal title={`${trancheLabel(open.tranche)} · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <ExpiringQr text={encodeQr({ jobId: job.id, tranche: open.tranche, worker: openItem.s.address, code: codes[open.idx * 3 + open.tranche] })} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            {L(
              `Okutulunca çalışanın ödenen tutarı ${fromUnits(trancheTarget(job, openItem.s, open.tranche))} USDC'ye çıkar.`,
              `Once scanned, the worker's paid amount rises to ${fromUnits(trancheTarget(job, openItem.s, open.tranche))} USDC.`,
            )}
            <br />
            {L("Bu kodu sadece çalışan yanındayken göster.", "Only show this code when the worker is with you.")}
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
      if (tick > 0) toast("info", L(`Hatırlatma: ${workerName} hâlâ iş yerinde mi? Kod 2'yi onayla.`, `Reminder: is ${workerName} still on site? Confirm Code 2.`));
    }
  }, [elapsed, toast, workerName]);

  if (elapsed == null) return null;
  if (elapsed >= KOD2_TIMEOUT_S) {
    return <span className="badge warn">{L("Kod 2 · 15 dk cevapsız, çalışana bildirildi", "Code 2 · no answer for 15 min, worker notified")}</span>;
  }
  const remaining = Math.ceil((KOD2_TIMEOUT_S - elapsed) / 60);
  return (
    <span className="small muted">
      {L(`Kod 2 bekleniyor · ${remaining} dk içinde cevapsız kalırsa çalışana bilgi verilecek`, `Waiting for Code 2 · the worker will be told if there's no answer within ${remaining} min`)}
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
        {L(
          "QR'ın 5 dakikalık gösterim süresi doldu. Çalışan bu sürede okutamadıysa sorun değil, tekrar gösterebilirsin.",
          "The QR's 5-minute display time is over. If the worker didn't scan it in time, just show it again.",
        )}
        <div style={{ marginTop: 8 }}>
          <button className="btn secondary sm" onClick={() => setExpiresAt(Date.now() + QR_DISPLAY_TTL_S * 1000)}>
            {L("Yeniden göster · 5 dk", "Show again · 5 min")}
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
      <span className="badge">
        {L("Kalan süre", "Time left")} {mm}:{ss}
      </span>
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
      run(L(`Alandan çıkış işverene bildirildi (${d} m)`, `Leaving the venue was reported to the employer (${d} m)`), async () => {
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
        <MapPin size={17} /> {L("Konum takibi (Kod 1'den gün sonu QR'ına kadar)", "Location tracking (from Code 1 to the end-of-day QR)")}
      </div>
      <div className="small muted">
        {L(
          `Konumun yalnızca bu cihazda izlenir. Etkinlik alanından (${radius} m) çıkarsan sadece mesafe bilgisi zincire yazılır ve işverene bildirim gider; ham koordinatların hiçbir yere gönderilmez.`,
          `Your location is only tracked on this device. If you leave the venue (${radius} m), only the distance is written on-chain and the employer is notified; your raw coordinates are never sent anywhere.`,
        )}
      </div>
      <div className="row">
        <button className={on ? "btn secondary sm" : "btn sm"} onClick={() => setOn(!on)}>
          {on ? L("Takibi durdur", "Stop tracking") : L("Konum takibini başlat", "Start location tracking")}
        </button>
        {on && dist !== null && (
          <span className={`badge ${dist <= radius ? "ok" : "warn"}`}>
            {L(`Etkinliğe ${dist} m`, `${dist} m from venue`)} · {dist <= radius ? L("alan içinde", "inside") : L("alan dışında", "outside")}
          </span>
        )}
        <AsyncButton
          className="btn ghost sm"
          title={L("Demo: etkinlik noktasından ~650 m uzaklaşmış gibi davran", "Demo: act as if you moved ~650 m away from the venue")}
          onClick={() => report(650, venue.lat + 0.0058, venue.lng)}
        >
          {L("Demo: alandan çık", "Demo: leave the venue")}
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
    if (!p) return toast("err", L("Bu bir Ek İşler ödeme QR'ı değil", "This is not an Ek İşler payment QR"));
    if (p.jobId !== job.id) return toast("err", L(`Bu QR başka bir işe ait (#${p.jobId})`, `This QR belongs to another job (#${p.jobId})`));
    if (p.worker !== me.address) return toast("err", L("Bu QR başka bir çalışan için üretilmiş", "This QR was issued for another worker"));
    setScanning(false);
    setProcessing(trancheLabel(p.tranche));
    try {
      await run(L(`${trancheLabel(p.tranche)} ödemesi hesabına geçti`, `${trancheLabel(p.tranche)} payment reached your account`), () =>
        claimTranche(signer, job.id, p.tranche, p.code),
      );
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

  if (next === undefined)
    return (
      <div className="callout ok" style={{ marginTop: 14 }}>
        {L("Tüm dilimlerin ödendi.", "All your steps are paid.")}
      </div>
    );

  return (
    <div className="panel">
      {absent && !isReleased(me, 1) && (
        <div className="callout err small row" role="alert" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <Bell size={16} style={{ flex: "none", marginTop: 2 }} />
          <span>
            {L(
              `İşveren ${hhmm(absent.timestamp)} itibarıyla iş yerinde olmadığını bildirdi. Oradaysan işverenle konuş ya da konum takibinle kanıt oluştur; hakem inceleyebilir.`,
              `At ${hhmm(absent.timestamp)} the employer reported you are not on site. If you are there, talk to the employer or build proof with location tracking; the arbiter can review it.`,
            )}
          </span>
        </div>
      )}
      <div className="panel-title">
        <ScanLine size={17} /> {L("Sıradaki ödeme", "Next payment")}: <b>{trancheLabel(next)}</b> → {L("toplam", "total")} {fromUnits(trancheTarget(job, me, next))} USDC
      </div>
      {next === 1 && (
        <>
          <div className="small muted">
            {L(
              "Kod 2 işverenin \"hâlâ burada\" onayıyla açılır. Gün sonunda işverenin QR'ını okutarak kalan payını alırsın.",
              "Code 2 is released when the employer confirms you're still here. At the end of the day, scan the employer's QR to get the rest of your share.",
            )}
          </div>
          <Kod2TimeoutBanner job={job} worker={me.address} />
        </>
      )}
      {processing && (
        <div className="callout row" role="status">
          <span className="spinner" />{" "}
          {L(`QR doğrulandı · ${processing} ödemesi Trustless Work escrow'undan hesabına gönderiliyor…`, `QR verified · sending the ${processing} payment from the Trustless Work escrow to your account…`)}
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={!!processing} onClick={() => setScanning(true)}>
          <ScanLine size={17} /> {scannable === 0 ? L("Kod 1'i okut (varış)", "Scan Code 1 (arrival)") : L("Gün sonu QR'ını okut", "Scan the end-of-day QR")}
        </button>
        {demoCodes && (
          <AsyncButton
            className="btn secondary sm"
            title={L("Demo: işveren rolü aynı tarayıcıda oynandığı için kod bu cihazda duruyor", "Demo: the employer role is played in this same browser, so the code is on this device")}
            onClick={() => applyCode(encodeQr({ jobId: job.id, tranche: scannable, worker: me.address, code: demoCodes[idx * 3 + scannable] }))}
          >
            {L("Demo: işverenin ekranındaki", "Demo: use the employer's")} {scannable === 0 ? L("Kod 1", "Code 1") : L("gün sonu QR'ı", "end-of-day QR")}
          </AsyncButton>
        )}
      </div>

      {isReleased(me, 0) && <LocationTracker job={job} me={me} signer={signer} run={run} venue={venue} />}
      {!isReleased(me, 0) && (
        <>
          <div className="panel-title" style={{ marginTop: 8 }}>
            <MapPin size={17} />{" "}
            {L("İşveren Kod 1'i vermiyor mu? Konumunu kanıt olarak kaydet, hakem kaporayı serbest bıraksın.", "Employer not giving you Code 1? Record your location as proof so the arbiter can release your deposit.")}
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
              {L("Konumumu al", "Get my location")}
            </AsyncButton>
            <button
              className="btn ghost sm"
              title={L("Demo: sahnede konum izni olmayabilir; etkinlik noktasına ~40 m mesafede bir konum kullanılır", "Demo: location may be unavailable on stage; uses a point ~40 m from the venue")}
              onClick={() => setPos({ lat: venue.lat + 0.0003, lng: venue.lng + 0.0002 })}
            >
              {L("Demo: etkinlik alanındayım", "Demo: I'm at the venue")}
            </button>
            {pos && (
              <>
                <span className={`badge ${dist! <= job.terms.radius_m ? "ok" : "warn"}`}>
                  {L(`Etkinliğe ${dist} m`, `${dist} m from venue`)} · {dist! <= job.terms.radius_m ? L("alan içinde", "inside") : L("alan dışında", "outside")}
                </span>
                <AsyncButton
                  className="btn sm"
                  title={L("Zincire yalnızca mesafe ve ölçümün hash'i yazılır; ham koordinat bu cihazda kalır", "Only the distance and a hash of the reading go on-chain; raw coordinates stay on this device")}
                  onClick={() =>
                    run(L("Konum kanıtı kaydedildi (zincirde yalnızca mesafe ve hash)", "Location proof recorded (only distance and hash on-chain)"), async () => {
                      const { reading, hash } = await commitReading({ lat: pos.lat, lng: pos.lng, at: Date.now() });
                      saveReading(job.id, me.address, reading);
                      return submitLocation(signer, job.id, dist!, hash);
                    })
                  }
                >
                  {L("Kanıt olarak gönder", "Submit as proof")}
                </AsyncButton>
              </>
            )}
          </div>
          {myProofs.length > 0 && (
            <div className="small muted">
              {L("Zincirdeki konum kanıtların", "Your on-chain location proofs")}: {myProofs.length} · {L("son", "last")}:{" "}
              {new Date(Number(myProofs[myProofs.length - 1].timestamp) * 1000).toLocaleTimeString(locale())}
            </div>
          )}
        </>
      )}

      {scanning && (
        <Modal title={`${trancheLabel(scannable)} · ${L("okut", "scan")}`} onClose={() => setScanning(false)}>
          <QrScanner onResult={applyCode} />
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
    <div className="callout warn small row" role="alert" style={{ flexWrap: "nowrap" }}>
      <Bell size={16} style={{ flex: "none" }} />
      <span>
        {L(
          "İşvereniniz Kod 2'ye 15 dakikadır cevap vermedi. Hâlâ sahadaysanız işvereninizle iletişime geçebilirsiniz.",
          "Your employer hasn't answered Code 2 for 15 minutes. If you're still on site, you can contact them.",
        )}
      </span>
    </div>
  );
}

function ArbiterPanel({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const workers = job.stakeholders.filter((s) => s.address !== job.contractor);
  return (
    <div className="panel">
      <div className="panel-title">
        <Gavel size={17} /> {L("Hakem paneli · konum kanıtlarını incele", "Arbiter panel · review location proofs")}
      </div>
      {job.locations.length === 0 && <div className="small muted">{L("Henüz konum kanıtı gönderilmedi.", "No location proofs yet.")}</div>}
      {workers.map((s) => {
        const proofs = job.locations.filter((l) => l.worker === s.address);
        if (!proofs.length) return null;
        const last = proofs[proofs.length - 1];
        const d = last.distance_m;
        const inside = d <= job.terms.radius_m;
        const next = [0, 1].find((t) => !isReleased(s, t));
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className={`badge ${inside ? "ok" : "err"}`}>
                {d} m · {inside ? L("etkinlik alanında", "at the venue") : L("alan dışında", "outside the venue")}
              </span>
            </div>
            <div className="small muted">
              {L(
                `${proofs.length} kanıt · son ${new Date(Number(last.timestamp) * 1000).toLocaleString("tr-TR")} · ham koordinat zincirde yok, gerekirse çalışandan istenip hash'le doğrulanır`,
                `${proofs.length} proofs · last ${new Date(Number(last.timestamp) * 1000).toLocaleString("en-GB")} · raw coordinates are not on-chain; if needed, ask the worker and check them against the hash`,
              )}
            </div>
            {next !== undefined ? (
              <div className="row">
                <AsyncButton
                  className="btn sm"
                  onClick={() =>
                    run(L(`${trancheLabel(next)} dilimi hakem kararıyla ödendi`, `${trancheLabel(next)} paid by the arbiter's decision`), () =>
                      arbiterRelease(signer, job.id, s.address, next),
                    )
                  }
                >
                  {L(`${trancheLabel(next)} dilimini serbest bırak`, `Release ${trancheLabel(next)}`)} · {fromUnits(trancheTarget(job, s, next) - s.paid)} USDC
                </AsyncButton>
              </div>
            ) : (
              <span className="badge ok">{L("Kapora ve mesai ödendi", "Deposit and mid-shift paid")}</span>
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
      Promise.all(
        key
          .split(",")
          .filter(Boolean)
          .map(async (escrow) => ({ escrow, e: await getEscrow(escrow) })),
      )
        .then(setData)
        .catch(() => setData(null)),
    [key],
  );
  useEffect(() => {
    load();
  }, [load, job]);

  const open = (data ?? []).flatMap(({ escrow, e }) =>
    e.milestones.map((m, index) => ({ escrow, m, index })).filter(({ m }) => m.flags.disputed && !m.flags.resolved && !m.flags.released),
  );
  const label = (d: string) =>
    ({
      varis: L("Kod 1 · Varış", "Code 1 · Arrival"),
      mesai: L("Kod 2 · Devam", "Code 2 · Still here"),
      bitis: L("Gün sonu", "End of day"),
      ihaleci: L("İhaleci payı", "Contractor's share"),
    })[d] ?? d;
  const total = open.reduce((a, { m }) => a + m.amount, 0n);

  return (
    <div className="panel">
      <div className="panel-title">
        <Gavel size={17} /> {L("Trustless Work dispute'ları · karar hakemde", "Trustless Work disputes · the arbiter decides")}
      </div>
      {!data && <div className="small muted">{L("Escrow'lar okunuyor…", "Reading escrows…")}</div>}
      {data && open.length === 0 && <div className="small muted">{L("Açık dispute yok, hepsi çözüldü.", "No open disputes, all resolved.")}</div>}
      {open.length > 1 && (
        <AsyncButton
          className="btn"
          onClick={async () => {
            for (const { escrow, m, index } of open) {
              if (!(await run(L(`${label(m.description)} işverene iade edildi`, `${label(m.description)} refunded to the employer`), () => resolveToClient(signer, job, escrow, index, m.amount))))
                break;
            }
            await load();
          }}
        >
          {L("Tümünü işverene iade et", "Refund all to the employer")} · {fromUnits(total)} USDC
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
              await run(L("Dispute çözüldü, tutar işverene iade edildi", "Dispute resolved, amount refunded to the employer"), () => resolveToClient(signer, job, escrow, index, m.amount));
              await load();
            }}
          >
            {L("İşverene iade et", "Refund to employer")}
          </AsyncButton>
        </div>
      ))}
    </div>
  );
}
