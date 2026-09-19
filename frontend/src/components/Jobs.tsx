import { useCallback, useEffect, useState } from "react";
import { twViewer } from "../lib/config.ts";
import { useApp } from "../app-context.tsx";
import { decodeQr, distanceM, encodeQr, loadCodes, makeCodes, saveCodes, TRANCHE_LABELS, TRANCHE_SHORT } from "../lib/codes.ts";
import {
  acceptJob,
  arbiterRelease,
  claimTranche,
  completeJob,
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
import type { Signer } from "../lib/signer.ts";
import { Modal, QrImage, QrScanner } from "./Qr.tsx";
import { AsyncButton, useToast } from "./ui.tsx";

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
          Çalışan sahaya gelince işverenin gösterdiği QR'ı okutur ve kaporası anında hesabına geçer. Mesai ortasında ikinci QR,
          iş bitince son QR. İşveren kod vermezse çalışanın konumu kanıt olur, hakem kaporayı serbest bırakır.
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
        <span className="badge">Kapora %{t.arrival_bps / 100}</span>
        <span className="badge">Mesai ortası %{t.mid_bps / 100}</span>
        <span className="badge">Bitiş %100</span>
        <a
          className="badge"
          href={`https://www.openstreetmap.org/?mlat=${venue.lat}&mlon=${venue.lng}#map=17/${venue.lat}/${venue.lng}`}
          target="_blank"
          rel="noreferrer"
        >
          📍 Etkinlik noktası · {t.radius_m} m
        </a>
        <span className="badge">⚖️ {nameOf(t.arbiter)}</span>
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
                  %{(s.share_bps / 100).toLocaleString("tr-TR")} · ödenen {fromUnits(s.paid)} / {fromUnits(shareOf(job, s))} USDC
                </div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                {!contractorRow &&
                  TRANCHE_SHORT.map((l, i) => (
                    <span
                      key={l}
                      className={`badge ${isReleased(s, i) ? "ok" : isDisputed(s, i) ? "err" : ""}`}
                      title={isDisputed(s, i) ? `${TRANCHE_LABELS[i]}: Trustless Work'te hakemde` : TRANCHE_LABELS[i]}
                    >
                      {isReleased(s, i) ? "✓ " : isDisputed(s, i) ? "⚖️ " : ""}
                      {l}
                    </span>
                  ))}
                {contractorRow && isDisputed(s, 0) && <span className="badge err">⚖️ hakemde</span>}
              </div>
              <div>{s.accepted ? <span className="badge ok">✓ onayladı</span> : <span className="badge warn">bekliyor</span>}</div>
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

      {signer && job.status === JobStatus.Funded && isClient && <ClientCodes job={job} />}
      {signer && job.status === JobStatus.Funded && isWorker && myStake && (
        <WorkerPanel job={job} me={myStake} signer={signer} run={run} venue={venue} />
      )}
      {signer && job.status === JobStatus.Funded && isArbiter && <ArbiterPanel job={job} signer={signer} run={run} venue={venue} />}
      {signer && isArbiter && job.stakeholders.some((s) => s.disputed !== 0) && <DisputePanel job={job} signer={signer} run={run} />}

      <div className="job-actions">
        {signer && job.status === JobStatus.Funded && isClient && (
          <AsyncButton className="btn ok" onClick={() => run("İş kapandı, kalan paylar dağıtıldı", () => completeJob(signer, job.id))}>
            İşi kapat · kalan ödemeleri dağıt
          </AsyncButton>
        )}
        {signer && job.status === JobStatus.Closing && (
          <AsyncButton className="btn" onClick={() => run("Kapanış tamamlandı", () => continueClose(signer, job.id))}>
            Kapanışa devam et
          </AsyncButton>
        )}
        {signer && job.status === JobStatus.Funded && deadlinePassed && (
          <AsyncButton className="btn secondary" onClick={() => run("Son tarih geçti, ödemeler dağıtıldı", () => releaseJob(signer, job.id))}>
            Son tarih doldu · dağıtımı başlat
          </AsyncButton>
        )}
        {job.status === JobStatus.Funded && !isClient && (
          <div className="callout small">
            İşveren kapatmazsa {deadline.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} sonrasında herkes dağıtımı
            başlatabilir: işe gelen (kaporası açılmış) çalışanlar kalan paylarını alır, hiç gelmeyenlerin payı işverene döner.
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

/** İşverenin sahada göstereceği QR kodları */
function ClientCodes({ job }: { job: Job }) {
  const { nameOf } = useApp();
  const codes = loadCodes(job.id);
  const [open, setOpen] = useState<{ idx: number; tranche: number } | null>(null);
  const workers = job.stakeholders.map((s, idx) => ({ s, idx })).filter(({ s }) => s.address !== job.contractor);

  if (!codes)
    return (
      <div className="callout warn" style={{ marginTop: 14 }}>
        Bu işin QR kodları bu cihazda değil; kodlar parayı kilitleyen cihazda üretildi. İşi yine de "İşi kapat" ile tamamlayabilirsin.
      </div>
    );

  const openItem = open && workers.find((w) => w.idx === open.idx);
  return (
    <div className="panel">
      <div className="panel-title">📱 Saha QR kodları · çalışan okutunca dilim anında ödenir</div>
      {workers.map(({ s, idx }) => (
        <div key={s.address} className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontWeight: 600 }}>{nameOf(s.address)}</span>
          <span className="row" style={{ gap: 6 }}>
            {TRANCHE_SHORT.map((l, t) => (
              <button key={l} className="btn secondary sm" disabled={isReleased(s, t)} onClick={() => setOpen({ idx, tranche: t })}>
                {isReleased(s, t) ? `✓ ${l}` : `${l} QR`}
              </button>
            ))}
          </span>
        </div>
      ))}
      {open && openItem && (
        <Modal title={`${TRANCHE_LABELS[open.tranche]} · ${nameOf(openItem.s.address)}`} onClose={() => setOpen(null)}>
          <QrImage text={encodeQr({ jobId: job.id, tranche: open.tranche, worker: openItem.s.address, code: codes[open.idx * 3 + open.tranche] })} />
          <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
            Okutulunca çalışanın ödenen tutarı {fromUnits(trancheTarget(job, openItem.s, open.tranche))} USDC'ye çıkar.
            <br />
            Bu QR'ı sadece çalışan yanındayken göster.
          </p>
        </Modal>
      )}
    </div>
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
  const next = [0, 1, 2].find((t) => !isReleased(me, t));
  const idx = job.stakeholders.findIndex((s) => s.address === me.address);
  const demoCodes = loadCodes(job.id); // yalnızca aynı tarayıcıda işveren rolü de oynanıyorsa (demo)
  const myProofs = job.locations.filter((l) => l.worker === me.address);

  const applyCode = async (text: string) => {
    const p = decodeQr(text);
    if (!p) return toast("err", "Bu bir Ek İşler ödeme QR'ı değil");
    if (p.jobId !== job.id) return toast("err", `Bu QR başka bir işe ait (#${p.jobId})`);
    if (p.worker !== me.address) return toast("err", "Bu QR başka bir çalışan için üretilmiş");
    setScanning(false);
    await run(`${TRANCHE_LABELS[p.tranche]} ödemesi hesabına geçti`, () => claimTranche(signer, job.id, p.tranche, p.code));
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
      <div className="panel-title">
        📷 Sıradaki ödeme: <b>{TRANCHE_LABELS[next]}</b> → toplam {fromUnits(trancheTarget(job, me, next))} USDC
      </div>
      <div className="row">
        <button className="btn" onClick={() => setScanning(true)}>
          İşverenin QR'ını okut
        </button>
        {demoCodes && (
          <AsyncButton
            className="btn secondary sm"
            title="Demo: işveren rolü aynı tarayıcıda oynandığı için kod bu cihazda duruyor"
            onClick={() => applyCode(encodeQr({ jobId: job.id, tranche: next, worker: me.address, code: demoCodes[idx * 3 + next] }))}
          >
            Demo: işverenin ekranındaki QR
          </AsyncButton>
        )}
      </div>

      <div className="panel-title" style={{ marginTop: 8 }}>
        📍 İşveren kod vermiyor mu? Konumunu kanıt olarak kaydet, hakem kaporayı serbest bıraksın.
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
              onClick={() => run("Konum kanıtı zincire kaydedildi, hakem inceleyecek", () => submitLocation(signer, job.id, pos.lat, pos.lng))}
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

      {scanning && (
        <Modal title={`${TRANCHE_LABELS[next]} QR'ını okut`} onClose={() => setScanning(false)}>
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
        const d = Math.round(distanceM(fromE6(last.lat_e6), fromE6(last.lng_e6), venue.lat, venue.lng));
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
              {proofs.length} kanıt · son {new Date(Number(last.timestamp) * 1000).toLocaleString("tr-TR")} ·{" "}
              <a href={`https://www.openstreetmap.org/?mlat=${fromE6(last.lat_e6)}&mlon=${fromE6(last.lng_e6)}#map=17/${fromE6(last.lat_e6)}/${fromE6(last.lng_e6)}`} target="_blank" rel="noreferrer">
                haritada gör ↗
              </a>
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
  const [escrow, setEscrow] = useState<TwEscrow | null>(null);
  const load = useCallback(() => getEscrow(job.escrow).then(setEscrow).catch(() => setEscrow(null)), [job.escrow]);
  useEffect(() => {
    load();
  }, [load, job]);

  const open = (escrow?.milestones ?? [])
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.flags.disputed && !m.flags.resolved && !m.flags.released);

  return (
    <div className="panel">
      <div className="panel-title">⚖️ Trustless Work dispute'ları · karar hakemde</div>
      {!escrow && <div className="small muted">Escrow okunuyor…</div>}
      {escrow && open.length === 0 && <div className="small muted">Açık dispute yok, hepsi çözüldü.</div>}
      {open.map(({ m, index }) => (
        <div key={index} className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <b>{nameOf(m.receiver)}</b> · {m.description} · {fromUnits(m.amount)} USDC
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
