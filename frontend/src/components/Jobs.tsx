import { useCallback, useEffect, useRef, useState } from "react";
import { twViewer } from "../lib/config.ts";
import { useApp } from "../app-context.tsx";
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
  STATUS_LABEL,
  submitLocation,
  type Job,
  type Stakeholder,
  type TwEscrow,
} from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import type { Signer } from "../lib/signer.ts";
import { Modal, QrImage, QrScanner } from "./Qr.tsx";
import { AsyncButton, useToast } from "./ui.tsx";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

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
        <h1>Para aracıda değil, akıllı sözleşmede.</h1>
        <p>
          <b>Kod 1:</b> çalışan sahaya gelince ihaleci kodu elden verir, çalışan girer ve zincire "geldi" yazılır. <b>Kod 2:</b>{" "}
          çalışma süresinin tam ortasında ihaleciye bildirim gider, 15 dakika içinde çalışmayanları işaretler; işaretlenen çalışana
          anında bildirim gider. <b>Gün sonu QR'ı:</b> iş bitince okutulur ve çalışanın payının tamamı ödenir. İlk iki adım para
          hareket ettirmez. Para her an Trustless Work escrow'unda durur.
        </p>
      </div>
      <div className="row">
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
          Sadece aktif hesabın dahil olduğu işler
        </label>
        <div className="spacer" />
        <AsyncButton className="btn secondary sm" onClick={load}>
          Yenile
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
const hhmm = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const lastAlert = (job: Job, worker: string, kind: number) =>
  [...job.alerts].reverse().find((a) => a.worker === worker && a.kind === kind);

