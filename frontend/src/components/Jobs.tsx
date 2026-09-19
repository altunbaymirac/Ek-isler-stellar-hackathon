import { useCallback, useEffect, useState } from "react";
import { useApp } from "../app-context.tsx";
import {
  acceptJob,
  completeJob,
  depositJob,
  friendlyError,
  fromUnits,
  JobStatus,
  listJobs,
  releaseJob,
  STATUS_LABEL,
  type Job,
} from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { AsyncButton, useToast } from "./ui.tsx";

export function Jobs() {
  const { signer, jobsVersion, goTo } = useApp();
  const toast = useToast();
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
    (j.client === signer.address ||
      j.contractor === signer.address ||
      j.stakeholders.some((s) => s.address === signer.address));

  const visible = (jobs ?? []).filter((j) => !onlyMine || involved(j));

  return (
    <div className="stack">
      <div className="hero">
        <h1>Para aracıda değil, akıllı sözleşmede.</h1>
        <p>
          İhaleci işi ve payları tanımlar. Her çalışan kendi payını cüzdanıyla onaylamadan müşteri para yatıramaz.
          İş bitince müşteri onaylar; kontrat USDC'yi anında paylara göre dağıtır.
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
          <JobCard key={String(j.id)} job={j} onChange={load} toast={toast} />
        ))}
      </div>
    </div>
  );
}

const STEPS = ["İş tanımlandı", "Çalışan onayları", "Escrow'a kilitlendi", "Ödendi"];

function JobCard({
  job,
  onChange,
  toast,
}: {
  job: Job;
  onChange: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const { signer, nameOf, tryPerUsdc, balances, refreshBalances, goTo } = useApp();
  const me = signer?.address;
  const isClient = me === job.client;
  const isContractor = me === job.contractor;
  const myStake = job.stakeholders.find((s) => s.address === me);
  const deadline = new Date(Number(job.deadline) * 1000);
  const deadlinePassed = Date.now() >= deadline.getTime();
  const total = fromUnits(job.total_amount);
  const accepted = job.stakeholders.filter((s) => s.accepted).length;

  const currentStep =
    job.status === JobStatus.PendingApproval ? 1 : job.status === JobStatus.Approved ? 2 : job.status === JobStatus.Funded ? 3 : 4;

  const run = async (label: string, fn: () => Promise<{ hash?: string }>) => {
    try {
      const { hash } = await fn();
      toast("ok", label, hash);
      await Promise.all([onChange(), refreshBalances()]);
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  const clientUsdc = isClient && balances?.usdc != null ? Number(balances.usdc) : null;
  const insufficient = clientUsdc !== null && clientUsdc < Number(fromUnits(job.total_amount, 7));

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
            {isClient && <span className="badge">Müşterisin</span>}
            {isContractor && <span className="badge">İhalecisin</span>}
            {myStake && !isContractor && <span className="badge">Çalışansın</span>}
          </div>
          <div className="job-amount">{total} USDC</div>
          {tryPerUsdc && <div className="small muted">≈ ₺{(Number(total) * tryPerUsdc).toLocaleString("tr-TR", { maximumFractionDigits: 0 })}</div>}
        </div>
        <div className="small" style={{ textAlign: "right" }}>
          <div className="muted">Müşteri</div>
          <div style={{ fontWeight: 600 }}>{nameOf(job.client)}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            Son tarih
          </div>
          <div style={{ fontWeight: 600 }}>
            {deadline.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}
            {deadlinePassed && job.status === JobStatus.Funded && <span className="badge warn" style={{ marginLeft: 6 }}>doldu</span>}
          </div>
        </div>
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
        {job.stakeholders.map((s) => (
          <div key={s.address} className={`stake ${s.address === me ? "me" : ""}`}>
            <div>
              <div style={{ fontWeight: 600 }}>
                {nameOf(s.address)}
                {s.address === job.contractor && <span className="muted small"> · ihaleci</span>}
              </div>
              <div className="mono muted">{s.address.slice(0, 10)}…</div>
            </div>
            <div className="amt">
              <span className="pct">%{(s.share_bps / 100).toLocaleString("tr-TR")}</span>{" "}
              <span className="muted small">· {fromUnits((job.total_amount * BigInt(s.share_bps)) / 10_000n)} USDC</span>
            </div>
            <div>{s.accepted ? <span className="badge ok">✓ onayladı</span> : <span className="badge warn">bekliyor</span>}</div>
          </div>
        ))}
      </div>

      <div className="job-actions">
        {signer && job.status === JobStatus.PendingApproval && myStake && !myStake.accepted && (
          <AsyncButton
            className="btn ok"
            onClick={() =>
              run("Payını onayladın. Artık bu oran değiştirilemez.", async () => {
                await ensureReady(signer); // ödemeyi alabilmek için USDC trustline
                return acceptJob(signer, job.id);
              })
            }
          >
            Payımı onayla · %{myStake.share_bps / 100}
          </AsyncButton>
        )}
        {job.status === JobStatus.PendingApproval && isClient && (
          <div className="callout">Tüm çalışanlar payını onaylayınca parayı kilitleyebileceksin. Böylece gizli oran değişikliği yapılamaz.</div>
        )}

        {signer && job.status === JobStatus.Approved && isClient && (
          <>
            <AsyncButton className="btn" disabled={insufficient} onClick={() => run(`${total} USDC escrow'a kilitlendi`, () => depositJob(signer, job.id))}>
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
        {job.status === JobStatus.Approved && !isClient && <div className="callout">Tüm paylar onaylandı. Müşterinin parayı kilitlemesi bekleniyor.</div>}

        {signer && job.status === JobStatus.Funded && isClient && (
          <AsyncButton className="btn ok" onClick={() => run("İş onaylandı, ödeme paylara göre dağıtıldı", () => completeJob(signer, job.id))}>
            İş tamamlandı · ödemeyi dağıt
          </AsyncButton>
        )}
        {signer && job.status === JobStatus.Funded && deadlinePassed && (
          <AsyncButton
            className="btn secondary"
            onClick={() => run("Son tarih geçti, ödeme otomatik dağıtıldı", () => releaseJob(signer, job.id))}
          >
            Son tarih doldu · dağıtımı başlat
          </AsyncButton>
        )}
        {job.status === JobStatus.Funded && !isClient && !deadlinePassed && (
          <div className="callout">
            Para kontratta güvende. Müşteri onaylamazsa {deadline.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} sonrasında
            herkes dağıtımı başlatabilir.
          </div>
        )}

        {job.status === JobStatus.Completed && myStake && (
          <div className="callout ok">
            {fromUnits((job.total_amount * BigInt(myStake.share_bps)) / 10_000n)} USDC hesabına geçti.{" "}
            <button className="btn ghost sm" onClick={() => goTo("ramp")}>
              TL olarak IBAN'a çek →
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
