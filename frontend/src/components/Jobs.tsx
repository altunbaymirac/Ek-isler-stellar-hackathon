import { Bell, Check, Circle, FileCode2, Gavel, KeyRound, MapPin, Plus, QrCode, RefreshCw, ScanLine, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONTRACT_ID, expertAccount, twViewer } from "../lib/config.ts";
import { useApp } from "../app-context.tsx";
import { cameraMessage, cameraSupport, requestCameraAccess } from "../lib/camera.ts";
import {
  CODE_ARRIVAL,
  CODE_FINAL,
  CODE_LENGTH,
  CODES,
  commitReading,
  decodeQr,
  distanceM,
  encodeQr,
  formatCode,
  loadCodes,
  makeCodes,
  normalizeCode,
  saveCodes,
  saveReading,
} from "../lib/codes.ts";
import {
  acceptJob,
  ALERT_LEFT_AREA,
  ALERT_REPORTED_ABSENT,
  arbiterConfirmArrival,
  arbiterRelease,
  checkIn,
  claimPayment,
  completeJob,
  confirmPresenceAll,
  continueClose,
  depositJob,
  friendlyError,
  fromE6,
  fromUnits,
  getEscrow,
  JobStatus,
  listJobs,
  netOfTwFee,
  presenceWindow,
  releaseJob,
  resolveToClient,
  setCodes,
  shareOf,
  statusLabel,
  submitLocation,
  type Job,
  type Stakeholder,
  type TwEscrow,
} from "../lib/contract.ts";
import { invalidateActivity, jobActivity, type Activity } from "../lib/events.ts";
import { ensureReady } from "../lib/horizon.ts";
import { L, locale } from "../lib/i18n.ts";
import type { Signer } from "../lib/signer.ts";
import { Modal, QrImage, QrScanner } from "./Qr.tsx";
import { AsyncButton, ContractCallChip, useToast } from "./ui.tsx";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const pct = (n: number) => L(`%${n.toLocaleString("tr-TR")}`, `${n}%`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

/** İşin zincirdeki adım kayıtları; iş değiştikçe (onay, varış, ödeme, uyarı) yeniden okunur */
function useActivity(job: Job) {
  const sig = `${job.status}|${job.commitments.length}|${job.stakeholders.map((s) => `${s.accepted}${s.arrived}${s.checks}${s.released}${s.disputed}`).join(",")}|${job.alerts.length}|${job.locations.length}`;
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

  const steps: [string, string][] = [
    [L("Kod 1 · Varış", "Code 1 · Arrival"), ""],
    [L("Kod 2 · Gün ortası", "Code 2 · Midday"), ""],
    [L("QR · Gün sonu", "QR · End of day"), "final"],
    [L("Konum", "Location"), "dark"],
  ];

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Stellar · Soroban · Trustless Work</span>
        <h1>{L("Para aracıda değil, escrow'da.", "The money sits in escrow, not with a middleman.")}</h1>
      </section>
      <div className="steps4">
        {steps.map(([title, cls]) => (
          <div key={title} className={`step4 ${cls}`}>
            <span className="title">{title}</span>
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

const hhmm = (ts: bigint) => clock(Number(ts) * 1000);
const lastAlert = (job: Job, worker: string, kind: number) => [...job.alerts].reverse().find((a) => a.worker === worker && a.kind === kind);

/**
 * Onay adımında bildirim, kamera ve konum izinlerini önceden ister; hiçbiri reddedilse de
 * akışı engellemez. Üçü de sahada lazım: bildirim Kod 2 uyarısı için, kamera gün sonu QR'ı
 * için, konum ihaleci Kod 1'i vermezse kanıt için. İzin penceresi sahada değil, şimdi açılsın.
 */
async function askFieldPermissions() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
  } catch {
    /* tarayıcı bildirim desteklemiyor */
  }
  await requestCameraAccess(); // kendi hatasını yutar, durum döner
  await new Promise<void>((resolve) =>
    navigator.geolocation.getCurrentPosition(
      () => resolve(),
      () => resolve(),
      { timeout: 10_000 },
    ),
  );
}

/** Tarayıcı bildirimi. İzin yoksa sessizce atlanır; ekrandaki uyarı yine görünür. */
function notify(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body });
  } catch {
    /* tarayıcı bildirim desteklemiyor */
  }
}

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

  // Zincire yeni düşen uyarıları tarayıcı bildirimi olarak da göster: sayfa arka plandayken de görünsün.
  const seenAlerts = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = job.alerts.map((a) => `${a.worker}:${a.kind}:${a.timestamp}`);
    if (seenAlerts.current === null) {
      seenAlerts.current = new Set(keys); // ilk yüklemedeki geçmiş uyarılar için bildirim gönderme
      return;
    }
    job.alerts.forEach((a, i) => {
      if (seenAlerts.current!.has(keys[i])) return;
      seenAlerts.current!.add(keys[i]);
      if (a.kind === ALERT_REPORTED_ABSENT && a.worker === me) {
        notify(L("Çalışmıyorsun deniyor", "You're reported as not working"), L("İhaleci, şu an iş yerinde çalışmadığını söylüyor.", "The contractor says you're not working on site right now."));
      } else if (a.kind === ALERT_LEFT_AREA && isContractor) {
        notify(L("Çalışan alandan çıktı", "A worker left the venue"), L(`${nameOf(a.worker)} etkinlik alanından ${a.distance_m} m uzaklaştı.`, `${nameOf(a.worker)} moved ${a.distance_m} m away from the venue.`));
      }
    });
  }, [job, me, isContractor, nameOf]);

  const currentStep =
    job.status === JobStatus.PendingApproval ? 1 : job.status === JobStatus.Approved ? 2 : job.status === JobStatus.Funded ? 3 : 4;

  const clientUsdc = isClient && balances?.usdc != null ? Number(balances.usdc) : null;
  const insufficient = clientUsdc !== null && clientUsdc < Number(fromUnits(t.total_amount, 7));

  const find = (kind: string, pred: (a: Activity) => boolean = () => true) => activity?.filter((a) => a.kind === kind && pred(a)).at(-1);
  const STEPS: { label: string; tx?: string }[] = [
    { label: L("İş tanımlandı", "Job defined"), tx: find("job_created")?.txHash },
    { label: `${L("Çalışan onayları", "Worker approvals")} (${accepted}/${job.stakeholders.length})`, tx: find("job_accepted")?.txHash },
    { label: L("Escrow · iş sürüyor", "Escrow · in progress"), tx: find("job_funded")?.txHash },
    { label: L("Kapandı", "Closed"), tx: find("job_closed")?.txHash },
  ];
  const txOf = (kind: string, worker: string) => find(kind, (a) => a.worker === worker)?.txHash;

  const lock = async () => {
    if (!signer) return;
    await run(L(`${total} USDC Trustless Work escrow'una kilitlendi`, `${total} USDC locked in the Trustless Work escrow`), () => depositJob(signer, job.id));
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
        {L("Çalışma", "Shift")} {clock(Number(t.work_start) * 1000)}–{clock(Number(t.work_end) * 1000)} · {L("ödeme gün sonu QR'ında, tamamı", "paid in full at the end-of-day QR")} · {L("Hakem", "Arbiter")}{" "}
        {nameOf(t.arbiter)} ·{" "}
        <a href={`https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=17/${venue.lat}/${venue.lng}`} target="_blank" rel="noreferrer">
          {L("konum", "venue")} ({t.radius_m} m)
        </a>{" "}
        ·{" "}
        <a href={twViewer(job.escrow)} target="_blank" rel="noreferrer" title={L("Para Ek İşler'de değil, bu işin Trustless Work escrow'unda duruyor", "The money is not with Ek İşler; it sits in this job's Trustless Work escrow")}>
          Trustless Work escrow ↗
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
          const arrivedTx = txOf("checked_in", s.address);
          const paidTx = txOf("payment_released", s.address);
          return (
            <div key={s.address} className={`stake ${s.address === me ? "me" : ""}`}>
              <div>
                <div className="who">
                  {nameOf(s.address)}
                  {contractorRow && <span className="muted small" style={{ fontWeight: 500 }}> · {L("ihaleci", "contractor")}</span>}
                </div>
                <div className="paybar" aria-label={`${fromUnits(s.paid)} / ${fromUnits(shareOf(job, s))} USDC`}>
                  <span style={{ width: s.released ? "100%" : "0%" }} />
                </div>
              </div>
              <div className="tranches">
                {!contractorRow && (
                  <Chip state={s.arrived ? "paid" : "open"} tx={arrivedTx} title={L("Kod 1 girildi mi? Para hareket ettirmez.", "Was Code 1 entered? Moves no money.")}>
                    {s.arrived ? L("geldi", "arrived") : L("gelmedi", "not arrived")}
                  </Chip>
                )}
                {!contractorRow && s.checks > 0 && (
                  <Chip state="paid" tx={txOf("presence_checked", s.address)} title={L("Kod 2 yoklaması", "Code 2 roll call")}>
                    {L(`Kod 2 · ${s.checks}`, `Code 2 · ${s.checks}`)}
                  </Chip>
                )}
                <Chip state={s.released ? "paid" : s.disputed ? "disputed" : "open"} tx={paidTx}>
                  {s.released ? L("ödendi", "paid") : s.disputed ? L("hakemde", "with arbiter") : L("ödenmedi", "unpaid")}
                </Chip>
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
            <div className="callout small">
              {L(
                "Onaylayınca tarayıcı bildirim, kamera ve konum izni isteyecek. Kamera yalnızca gün sonu QR'ını okuturken açılır; görüntü cihazından çıkmaz. Konumun da yalnızca kendi cihazında işlenir; zincire sadece etkinlik noktasına uzaklığın yazılır. Takip Kod 1'i girdiğin anda başlar, gün sonu ödemesiyle biter ve istediğin an durdurabilirsin.",
                "When you accept, your browser will ask for notification, camera and location access. The camera only opens to scan the end-of-day QR and the video never leaves your device. Location is processed on your device too; only your distance to the venue goes on-chain. Tracking starts when you enter Code 1, ends with the end-of-day payment, and you can stop it any time.",
              )}
            </div>
            <AsyncButton
              className="btn ok"
              onClick={() =>
                run(L("Şartları onayladın. Artık oran değiştirilemez.", "You accepted the terms. Shares can no longer change."), async () => {
                  await ensureReady(signer); // ödemeyi alabilmek için USDC trustline
                  await askFieldPermissions();
                  return acceptJob(signer, job.id);
                })
              }
            >
              {L("Payımı ve şartları onayla", "Accept my share and the terms")} · {pct(myStake.share_bps / 100)}
            </AsyncButton>
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
              {L("Parayı escrow'a kilitle", "Lock the money in escrow")} · {total} USDC
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

      {signer && job.status === JobStatus.Funded && isContractor && <ContractorPanel job={job} signer={signer} run={run} />}
      {job.status === JobStatus.Funded && isClient && job.commitments.length === 0 && (
        <div className="callout warn small" style={{ marginTop: 12 }}>
          {L("İhaleci saha kodlarını henüz oluşturmadı; çalışanlar Kod 1'i alamaz.", "The contractor hasn't created the on-site codes yet; workers can't get Code 1.")}
        </div>
      )}
      {signer && job.status === JobStatus.Funded && isWorker && myStake && <WorkerPanel job={job} me={myStake} signer={signer} run={run} venue={venue} />}
      {signer && job.status === JobStatus.Funded && isArbiter && <ArbiterPanel job={job} signer={signer} run={run} />}
      {signer && isArbiter && job.stakeholders.some((s) => s.disputed) && <DisputePanel job={job} signer={signer} run={run} />}

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
              `İşveren kapatmazsa ${deadline.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} sonrasında herkes dağıtımı başlatabilir: Kod 1'i girmiş (işe gelmiş) çalışanlar payını alır, hiç gelmeyenlerin payı hakem kararıyla işverene döner.`,
              `If the employer doesn't close the job, anyone can start the payout after ${deadline.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}: workers who entered Code 1 get their share, and no-shows' shares go back to the employer by the arbiter's decision.`,
            )}
          </div>
        )}
        {job.status === JobStatus.Completed && myStake && myStake.released && (
          <div className="callout ok">
            {L(
              `${fromUnits(netOfTwFee(myStake.paid))} USDC hesabına geçti (Trustless Work %0,3 protokol ücreti düşülerek).`,
              `${fromUnits(netOfTwFee(myStake.paid))} USDC reached your account (after the 0.3% Trustless Work protocol fee).`,
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

/** Paydaş satırındaki durum rozeti; zincirde bir işlemi varsa ona linklenir */
function Chip({ state, tx, title, children }: { state: "paid" | "open" | "disputed"; tx?: string; title?: string; children: React.ReactNode }) {
  const icon = state === "paid" ? <Check size={13} strokeWidth={3} /> : state === "disputed" ? <Gavel size={13} /> : <Circle size={11} />;
  return tx ? (
    <a className={`tranche ${state}`} href={`https://stellar.expert/explorer/testnet/tx/${tx}`} target="_blank" rel="noreferrer" title={`${title ?? ""} · ${L("zincirdeki işlemi gör", "view on-chain transaction")}`}>
      {icon}
      {children} ↗
    </a>
  ) : (
    <span className={`tranche ${state}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

/**
 * Jüri: "kontratı her aşamada görmek istiyoruz". Her aşamada kontrat adresi, o aşamada çağrılabilen
 * fonksiyonlar (kimin çağırdığıyla) ve zincirdeki son çağrı gösterilir.
 */
function ContractStage({ job, last }: { job: Job; last: string | undefined }) {
  const W = L("çalışan", "worker");
  const C = L("işveren", "employer");
  const K = L("ihaleci", "contractor");
  const A = L("hakem", "arbiter");
  const ANY = L("herkes", "anyone");
  const fns: [string, string][] =
    job.status === JobStatus.PendingApproval
      ? [["accept_job(job_id, worker)", W]]
      : job.status === JobStatus.Approved
        ? [["deposit(job_id)", `${C} · ${L("tüm bedeli escrow'a kilitler, kapora değil", "locks the full amount in escrow, not a down payment")}`]]
        : job.status === JobStatus.Funded
          ? [
              ...(job.commitments.length === 0 ? [["set_codes(job_id, commitments)", K] as [string, string]] : []),
              ["check_in(job_id, worker, code)", W],
              ["confirm_presence_all(job_id, absent)", K],
              ["claim(job_id, worker, code)", W],
              ["submit_location(job_id, worker, distance_m, hash)", W],
              ["arbiter_confirm_arrival(job_id, worker)", A],
              ["arbiter_release(job_id, worker)", A],
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

/** İşin zincirdeki tüm adımları, her biri kendi işlemine ve kontrat çağrısına linkli */
function ChainLog({ job, activity }: { job: Job; activity: Activity[] | null }) {
  const { nameOf } = useApp();
  const describe = (a: Activity): string => {
    const who = a.worker ? nameOf(a.worker) : "";
    const amount = typeof a.data.amount === "bigint" ? `${fromUnits(a.data.amount)} USDC` : "";
    const byArbiter = a.data.by_arbiter ? L(" · hakem kararıyla", " · by the arbiter") : "";
    switch (a.kind) {
      case "job_created":
        return L("İş zincire yazıldı · Trustless Work escrow'u açıldı", "Job written on-chain · Trustless Work escrow opened");
      case "job_accepted":
        return L(`${who} payını onayladı`, `${who} accepted their share`);
      case "job_funded":
        return L(`${amount} escrow'a kilitlendi`, `${amount} locked in escrow`);
      case "codes_set":
        return L("İhaleci saha kodlarını oluşturdu (zincirde yalnızca sha256 özetleri)", "The contractor created the on-site codes (only sha256 hashes on-chain)");
      case "checked_in":
        return L(`${who} · Kod 1 · işe geldi${byArbiter}`, `${who} · Code 1 · arrived${byArbiter}`);
      case "payment_released":
        return L(`${who} · gün sonu ödemesi · ${amount}${byArbiter}`, `${who} · end-of-day payment · ${amount}${byArbiter}`);
      case "presence_checked":
        return a.data.present
          ? L(`Kod 2 · ${who} çalışıyor`, `Code 2 · ${who} is working`)
          : L(`Kod 2 · ihaleci bildirdi: ${who} çalışmıyor`, `Code 2 · contractor reported ${who} is not working`);
      case "location_submitted":
        return L(`${who} konum kanıtı · etkinliğe ${a.data.distance_m} m`, `${who} location proof · ${a.data.distance_m} m from the venue`);
      case "alert_raised":
        return Number(a.data.kind) === ALERT_LEFT_AREA
          ? L(`Uyarı · ${who} etkinlik alanından çıktı`, `Alert · ${who} left the venue`)
          : L(`Uyarı · ${who} çalışmıyor`, `Alert · ${who} is not working`);
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
            "Bu işin adımları RPC'nin ~11 saatlik event penceresinin dışında. Escrow linki ve kontrat yine doğrulanabilir.",
            "This job's steps are outside the RPC's ~11-hour event window. The escrow link and the contract can still be verified.",
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

/**
 * İhaleci saha paneli: kodları üretir, Kod 1'i okunacak şekilde gösterir, gün sonu QR'ını okutur,
 * Kod 2 yoklamasını yapar. Kodlar zincire değil yalnızca bu cihaza yazılır.
 */
function ContractorPanel({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const codes = loadCodes(job.id);
  const [open, setOpen] = useState<{ idx: number; kind: number } | null>(null);
  const workers = job.stakeholders.map((s, idx) => ({ s, idx })).filter(({ s }) => s.address !== job.contractor);
  const openItem = open && workers.find((w) => w.idx === open.idx);
  const ready = job.commitments.length > 0;

  // Kod 2 · yoklama penceresi: çalışma saatlerinin tam ortasında açılır, 15 dakika açık kalır.
  const { from, to } = presenceWindow(job);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const windowOpen = now >= from && now < to;
  const notYet = now < from;
  const roster = workers.filter(({ s }) => !s.released && !s.disputed);
  const answered = roster.length > 0 && roster.every(({ s }) => s.checks > 0 || !!lastAlert(job, s.address, ALERT_REPORTED_ABSENT));
  const [absent, setAbsent] = useState<string[]>([]);

  // Pencere açılınca ihaleciye tek bildirim gider
  const notified = useRef(false);
  useEffect(() => {
    if (!windowOpen || answered || notified.current) return;
    notified.current = true;
    notify(L("Kod 2 · yoklama zamanı", "Code 2 · roll-call time"), L("Çalışanlar iş yerinde ve çalışıyor mu? Yanıtlamak için 15 dakikan var.", "Are the workers on site and working? You have 15 minutes to answer."));
  }, [windowOpen, answered]);

  const answerPresence = () =>
    run(
      absent.length === 0
        ? L("Yoklama kaydedildi · herkes çalışıyor", "Roll call recorded · everyone is working")
        : L(`${absent.length} çalışana "çalışmıyor" bildirimi gönderildi`, `${absent.length} worker(s) notified they're marked as not working`),
      () => confirmPresenceAll(signer, job.id, absent),
    );

  const create = async () => {
    const { codes: fresh, commitments } = await makeCodes(job.stakeholders.length);
    saveCodes(job.id, fresh); // tx'ten önce kaydedilir ki kod kaybolmasın
    await run(L("Saha kodları hazır · yalnızca bu cihazda duruyor", "On-site codes ready · they stay on this device only"), () => setCodes(signer, job.id, commitments));
  };

  return (
    <div className="panel">
      <div className="panel-title">
        <QrCode size={17} /> {L("Saha kontrolü · kodları çalışana sen verirsin", "On-site control · you hand the codes to the workers")}
      </div>

      {!ready && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small muted">
            {L(
              "Para kilitlendi. Şimdi her çalışan için Kod 1 ve gün sonu QR'ını oluştur: zincire yalnızca kodların sha256 özeti yazılır, kodların kendisi bu cihazdan çıkmaz.",
              "The money is locked. Now create Code 1 and the end-of-day QR for each worker: only the sha256 hashes go on-chain, the codes themselves never leave this device.",
            )}
          </div>
          <AsyncButton className="btn" onClick={create}>
            <KeyRound size={16} /> {L("Saha kodlarını oluştur", "Create on-site codes")}
          </AsyncButton>
        </div>
      )}

      {ready && !codes && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="callout warn small">
            {L(
              "Kodlar başka bir cihazda oluşturulmuş, burada yok. Yenilerini oluşturursan eski kodlar geçersiz olur; ödenmiş paylar etkilenmez.",
              "The codes were created on another device and aren't here. Creating new ones invalidates the old codes; paid shares are not affected.",
            )}
          </div>
          <AsyncButton className="btn secondary sm" onClick={create}>
            {L("Kodları bu cihazda yenile", "Recreate codes on this device")}
          </AsyncButton>
        </div>
      )}

      {ready && roster.length > 0 && (
        <div className={`callout ${windowOpen && !answered ? "warn" : ""}`} style={{ marginTop: 4 }}>
          {notYet && (
            <span className="small row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Bell size={15} style={{ flex: "none", marginTop: 2 }} />
              <span>
                {L(
                  `Kod 2 · yoklama çalışma süresinin tam ortasında, ${clock(from)} itibarıyla sana bildirim olarak gelecek ve 15 dakika açık kalacak.`,
                  `Code 2 · roll call will reach you as a notification in the middle of the shift, at ${clock(from)}, and stay open for 15 minutes.`,
                )}
              </span>
            </span>
          )}
          {answered && (
            <span className="small row" style={{ gap: 6 }}>
              <Check size={15} /> {L("Kod 2 yoklaması yapıldı.", "Code 2 roll call done.")}
            </span>
          )}
          {!notYet && !windowOpen && !answered && (
            <span className="small">{L("Kod 2 yoklama penceresi kapandı; bu iş için yoklama yapılmadı.", "The Code 2 window has closed; no roll call was taken for this job.")}</span>
          )}
          {windowOpen && !answered && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row">
                <Bell size={16} />
                <b>{L("Kod 2 · yoklama zamanı", "Code 2 · roll-call time")}</b>
                <span className="muted small">{L("Çalışanlar iş yerinde ve çalışıyor mu?", "Are the workers on site and working?")}</span>
                <div className="spacer" />
                <span className="badge warn">{L(`${mmss(to - now)} kaldı`, `${mmss(to - now)} left`)}</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {roster.map(({ s }) => (
                  <label key={s.address} className="row small" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={absent.includes(s.address)}
                      onChange={(e) => setAbsent((prev) => (e.target.checked ? [...prev, s.address] : prev.filter((a) => a !== s.address)))}
                    />
                    <b>{nameOf(s.address)}</b> {L("çalışmıyor", "is not working")}
                  </label>
                ))}
              </div>
              <AsyncButton className={absent.length ? "btn secondary" : "btn ok"} onClick={answerPresence}>
                <Users size={16} />{" "}
                {absent.length === 0
                  ? L(`Hepsi çalışıyor · ${roster.length} kişi`, `Everyone is working · ${roster.length}`)
                  : L(`${absent.length} kişiye "çalışmıyor" bildirimi gönder`, `Notify ${absent.length} as not working`)}
              </AsyncButton>
              <span className="small muted">
                {L(
                  "Bu adım para hareket ettirmez. İşaretlediğin çalışanlara anında \"ihaleci çalışmadığını söylüyor\" bildirimi gider.",
                  "This step moves no money. The workers you mark get an instant \"the contractor says you're not working\" notice.",
                )}
              </span>
            </div>
          )}
        </div>
      )}

      {ready &&
        workers.map(({ s, idx }) => {
          const left = lastAlert(job, s.address, ALERT_LEFT_AREA);
          const absentAlert = lastAlert(job, s.address, ALERT_REPORTED_ABSENT);
          return (
            <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn secondary sm" disabled={!codes || s.arrived} onClick={() => setOpen({ idx, kind: CODE_ARRIVAL })}>
                    {s.arrived ? <Check size={14} /> : <KeyRound size={14} />} {s.arrived ? L("Kod 1 girildi", "Code 1 entered") : L("Kod 1'i göster", "Show Code 1")}
                  </button>
                  <button className="btn secondary sm" disabled={!codes || s.released || s.disputed} onClick={() => setOpen({ idx, kind: CODE_FINAL })}>
                    {s.released ? <Check size={14} /> : <QrCode size={14} />} {s.released ? L("Ödendi", "Paid") : L("Gün sonu QR'ı", "End-of-day QR")}
                  </button>
                </span>
              </div>

              {s.checks > 0 && (
                <span className="small muted row" style={{ gap: 4 }}>
                  <Check size={14} /> {L("Kod 2 · çalışıyor olarak işaretlendi", "Code 2 · marked as working")}
                </span>
              )}
              {absentAlert && (
                <div className="small row" role="status" style={{ gap: 6 }}>
                  <Bell size={14} /> {hhmm(absentAlert.timestamp)} · {L("\"çalışmıyor\" bildirimi bu çalışana gönderildi.", "a \"not working\" notice was sent to this worker.")}
                </div>
              )}

              {left && !s.released && (
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

      {open && openItem && codes && open.kind === CODE_ARRIVAL && (
        <Modal title={`${L("Kod 1", "Code 1")} · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <div className="code-big">{formatCode(codes[openItem.idx * CODES + CODE_ARRIVAL])}</div>
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            {L(
              "Bu kodu çalışana yüz yüze söyle; uygulamasına yazınca işe geldiği zincire yazılır. Kod 1 para ödemez, ödeme gün sonu QR'ında yapılır.",
              "Tell this code to the worker in person; when they type it in, their arrival is written on-chain. Code 1 pays nothing; payment happens at the end-of-day QR.",
            )}
          </p>
        </Modal>
      )}

      {open && openItem && codes && open.kind === CODE_FINAL && (
        <Modal title={`${L("Gün sonu QR'ı", "End-of-day QR")} · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <QrImage text={encodeQr({ jobId: job.id, worker: openItem.s.address, secret: codes[openItem.idx * CODES + CODE_FINAL] })} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            {L(
              `Çalışan bu QR'ı okutunca payının tamamı (${fromUnits(shareOf(job, openItem.s))} USDC) anında hesabına geçer. Yalnızca iş bittiğinde ve çalışan karşındayken göster.`,
              `When the worker scans this QR, their full share (${fromUnits(shareOf(job, openItem.s))} USDC) reaches their account instantly. Only show it when the job is done and the worker is in front of you.`,
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}

/** Kod 1'den gün sonu ödemesine kadar konum takibi: cihazda yapılır, yalnızca alandan çıkış zincire yazılır */
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
  // Kod 1 girilir girilmez kendiliğinden başlar (izin onay adımında istenmişti); istenirse durdurulabilir.
  const [on, setOn] = useState(true);
  const [dist, setDist] = useState<number | null>(null);
  const inside = useRef<boolean | null>(null);
  const radius = job.terms.radius_m;

  const report = useCallback(
    (d: number, lat: number, lng: number) =>
      run(L(`Alandan çıkış ihaleciye bildirildi (${d} m)`, `Leaving the venue was reported to the contractor (${d} m)`), async () => {
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
        <MapPin size={17} /> {L("Konum takibi · Kod 1'den gün sonu ödemesine kadar", "Location tracking · from Code 1 to the end-of-day payment")} ·{" "}
        {on ? L("açık", "on") : L("durduruldu", "stopped")}
      </div>
      <div className="small muted">
        {L(
          `Kod 1'i girdiğin anda otomatik başladı. Konumun yalnızca bu cihazda işlenir; etkinlik alanından (${radius} m) çıkarsan zincire sadece mesafe yazılır ve ihaleciye bildirim gider. Ham koordinatların hiçbir yere gönderilmez.`,
          `Started automatically when you entered Code 1. Your location is processed on this device only; if you leave the venue (${radius} m), only the distance goes on-chain and the contractor is notified. Your raw coordinates are never sent anywhere.`,
        )}
      </div>
      <div className="row">
        <button className={on ? "btn secondary sm" : "btn sm"} onClick={() => setOn(!on)}>
          {on ? L("Takibi durdur", "Stop tracking") : L("Takibi başlat", "Start tracking")}
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
  const [typed, setTyped] = useState("");
  const [pos, setPos] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const idx = job.stakeholders.findIndex((s) => s.address === me.address);
  const camSupport = cameraSupport(); // https/localhost değilse kamera hiç açılmaz, önceden söyle
  const demoCodes = loadCodes(job.id); // yalnızca aynı tarayıcıda ihaleci rolü de oynanıyorsa (demo)
  const myProofs = job.locations.filter((l) => l.worker === me.address);
  const absent = lastAlert(job, me.address, ALERT_REPORTED_ABSENT);

  /** Kod 1: ihalecinin elden verdiği kod. Para hareket etmez. */
  const applyTyped = async () => {
    const code = normalizeCode(typed);
    if (!code) return toast("err", L(`Kod ${CODE_LENGTH} karakter olmalı · ör. K7M2-QX9F-4B3T`, `The code must be ${CODE_LENGTH} characters · e.g. K7M2-QX9F-4B3T`));
    setProcessing(L("Kod 1", "Code 1"));
    try {
      if (await run(L("Kod 1 doğrulandı · işe geldiğin zincire yazıldı", "Code 1 verified · your arrival is written on-chain"), () => checkIn(signer, job.id, code))) setTyped("");
    } finally {
      setProcessing(null);
    }
  };

  /** Gün sonu QR'ı: payın tamamı ödenir. */
  const applyQr = async (text: string) => {
    const p = decodeQr(text);
    if (!p) return toast("err", L("Bu bir Ek İşler gün sonu QR'ı değil", "This is not an Ek İşler end-of-day QR"));
    if (p.jobId !== job.id) return toast("err", L(`Bu QR başka bir işe ait (#${p.jobId})`, `This QR belongs to another job (#${p.jobId})`));
    if (p.worker !== me.address) return toast("err", L("Bu QR başka bir çalışan için üretilmiş", "This QR was issued for another worker"));
    setScanning(false);
    setProcessing(L("Gün sonu ödemesi", "End-of-day payment"));
    try {
      await run(L("Ödemenin tamamı hesabına geçti", "Your full payment reached your account"), () => claimPayment(signer, job.id, p.secret));
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

  if (me.released)
    return (
      <div className="callout ok" style={{ marginTop: 14 }}>
        {L("Payının tamamı ödendi.", "Your full share has been paid.")}
      </div>
    );
  if (me.disputed)
    return (
      <div className="callout err" style={{ marginTop: 14 }}>
        {L("Payın hakemin kararını bekliyor.", "Your share is waiting for the arbiter's decision.")}
      </div>
    );

  return (
    <div className="panel">
      {absent && (
        <div className="callout err small row" role="alert" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <Bell size={16} style={{ flex: "none", marginTop: 2 }} />
          <span>
            {L(
              `${hhmm(absent.timestamp)} · İhaleci, Kod 2 yoklamasında çalışmadığını söyledi. Oradaysan ihaleciyle konuş ya da aşağıdan konum kanıtı gönder; karar hakemde. Bu bildirim tek başına ödemeni durdurmaz.`,
              `${hhmm(absent.timestamp)} · In the Code 2 roll call the contractor said you're not working. If you're there, talk to the contractor or send location proof below; the arbiter decides. This notice alone doesn't stop your payment.`,
            )}
          </span>
        </div>
      )}

      {!me.arrived ? (
        <>
          <div className="panel-title">
            <KeyRound size={17} /> {L("Kod 1 · işe geldiğini kanıtla", "Code 1 · prove you've arrived")}
          </div>
          <div className="small muted">
            {L(
              "İhaleci sahada seni görünce 12 karakterlik kodu elden verecek. Buraya yaz. Bu adım para ödemez; ödemenin tamamı iş bitince gün sonu QR'ında yapılır.",
              "When the contractor sees you on site, they'll give you a 12-character code in person. Type it here. This step pays nothing; the full payment happens at the end-of-day QR.",
            )}
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              className="code-input"
              style={{ flex: 1 }}
              placeholder="K7M2-QX9F-4B3T"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !processing && typed) applyTyped();
              }}
              aria-label={L("İhalecinin verdiği Kod 1", "Code 1 from the contractor")}
            />
            <AsyncButton className="btn" disabled={!!processing || !typed} onClick={applyTyped}>
              {L("Onayla", "Confirm")}
            </AsyncButton>
          </div>
          {demoCodes && (
            <button
              className="btn ghost sm"
              title={L("Demo: ihaleci rolü aynı tarayıcıda oynandığı için kod bu cihazda duruyor", "Demo: the contractor role is played in this browser, so the code is on this device")}
              onClick={() => setTyped(formatCode(demoCodes[idx * CODES + CODE_ARRIVAL]))}
            >
              {L("Demo: ihalecinin verdiği Kod 1'i yapıştır", "Demo: paste the contractor's Code 1")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="panel-title">
            <ScanLine size={17} /> {L("Gün sonu QR'ı · payının tamamı", "End-of-day QR · your full share")} {fromUnits(shareOf(job, me))} USDC
          </div>
          <div className="small muted">
            {L(
              "İşe geldiğin zincire yazıldı. İş bitince ihaleci gün sonu QR'ını gösterecek; okuttuğun anda payının tamamı hesabına geçer.",
              "Your arrival is on-chain. When the job is done the contractor will show the end-of-day QR; scan it and your full share reaches your account.",
            )}
          </div>
          {camSupport !== "ok" && (
            <div className="callout warn small row" style={{ flexWrap: "nowrap" }}>
              <TriangleAlert size={16} style={{ flex: "none" }} />
              <span>
                {cameraMessage(camSupport)} {L("QR metnini okutma penceresinden elle yapıştırabilirsin.", "You can paste the QR text in the scan window.")}
              </span>
            </div>
          )}
          <div className="row">
            <button className="btn" disabled={!!processing} onClick={() => setScanning(true)}>
              <ScanLine size={17} /> {L("Gün sonu QR'ını okut", "Scan the end-of-day QR")}
            </button>
            {demoCodes && (
              <AsyncButton
                className="btn ghost sm"
                title={L("Demo: ihaleci rolü aynı tarayıcıda oynandığı için QR içeriği bu cihazda duruyor", "Demo: the contractor role is played in this browser, so the QR content is on this device")}
                onClick={() => applyQr(encodeQr({ jobId: job.id, worker: me.address, secret: demoCodes[idx * CODES + CODE_FINAL] }))}
              >
                {L("Demo: ihalecinin gün sonu QR'ı", "Demo: the contractor's end-of-day QR")}
              </AsyncButton>
            )}
          </div>
        </>
      )}

      {processing && (
        <div className="callout row" role="status">
          <span className="spinner" /> {processing} · {L("işleniyor…", "processing…")}
        </div>
      )}

      {me.arrived ? (
        <LocationTracker job={job} me={me} signer={signer} run={run} venue={venue} />
      ) : (
        <>
          <div className="panel-title" style={{ marginTop: 8 }}>
            <MapPin size={17} />{" "}
            {L("İhaleci Kod 1'i vermiyor mu? Konumunu kanıt olarak kaydet, hakem seni gelmiş işaretlesin.", "Contractor not giving you Code 1? Record your location as proof so the arbiter can mark you as arrived.")}
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
        <Modal title={L("Gün sonu QR'ını okut", "Scan the end-of-day QR")} onClose={() => setScanning(false)}>
          <QrScanner onResult={applyQr} />
        </Modal>
      )}
    </div>
  );
}

/** Hakem: konum kanıtlarına bakıp çalışanı gelmiş işaretler ya da payını doğrudan serbest bıraktırır. */
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
        const inside = last.distance_m <= job.terms.radius_m;
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className={`badge ${inside ? "ok" : "err"}`}>
                {last.distance_m} m · {inside ? L("etkinlik alanında", "at the venue") : L("alan dışında", "outside the venue")}
              </span>
            </div>
            <div className="small muted">
              {L(
                `${proofs.length} kanıt · son ${new Date(Number(last.timestamp) * 1000).toLocaleString("tr-TR")} · ham koordinat zincirde yok, gerekirse çalışandan istenip hash'le doğrulanır`,
                `${proofs.length} proofs · last ${new Date(Number(last.timestamp) * 1000).toLocaleString("en-GB")} · raw coordinates are not on-chain; if needed, ask the worker and check them against the hash`,
              )}
            </div>
            <div className="row">
              {!s.arrived && (
                <AsyncButton
                  className="btn sm"
                  title={L("Para hareket etmez: çalışan son tarih ödemesine dahil olur", "Moves no money: the worker is included in the deadline payout")}
                  onClick={() => run(L(`${nameOf(s.address)} gelmiş olarak işaretlendi`, `${nameOf(s.address)} marked as arrived`), () => arbiterConfirmArrival(signer, job.id, s.address))}
                >
                  {L("Gelmiş olarak işaretle", "Mark as arrived")}
                </AsyncButton>
              )}
              {s.arrived && !s.released && !s.disputed && (
                <AsyncButton
                  className="btn secondary sm"
                  onClick={() => run(L(`${nameOf(s.address)} payı hakem kararıyla ödendi`, `${nameOf(s.address)}'s share paid by the arbiter's decision`), () => arbiterRelease(signer, job.id, s.address))}
                >
                  {L("Payı serbest bırak", "Release the share")} · {fromUnits(shareOf(job, s))} USDC
                </AsyncButton>
              )}
              {s.released && (
                <span className="badge ok">
                  <Check size={13} /> {L("ödendi", "paid")}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Hakem: Trustless Work'te dispute'a alınmış payları (ör. hiç gelmeyen çalışan) işverene iade eder */
function DisputePanel({ job, signer, run }: { job: Job; signer: Signer; run: ReturnType<typeof useRun> }) {
  const { nameOf } = useApp();
  const [escrow, setEscrow] = useState<TwEscrow | null>(null);
  const load = useCallback(() => getEscrow(job.escrow).then(setEscrow).catch(() => setEscrow(null)), [job.escrow]);
  useEffect(() => {
    load();
  }, [load, job]);

  const open = (escrow?.milestones ?? []).map((m, index) => ({ m, index })).filter(({ m }) => m.flags.disputed && !m.flags.resolved && !m.flags.released);
  const label = (d: string) => ({ ihaleci: L("İhaleci payı", "Contractor's share"), pay: L("Çalışan payı", "Worker's share") })[d] ?? d;
  const total = open.reduce((a, { m }) => a + m.amount, 0n);

  return (
    <div className="panel">
      <div className="panel-title">
        <Gavel size={17} /> {L("Trustless Work dispute'ları · karar hakemde", "Trustless Work disputes · the arbiter decides")}
      </div>
      {!escrow && <div className="small muted">{L("Escrow okunuyor…", "Reading escrow…")}</div>}
      {escrow && open.length === 0 && <div className="small muted">{L("Açık dispute yok, hepsi çözüldü.", "No open disputes, all resolved.")}</div>}
      {open.length > 1 && (
        <AsyncButton
          className="btn"
          onClick={async () => {
            for (const { m, index } of open) {
              if (!(await run(L(`${label(m.description)} işverene iade edildi`, `${label(m.description)} refunded to the employer`), () => resolveToClient(signer, job, index, m.amount)))) break;
            }
            await load();
          }}
        >
          {L("Tümünü işverene iade et", "Refund all to the employer")} · {fromUnits(total)} USDC
        </AsyncButton>
      )}
      {open.map(({ m, index }) => (
        <div key={index} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <b>{nameOf(m.receiver)}</b> · {label(m.description)} · {fromUnits(m.amount)} USDC
          </span>
          <AsyncButton
            className="btn sm"
            onClick={async () => {
              await run(L("Dispute çözüldü, tutar işverene iade edildi", "Dispute resolved, amount refunded to the employer"), () => resolveToClient(signer, job, index, m.amount));
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
