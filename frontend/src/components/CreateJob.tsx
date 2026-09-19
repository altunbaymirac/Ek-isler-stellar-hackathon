import { StrKey } from "@stellar/stellar-sdk";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { useApp } from "../app-context.tsx";
import { createJob, friendlyError } from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { L, locale } from "../lib/i18n.ts";
import { DEMO_ROLES, roleText } from "../lib/wallet.ts";
import { AsyncButton, useToast } from "./ui.tsx";

interface Row {
  who: string; // demo rol anahtarı, "wallet" ya da "custom"
  custom: string;
  percent: string;
}

const DEADLINE_PRESETS = (): [string, number][] => [
  [L("3 dk (demo)", "3 min (demo)"), 3 * 60],
  [L("1 gün", "1 day"), 24 * 3600],
  [L("3 gün", "3 days"), 3 * 24 * 3600],
  [L("1 hafta", "1 week"), 7 * 24 * 3600],
];

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CreateJob() {
  const { signer, demo, wallet, nameOf, tryPerUsdc, bumpJobs, goTo } = useApp();
  const toast = useToast();

  const [clientWho, setClientWho] = useState("client");
  const [clientCustom, setClientCustom] = useState("");
  const [amount, setAmount] = useState("20");
  const [rows, setRows] = useState<Row[]>([
    { who: "w1", custom: "", percent: "20" },
    { who: "w2", custom: "", percent: "20" },
    { who: "w3", custom: "", percent: "20" },
  ]);
  const [contractorPct, setContractorPct] = useState("40");
  const [deadline, setDeadline] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)));
  const [arbiterWho, setArbiterWho] = useState("arbiter");
  const [arbiterCustom, setArbiterCustom] = useState("");
  const [arrivalPct, setArrivalPct] = useState("20");
  const [midPct, setMidPct] = useState("50");
  const [venue, setVenue] = useState({ lat: "41.033900", lng: "28.977200", radius: "300" });

  const resolve = (who: string, custom: string) =>
    who === "custom" ? custom.trim() : who === "wallet" ? (wallet?.address ?? "") : (demo[who]?.address ?? "");

  const options = [
    ...DEMO_ROLES.map((r) => ({ key: r.key, label: roleText(r).label })),
    ...(wallet ? [{ key: "wallet", label: L("Cüzdanım", "My wallet") }] : []),
    { key: "custom", label: L("Başka adres…", "Other address…") },
  ];

  const stakeholders = useMemo(() => {
    if (!signer) return [];
    return [
      { address: signer.address, percent: Number(contractorPct) },
      ...rows.map((r) => ({ address: resolve(r.who, r.custom), percent: Number(r.percent) })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, rows, contractorPct, demo, wallet]);


  const totalPct = stakeholders.reduce((a, s) => a + (Number.isFinite(s.percent) ? s.percent : 0), 0);
  const clientAddr = resolve(clientWho, clientCustom);
  const arbiterAddr = resolve(arbiterWho, arbiterCustom);

  const problems: string[] = [];
  if (!signer) problems.push(L("Önce bir hesap seç", "Pick an account first"));
  if (!StrKey.isValidEd25519PublicKey(clientAddr)) problems.push(L("İşveren adresi geçersiz", "Invalid employer address"));
  if (clientAddr && clientAddr === signer?.address) problems.push(L("İşveren ile ihaleci aynı hesap olamaz", "The employer and contractor can't be the same account"));
  if (!(Number(amount) > 0)) problems.push(L("Tutar 0'dan büyük olmalı", "Amount must be greater than 0"));
  if (Math.abs(totalPct - 100) > 1e-9) problems.push(L(`Payların toplamı %100 olmalı (şu an %${totalPct})`, `Shares must total 100% (now ${totalPct}%)`));
  if (stakeholders.some((s) => !(s.percent > 0))) problems.push(L("Her pay 0'dan büyük olmalı", "Every share must be greater than 0"));
  if (stakeholders.some((s) => !StrKey.isValidEd25519PublicKey(s.address))) problems.push(L("Geçersiz çalışan adresi var", "There is an invalid worker address"));
  if (new Set(stakeholders.map((s) => s.address)).size !== stakeholders.length) problems.push(L("Aynı kişi iki kez eklenmiş", "The same person was added twice"));
  if (stakeholders.length > 5) problems.push(L("Bir işte en fazla 5 paydaş olabilir (ihaleci + 4 çalışan)", "At most 5 stakeholders per job (contractor + 4 workers)"));
  if (new Date(deadline).getTime() <= Date.now()) problems.push(L("Son tarih gelecekte olmalı", "The deadline must be in the future"));
  if (!StrKey.isValidEd25519PublicKey(arbiterAddr)) problems.push(L("Hakem adresi geçersiz", "Invalid arbiter address"));
  else if (arbiterAddr === clientAddr || arbiterAddr === signer?.address || stakeholders.some((s) => s.address === arbiterAddr))
    problems.push(L("Hakem; işveren, ihaleci ya da çalışanlardan biri olamaz", "The arbiter can't be the employer, contractor or a worker"));
  if (!(Number(arrivalPct) > 0 && Number(arrivalPct) < Number(midPct) && Number(midPct) < 100))
    problems.push(L("Dilimler geçersiz: 0 < kapora < mesai < %100 (her dilim ayrı Trustless Work milestone'u)", "Invalid steps: 0 < deposit < mid-shift < 100% (each step is its own Trustless Work milestone)"));
  if (!Number.isFinite(Number(venue.lat)) || !Number.isFinite(Number(venue.lng)) || !(Number(venue.radius) > 0))
    problems.push(L("Etkinlik konumu geçersiz", "Invalid venue location"));

  const submit = async () => {
    if (!signer) return;
    try {
      await ensureReady(signer);
      const { result, hash } = await createJob(signer, {
        client: clientAddr,
        arbiter: arbiterAddr,
        totalUsdc: amount,
        shares: stakeholders.map((s) => ({ address: s.address, share_bps: Math.round(s.percent * 100) })),
        deadline: new Date(deadline),
        arrivalPct: Number(arrivalPct),
        midPct: Number(midPct),
        venue: { lat: Number(venue.lat), lng: Number(venue.lng), radiusM: Number(venue.radius) },
      });
      toast("ok", L(`İş #${result} oluşturuldu. Çalışanların onayı bekleniyor.`, `Job #${result} created. Waiting for the workers to accept.`), hash);
      bumpJobs();
      goTo("jobs");
    } catch (e) {
      toast("err", friendlyError(e));
    }
  };

  return (
    <div className="grid-2">
      <section className="card stack">
        <div>
          <h2>{L("Yeni iş tanımla", "Define a new job")}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {L(
              "İhaleci olarak işi ve payları zincire yazarsın. Her çalışan kendi payını onaylamadan işveren para yatıramaz. Çalışan sahada işverenin QR kodlarını okuttukça ödemesini alır.",
              "As the contractor you write the job and the shares on-chain. The employer can't fund it until every worker has accepted their share. Workers get paid as they scan the employer's QR codes on site.",
            )}
          </p>
        </div>

        <label className="field">
          {L("İhaleci (sen)", "Contractor (you)")}
          <input value={signer ? nameOf(signer.address) : ""} disabled />
        </label>

        <label className="field">
          {L("İşveren (ödemeyi yapan)", "Employer (who pays)")}
          <select value={clientWho} onChange={(e) => setClientWho(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          {clientWho === "custom" && <input placeholder="G…" value={clientCustom} onChange={(e) => setClientCustom(e.target.value)} />}
        </label>

        <label className="field">
          {L("Toplam iş bedeli (USDC)", "Total job price (USDC)")}
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} />
          {tryPerUsdc && Number(amount) > 0 && (
            <span className="small muted" style={{ fontWeight: 400 }}>
              ≈ ₺{(Number(amount) * tryPerUsdc).toLocaleString(locale(), { maximumFractionDigits: 0 })} ({L("SEP-38 kuru", "SEP-38 rate")})
            </span>
          )}
        </label>

        <label className="field">
          {L("Son tarih", "Deadline")}
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          <span className="row" style={{ gap: 6 }}>
            {DEADLINE_PRESETS().map(([l, s]) => (
              <button key={l} type="button" className="btn secondary sm" onClick={() => setDeadline(toLocalInput(new Date(Date.now() + s * 1000)))}>
                {l}
              </button>
            ))}
          </span>
          <span className="small muted" style={{ fontWeight: 400 }}>
            {L(
              "İşveren bu tarihe kadar işi kapatmazsa: işe gelen çalışanlar kalan paylarını alır, hiç gelmeyenlerin payı işverene döner.",
              "If the employer hasn't closed the job by then, workers who showed up get the rest of their share and no-shows' shares go back to the employer.",
            )}
          </span>
        </label>

        <div className="field">
          {L("Saha ödeme dilimleri (her çalışanın payı üzerinden, kümülatif)", "On-site payment steps (of each worker's share, cumulative)")}
          <span className="row" style={{ gap: 8, fontWeight: 400 }}>
            <span className="row" style={{ gap: 4 }}>
              {L("Kod 1 · varış (kapora) %", "Code 1 · arrival (deposit) %")}
              <input style={{ width: 64 }} inputMode="decimal" value={arrivalPct} onChange={(e) => setArrivalPct(e.target.value.replace(",", "."))} />
            </span>
            <span className="row" style={{ gap: 4 }}>
              {L("Kod 2 · devam %", "Code 2 · still here %")}
              <input style={{ width: 64 }} inputMode="decimal" value={midPct} onChange={(e) => setMidPct(e.target.value.replace(",", "."))} />
            </span>
            <span className="muted">{L("Gün sonu QR'ı %100", "End-of-day QR 100%")}</span>
          </span>
        </div>

        <div className="field">
          {L("Etkinlik konumu (konum kanıtı için)", "Venue location (for location proofs)")}
          <span className="row" style={{ gap: 6, fontWeight: 400 }}>
            <input style={{ width: 120 }} aria-label={L("Enlem", "Latitude")} value={venue.lat} onChange={(e) => setVenue({ ...venue, lat: e.target.value })} />
            <input style={{ width: 120 }} aria-label={L("Boylam", "Longitude")} value={venue.lng} onChange={(e) => setVenue({ ...venue, lng: e.target.value })} />
            <input style={{ width: 80 }} aria-label={L("Yarıçap (m)", "Radius (m)")} value={venue.radius} onChange={(e) => setVenue({ ...venue, radius: e.target.value })} />
            <span className="muted">m</span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button type="button" className="btn secondary sm" onClick={() => setVenue({ lat: "41.033900", lng: "28.977200", radius: "300" })}>
              Grand Pera, Beyoğlu
            </button>
            <button
              type="button"
              className="btn secondary sm"
              onClick={() =>
                navigator.geolocation.getCurrentPosition(
                  (p) => setVenue({ ...venue, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) }),
                  () => toast("err", L("Konum izni verilmedi", "Location permission was denied")),
                )
              }
            >
              {L("Şu anki konumum", "My current location")}
            </button>
          </span>
        </div>

        <label className="field">
          {L("Hakem (konum anlaşmazlıklarında karar verir)", "Arbiter (decides location disputes)")}
          <select value={arbiterWho} onChange={(e) => setArbiterWho(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          {arbiterWho === "custom" && <input placeholder="G…" value={arbiterCustom} onChange={(e) => setArbiterCustom(e.target.value)} />}
        </label>
      </section>

      <section className="card stack">
        <div>
          <h2>{L("Paylar", "Shares")}</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {L("Toplam %100 olmalı. Yuvarlama artığı ihaleciye gider.", "Must total 100%. Any rounding remainder goes to the contractor.")}
          </p>
        </div>

        <div className="stake-list">
          <div className="stake me">
            <div style={{ fontWeight: 600 }}>{signer ? nameOf(signer.address) : "—"} · {L("ihaleci", "contractor")}</div>
            <div className="row" style={{ gap: 4 }}>
              %<input style={{ width: 70 }} inputMode="decimal" value={contractorPct} onChange={(e) => setContractorPct(e.target.value.replace(",", "."))} />
            </div>
            <div className="small muted">{((Number(amount) * Number(contractorPct)) / 100 || 0).toFixed(2)} USDC</div>
          </div>
          {rows.map((r, i) => (
            <div className="stake" key={i}>
              <div className="stack" style={{ gap: 6 }}>
                <select
                  value={r.who}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)))}
                  aria-label={L("Çalışan", "Worker")}
                >
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {r.who === "custom" && (
                  <input
                    placeholder="G…"
                    value={r.custom}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, custom: e.target.value } : x)))}
                  />
                )}
              </div>
              <div className="row" style={{ gap: 4 }}>
                %
                <input
                  style={{ width: 70 }}
                  inputMode="decimal"
                  value={r.percent}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, percent: e.target.value.replace(",", ".") } : x)))}
                  aria-label={L("Pay yüzdesi", "Share percent")}
                />
              </div>
              <div className="row" style={{ gap: 4 }}>
                <span className="small muted">{((Number(amount) * Number(r.percent)) / 100 || 0).toFixed(2)} USDC</span>
                <button className="btn ghost sm" aria-label={L("Çalışanı kaldır", "Remove worker")} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <X size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn secondary sm" onClick={() => setRows([...rows, { who: "custom", custom: "", percent: "0" }])}>
            + {L("Çalışan ekle", "Add worker")}
          </button>
          <div className="spacer" />
          <span className={`badge ${Math.abs(totalPct - 100) < 1e-9 ? "ok" : "warn"}`}>{L(`Toplam %${totalPct}`, `Total ${totalPct}%`)}</span>
        </div>

        {problems.length > 0 && (
          <div className="callout warn">
            {problems.map((p) => (
              <div key={p}>• {p}</div>
            ))}
          </div>
        )}
        <AsyncButton className="btn" disabled={problems.length > 0} onClick={submit}>
          {L("İşi zincire yaz", "Write the job on-chain")}
        </AsyncButton>
      </section>
    </div>
  );
}