/** Onay adımında konum ve bildirim izinlerini önceden ister; reddedilse de akışı engellemez. */
async function askFieldPermissions() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
  } catch {
    /* tarayıcı bildirim desteklemiyor */
  }
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
        notify("Çalışmıyorsun deniyor", "İhaleci, şu an iş yerinde çalışmadığını söylüyor.");
      } else if (a.kind === ALERT_LEFT_AREA && isContractor) {
        notify("Çalışan alandan çıktı", `${nameOf(a.worker)} etkinlik alanından ${a.distance_m} m uzaklaştı.`);
      }
    });
  }, [job, me, isContractor, nameOf]);

  const currentStep =
    job.status === JobStatus.PendingApproval ? 1 : job.status === JobStatus.Approved ? 2 : job.status === JobStatus.Funded ? 3 : 4;

  const clientUsdc = isClient && balances?.usdc != null ? Number(balances.usdc) : null;
  const insufficient = clientUsdc !== null && clientUsdc < Number(fromUnits(t.total_amount, 7));

  const lock = async () => {
    if (!signer) return;
    await run(`${total} USDC Trustless Work escrow'una kilitlendi`, () => depositJob(signer, job.id));
  };

  return (
    <article className="card">
      <div className="job-head">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">İş #{String(job.id)}</span>
            <span
              className={`badge ${
                job.status === JobStatus.Completed ? "ok" : job.status === JobStatus.Refunded ? "err" : job.status === JobStatus.Funded ? "primary" : "warn"
              }`}
            >
              {STATUS_LABEL[job.status]}
            </span>
            {isClient && <span className="badge">İşverensin</span>}
            {isContractor && <span className="badge">İhalecisin</span>}
            {isWorker && <span className="badge">Çalışansın</span>}
            {isArbiter && <span className="badge">Hakemsin</span>}
          </div>
          <div className="job-amount">{total} USDC</div>
          {tryPerUsdc && <div className="small muted">≈ ₺{(Number(total) * tryPerUsdc).toLocaleString("tr-TR", { maximumFractionDigits: 0 })}</div>}
        </div>
        <div className="small" style={{ textAlign: "right" }}>
          <div className="muted">İşveren</div>
          <div style={{ fontWeight: 600 }}>{nameOf(t.client)}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            Son tarih
          </div>
          <div style={{ fontWeight: 600 }}>
            {deadline.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}
            {deadlinePassed && job.status === JobStatus.Funded && <span className="badge warn" style={{ marginLeft: 6 }}>doldu</span>}
          </div>
        </div>
      </div>

      <div className="row small" style={{ gap: 8, marginTop: 10 }}>
        <span className="badge">Ödeme: gün sonu QR'ında, tamamı</span>
        <span className="badge" title="Kod 2 yoklaması bu aralığın tam ortasında 15 dakikalığına açılır">
          🕒 {new Date(Number(t.work_start) * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}–
          {new Date(Number(t.work_end) * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <a
          className="badge"
          href={`https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=17/${venue.lat}/${venue.lng}`}
          target="_blank"
          rel="noreferrer"
        >
          📍 Etkinlik noktası · {t.radius_m} m
        </a>
        <span className="badge">Hakem: {nameOf(t.arbiter)}</span>
        <a className="badge primary" href={twViewer(job.escrow)} target="_blank" rel="noreferrer" title="Para Ek İşler'de değil, bu işin Trustless Work escrow'unda duruyor">
          🔒 Trustless Work escrow ↗
        </a>
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
                <div style={{ fontWeight: 600 }}>
                  {nameOf(s.address)}
                  {contractorRow && <span className="muted small"> · ihaleci</span>}
                </div>
                <div className="small muted">
                  %{(s.share_bps / 100).toLocaleString("tr-TR")} · {fromUnits(shareOf(job, s))} USDC
                </div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                {!contractorRow && (
                  <span className={`badge ${s.arrived ? "ok" : ""}`} title="Kod 1 girildi mi? Para hareket ettirmez.">
                    {s.arrived ? "✓ geldi" : "gelmedi"}
                  </span>
                )}
                {!contractorRow && s.checks > 0 && (
                  <span className="badge" title="Kod 2 yoklaması kaç kez yapıldı">
                    {s.checks} yoklama
                  </span>
                )}
                <span className={`badge ${s.released ? "ok" : s.disputed ? "err" : ""}`}>
                  {s.released ? "✓ ödendi" : s.disputed ? "⚖️ hakemde" : "ödenmedi"}
                </span>
              </div>
              <div>{s.accepted ? <span className="badge ok">✓ onayladı</span> : <span className="badge warn">bekliyor</span>}</div>
            </div>
          );
        })}
      </div>

      <div className="job-actions">
        {signer && job.status === JobStatus.PendingApproval && myStake && !myStake.accepted && (
          <>
            <div className="callout small">
              Onaylayınca tarayıcı <b>konum</b> ve <b>bildirim</b> izni isteyecek. Konumun yalnızca kendi cihazında işlenir; zincire
              sadece etkinlik noktasına uzaklığın yazılır, ham koordinatın hiçbir yere gönderilmez. Takip Kod 1'i girdiğin anda
              başlar, gün sonu ödemesiyle biter ve istediğin an durdurabilirsin.
            </div>
            <AsyncButton
              className="btn ok"
              onClick={() =>
                run("Şartları onayladın. Artık oran değiştirilemez.", async () => {
                  await ensureReady(signer); // ödemeyi alabilmek için USDC trustline
                  await askFieldPermissions();
                  return acceptJob(signer, job.id);
                })
              }
            >
              Payımı ve şartları onayla · %{myStake.share_bps / 100}
            </AsyncButton>
          </>
        )}
        {job.status === JobStatus.PendingApproval && isClient && (
          <div className="callout">Tüm çalışanlar payını onaylayınca parayı kilitleyebileceksin. Böylece gizli oran değişikliği yapılamaz.</div>
        )}

        {signer && job.status === JobStatus.Approved && isClient && (
          <>
            <AsyncButton className="btn" disabled={insufficient} onClick={lock}>
              Parayı escrow'a kilitle · {total} USDC
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

      {signer && job.status === JobStatus.Funded && isContractor && <ContractorPanel job={job} signer={signer} run={run} />}
      {job.status === JobStatus.Funded && isClient && job.commitments.length === 0 && (
        <div className="callout warn small">İhaleci saha kodlarını henüz oluşturmadı; çalışanlar Kod 1'i alamaz.</div>
      )}
      {signer && job.status === JobStatus.Funded && isWorker && myStake && (
        <WorkerPanel job={job} me={myStake} signer={signer} run={run} venue={venue} />
      )}
      {signer && job.status === JobStatus.Funded && isArbiter && <ArbiterPanel job={job} signer={signer} run={run} />}
      {signer && isArbiter && job.stakeholders.some((s) => s.disputed) && <DisputePanel job={job} signer={signer} run={run} />}

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
            başlatabilir: Kod 1'i girmiş (işe gelmiş) çalışanlar payını alır, hiç gelmeyenlerin payı hakem kararıyla işverene döner.
          </div>
        )}
        {job.status === JobStatus.Completed && myStake && myStake.released && (
          <div className="callout ok">
            {fromUnits(netOfTwFee(myStake.paid))} USDC hesabına geçti (Trustless Work %0,3 protokol ücreti düşülerek).{" "}
            <button className="btn ghost sm" onClick={() => goTo("ramp")}>
              TL olarak IBAN'a çek →
            </button>
          </div>
        )}
      </div>
    </article>
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
  const answered =
    roster.length > 0 && roster.every(({ s }) => s.checks > 0 || !!lastAlert(job, s.address, ALERT_REPORTED_ABSENT));
  const [absent, setAbsent] = useState<string[]>([]);

  // Pencere açılınca ihaleciye tek bildirim gider
  const notified = useRef(false);
  useEffect(() => {
    if (!windowOpen || answered || notified.current) return;
    notified.current = true;
    notify("Kod 2 · yoklama zamanı", "Çalışanlar iş yerinde ve çalışıyor mu? Yanıtlamak için 15 dakikan var.");
  }, [windowOpen, answered]);

  const answerPresence = () =>
    run(
      absent.length === 0
        ? "Yoklama kaydedildi · herkes çalışıyor"
        : `${absent.length} çalışana "çalışmıyor" bildirimi gönderildi`,
      () => confirmPresenceAll(signer, job.id, absent),
    );

  const create = async () => {
    const { codes: fresh, commitments } = await makeCodes(job.stakeholders.length);
    saveCodes(job.id, fresh); // tx'ten önce kaydedilir ki kod kaybolmasın
    await run("Saha kodları hazır · yalnızca bu cihazda duruyor", () => setCodes(signer, job.id, commitments));
  };

  return (
    <div className="panel">
      <div className="panel-title">📱 Saha kontrolü · kodları çalışana sen verirsin</div>

      {!ready && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small muted">
            Para kilitlendi. Şimdi her çalışan için Kod 1 ve gün sonu QR'ını oluştur: zincire yalnızca kodların sha256 özeti yazılır,
            kodların kendisi bu cihazdan çıkmaz.
          </div>
          <AsyncButton className="btn" onClick={create}>
            Saha kodlarını oluştur
          </AsyncButton>
        </div>
      )}

      {ready && !codes && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="callout warn small">
            Kodlar başka bir cihazda oluşturulmuş, burada yok. Yenilerini oluşturursan eski kodlar geçersiz olur; ödenmiş paylar
            etkilenmez.
          </div>
          <AsyncButton className="btn secondary sm" onClick={create}>
            Kodları bu cihazda yenile
          </AsyncButton>
        </div>
      )}

      {ready && roster.length > 0 && (
        <div className={`callout ${windowOpen && !answered ? "warn" : ""}`} style={{ marginTop: 4 }}>
          {notYet && (
            <span className="small">
              🔔 <b>Kod 2 · yoklama</b> çalışma süresinin tam ortasında, {new Date(from).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}{" "}
              itibarıyla sana bildirim olarak gelecek ve 15 dakika açık kalacak.
            </span>
          )}
          {answered && <span className="small">✓ Kod 2 yoklaması yapıldı.</span>}
          {!notYet && !windowOpen && !answered && (
            <span className="small">Kod 2 yoklama penceresi kapandı; bu iş için yoklama yapılmadı.</span>
          )}
          {windowOpen && !answered && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row">
                <b>🔔 Kod 2 · yoklama zamanı</b>
                <span className="muted small">Çalışanlar iş yerinde ve çalışıyor mu?</span>
                <div className="spacer" />
                <span className="badge warn">{mmss(to - now)} kaldı</span>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {roster.map(({ s }) => (
                  <label key={s.address} className="row small" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={absent.includes(s.address)}
                      onChange={(e) =>
                        setAbsent((prev) => (e.target.checked ? [...prev, s.address] : prev.filter((a) => a !== s.address)))
                      }
                    />
                    <b>{nameOf(s.address)}</b> çalışmıyor
                  </label>
                ))}
              </div>
              <AsyncButton className={absent.length ? "btn secondary" : "btn ok"} onClick={answerPresence}>
                {absent.length === 0
                  ? `Hepsi çalışıyor · ${roster.length} kişi`
                  : `${absent.length} kişiye "çalışmıyor" bildirimi gönder`}
              </AsyncButton>
              <span className="small muted">
                Bu adım para hareket ettirmez. İşaretlediğin çalışanlara anında "ihaleci çalışmadığını söylüyor" bildirimi gider.
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
            <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="btn secondary sm" disabled={!codes || s.arrived} onClick={() => setOpen({ idx, kind: CODE_ARRIVAL })}>
                    {s.arrived ? "✓ Kod 1 girildi" : "Kod 1'i göster"}
                  </button>
                  <button className="btn secondary sm" disabled={!codes || s.released || s.disputed} onClick={() => setOpen({ idx, kind: CODE_FINAL })}>
                    {s.released ? "✓ Ödendi" : "Gün sonu QR'ı"}
                  </button>
                </span>
              </div>

              {s.checks > 0 && <span className="small muted">✓ Kod 2 · çalışıyor olarak işaretlendi</span>}
              {absentAlert && (
                <div className="small" role="status">
                  🔔 {hhmm(absentAlert.timestamp)} · "çalışmıyor" bildirimi bu çalışana gönderildi.
                </div>
              )}

              {left && !s.released && (
                <div className="callout warn small" role="alert">
                  ⚠️ {hhmm(left.timestamp)} · {nameOf(s.address)} etkinlik alanından çıktı (etkinliğe {left.distance_m} m)
                </div>
              )}
            </div>
          );
        })}

      {open && openItem && codes && open.kind === CODE_ARRIVAL && (
        <Modal title={`Kod 1 · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <div
            style={{ textAlign: "center", fontSize: 32, fontWeight: 800, letterSpacing: 3, margin: "8px 0 12px", fontFamily: "ui-monospace, monospace" }}
          >
            {formatCode(codes[openItem.idx * CODES + CODE_ARRIVAL])}
          </div>
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            Bu kodu çalışana <b>yüz yüze</b> söyle; uygulamasına yazınca işe geldiği zincire yazılır.
            <br />
            Kod 1 para ödemez. Ödeme gün sonu QR'ında yapılır.
          </p>
        </Modal>
      )}

      {open && openItem && codes && open.kind === CODE_FINAL && (
        <Modal title={`Gün sonu QR'ı · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <QrImage text={encodeQr({ jobId: job.id, worker: openItem.s.address, secret: codes[openItem.idx * CODES + CODE_FINAL] })} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            Çalışan bu QR'ı okutunca payının tamamı ({fromUnits(shareOf(job, openItem.s))} USDC) anında hesabına geçer.
            <br />
            Yalnızca iş bittiğinde ve çalışan karşındayken göster.
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
      run(`Alandan çıkış ihaleciye bildirildi (${d} m)`, async () => {
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
        📍 Konum takibi · Kod 1'den gün sonu ödemesine kadar {on ? "açık" : "durduruldu"}
      </div>
      <div className="small muted">
        Kod 1'i girdiğin anda otomatik başladı. Konumun yalnızca bu cihazda işlenir; etkinlik alanından ({radius} m) çıkarsan zincire
        sadece mesafe yazılır ve ihaleciye bildirim gider. Ham koordinatların hiçbir yere gönderilmez.
      </div>
      <div className="row">
        <button className={on ? "btn secondary sm" : "btn sm"} onClick={() => setOn(!on)}>
          {on ? "Takibi durdur" : "Takibi başlat"}
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
  const [typed, setTyped] = useState("");
  const [pos, setPos] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const idx = job.stakeholders.findIndex((s) => s.address === me.address);
  const demoCodes = loadCodes(job.id); // yalnızca aynı tarayıcıda ihaleci rolü de oynanıyorsa (demo)
  const myProofs = job.locations.filter((l) => l.worker === me.address);
  const absent = lastAlert(job, me.address, ALERT_REPORTED_ABSENT);

  /** Kod 1: ihalecinin elden verdiği kod. Para hareket etmez. */
  const applyTyped = async () => {
    const code = normalizeCode(typed);
    if (!code) return toast("err", `Kod ${CODE_LENGTH} karakter olmalı · ör. K7M2-QX9F-4B3T`);
    setProcessing("Kod 1");
    try {
      if (await run("Kod 1 doğrulandı · işe geldiğin zincire yazıldı", () => checkIn(signer, job.id, code))) setTyped("");
    } finally {
      setProcessing(null);
    }
  };

  /** Gün sonu QR'ı: payın tamamı ödenir. */
  const applyQr = async (text: string) => {
    const p = decodeQr(text);
    if (!p) return toast("err", "Bu bir Ek İşler gün sonu QR'ı değil");
    if (p.jobId !== job.id) return toast("err", `Bu QR başka bir işe ait (#${p.jobId})`);
    if (p.worker !== me.address) return toast("err", "Bu QR başka bir çalışan için üretilmiş");
    setScanning(false);
    setProcessing("Gün sonu ödemesi");
    try {
      await run("Ödemenin tamamı hesabına geçti", () => claimPayment(signer, job.id, p.secret));
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

  if (me.released) return <div className="callout ok" style={{ marginTop: 14 }}>Payının tamamı ödendi.</div>;
  if (me.disputed) return <div className="callout err" style={{ marginTop: 14 }}>Payın hakemin kararını bekliyor.</div>;

  return (
    <div className="panel">
      {absent && (
        <div className="callout err small" role="alert">
          🔔 {hhmm(absent.timestamp)} · İhaleci, Kod 2 yoklamasında çalışmadığını söyledi. Oradaysan ihaleciyle konuş ya da aşağıdan
          konum kanıtı gönder; karar hakemde. Bu bildirim tek başına ödemeni durdurmaz.
        </div>
      )}

      {!me.arrived ? (
        <>
          <div className="panel-title">🔑 Kod 1 · işe geldiğini kanıtla</div>
          <div className="small muted">
            İhaleci sahada seni görünce 12 karakterlik kodu elden verecek. Buraya yaz. Bu adım para ödemez; ödemenin tamamı iş
            bitince gün sonu QR'ında yapılır.
          </div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              style={{ flex: 1, fontFamily: "ui-monospace, monospace", letterSpacing: 1, textTransform: "uppercase" }}
              placeholder="K7M2-QX9F-4B3T"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !processing && typed) applyTyped();
              }}
              aria-label="İhalecinin verdiği Kod 1"
            />
            <AsyncButton className="btn" disabled={!!processing || !typed} onClick={applyTyped}>
              Onayla
            </AsyncButton>
          </div>
          {demoCodes && (
            <button
              className="btn ghost sm"
              title="Demo: ihaleci rolü aynı tarayıcıda oynandığı için kod bu cihazda duruyor"
              onClick={() => setTyped(formatCode(demoCodes[idx * CODES + CODE_ARRIVAL]))}
            >
              Demo: ihalecinin verdiği Kod 1'i yapıştır
            </button>
          )}
        </>
      ) : (
        <>
          <div className="panel-title">
            📷 Gün sonu QR'ı · payının tamamı {fromUnits(shareOf(job, me))} USDC
          </div>
          <div className="small muted">
            İşe geldiğin zincire yazıldı. İş bitince ihaleci gün sonu QR'ını gösterecek; okuttuğun anda payının tamamı hesabına geçer.
          </div>
          <div className="row">
            <button className="btn" disabled={!!processing} onClick={() => setScanning(true)}>
              📷 Gün sonu QR'ını okut
            </button>
            {demoCodes && (
              <AsyncButton
                className="btn ghost sm"
                title="Demo: ihaleci rolü aynı tarayıcıda oynandığı için QR içeriği bu cihazda duruyor"
                onClick={() => applyQr(encodeQr({ jobId: job.id, worker: me.address, secret: demoCodes[idx * CODES + CODE_FINAL] }))}
              >
                Demo: ihalecinin gün sonu QR'ı
              </AsyncButton>
            )}
          </div>
        </>
      )}

      {processing && (
        <div className="callout row" role="status">
          <span className="spinner" /> {processing} işleniyor…
        </div>
      )}

      {me.arrived ? (
        <LocationTracker job={job} me={me} signer={signer} run={run} venue={venue} />
      ) : (
        <>
          <div className="panel-title" style={{ marginTop: 8 }}>
            📍 İhaleci Kod 1'i vermiyor mu? Konumunu kanıt olarak kaydet, hakem seni gelmiş işaretlesin.
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
        <Modal title="Gün sonu QR'ını okut" onClose={() => setScanning(false)}>
          <QrScanner onResult={applyQr} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            İhalecinin ekranındaki QR'ı kameraya tut.
          </p>
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
      <div className="panel-title">⚖️ Hakem paneli · konum kanıtlarını incele</div>
      {job.locations.length === 0 && <div className="small muted">Henüz konum kanıtı gönderilmedi.</div>}
      {workers.map((s) => {
        const proofs = job.locations.filter((l) => l.worker === s.address);
        if (!proofs.length) return null;
        const last = proofs[proofs.length - 1];
        const inside = last.distance_m <= job.terms.radius_m;
        return (
          <div key={s.address} className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
              <span className={`badge ${inside ? "ok" : "err"}`}>
                {last.distance_m} m · {inside ? "etkinlik alanında" : "alan dışında"}
              </span>
            </div>
            <div className="small muted">
              {proofs.length} kanıt · son {new Date(Number(last.timestamp) * 1000).toLocaleString("tr-TR")} · ham koordinat zincirde yok,
              gerekirse çalışandan istenip hash'le doğrulanır
            </div>
            <div className="row">
              {!s.arrived && (
                <AsyncButton
                  className="btn sm"
                  title="Para hareket etmez: çalışan son tarih ödemesine dahil olur"
                  onClick={() => run(`${nameOf(s.address)} gelmiş olarak işaretlendi`, () => arbiterConfirmArrival(signer, job.id, s.address))}
                >
                  Gelmiş olarak işaretle
                </AsyncButton>
              )}
              {s.arrived && !s.released && !s.disputed && (
                <AsyncButton
                  className="btn secondary sm"
                  onClick={() => run(`${nameOf(s.address)} payı hakem kararıyla ödendi`, () => arbiterRelease(signer, job.id, s.address))}
                >
                  Payı serbest bırak · {fromUnits(shareOf(job, s))} USDC
                </AsyncButton>
              )}
              {s.released && <span className="badge ok">✓ ödendi</span>}
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

  const open = (escrow?.milestones ?? [])
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.flags.disputed && !m.flags.resolved && !m.flags.released);
  const label = (d: string) => ({ ihaleci: "İhaleci payı", pay: "Çalışan payı" })[d] ?? d;
  const total = open.reduce((a, { m }) => a + m.amount, 0n);

  return (
    <div className="panel">
      <div className="panel-title">⚖️ Trustless Work dispute'ları · karar hakemde</div>
      {!escrow && <div className="small muted">Escrow okunuyor…</div>}
      {escrow && open.length === 0 && <div className="small muted">Açık dispute yok, hepsi çözüldü.</div>}
      {open.length > 1 && (
        <AsyncButton
          className="btn"
          onClick={async () => {
            for (const { m, index } of open) {
              if (!(await run(`${label(m.description)} işverene iade edildi`, () => resolveToClient(signer, job, index, m.amount)))) break;
            }
            await load();
          }}
        >
          Tümünü işverene iade et · {fromUnits(total)} USDC
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
              await run("Dispute çözüldü, tutar işverene iade edildi", () => resolveToClient(signer, job, index, m.amount));
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
