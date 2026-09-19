import { StrKey } from "@stellar/stellar-sdk";
import { Bell, X } from "lucide-react";
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

/** Çalışma süresi hazır seçenekleri (dakika). Kod 2 yoklaması sürenin tam ortasında açılır. */
const WORK_PRESETS = (): [string, number][] => [
  [L("2 dk (demo)", "2 min (demo)"), 2],
  [L("4 saat", "4 hours"), 240],
  [L("8 saat", "8 hours"), 480],
  [L("12 saat", "12 hours"), 720],
];

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
  const [workStart, setWorkStart] = useState(() => toLocalInput(new Date()));
  const [workEnd, setWorkEnd] = useState(() => toLocalInput(new Date(Date.now() + 8 * 3600 * 1000)));
  const [arbiterWho, setArbiterWho] = useState("arbiter");
  const [arbiterCustom, setArbiterCustom] = useState("");
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
  if (new Date(deadline).getTime() <= Date.now()) problems.push(L("Son tarih gelecekte olmalı", "The deadline must be in the future"));
  const wsMs = new Date(workStart).getTime();
  const weMs = new Date(workEnd).getTime();
  if (!(weMs > wsMs)) problems.push(L("Çalışma bitişi başlangıçtan sonra olmalı", "The shift must end after it starts"));
  else if (weMs <= Date.now()) problems.push(L("Çalışma bitişi gelecekte olmalı", "The shift end must be in the future"));
  else if (weMs > new Date(deadline).getTime()) problems.push(L("Çalışma bitişi son tarihi geçemez", "The shift can't end after the deadline"));
  // Kontrattaki presence_window ile birebir aynı hesap (saniye cinsinden tam ortası)
  const wsSec = Math.floor(wsMs / 1000);
  const weSec = Math.floor(weMs / 1000);
  const kod2At = weMs > wsMs ? new Date((wsSec + Math.floor((weSec - wsSec) / 2)) * 1000) : null;
  if (!StrKey.isValidEd25519PublicKey(arbiterAddr)) problems.push(L("Hakem adresi geçersiz", "Invalid arbiter address"));
  else if (arbiterAddr === clientAddr || arbiterAddr === signer?.address || stakeholders.some((s) => s.address === arbiterAddr))
    problems.push(L("Hakem; işveren, ihaleci ya da çalışanlardan biri olamaz", "The arbiter can't be the employer, contractor or a worker"));
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
        workStart: new Date(workStart),
        workEnd: new Date(workEnd),
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
              "İhaleci olarak işi ve payları zincire yazarsın. Her çalışan kendi payını onaylamadan işveren para yatıramaz. Para kilitlendikten sonra saha kodlarını sen oluşturur, Kod 1'i sahada elden verir, gün sonu QR'ını iş bitince okutursun.",
              "As the contractor you write the job and the shares on-chain. The employer can't fund it until every worker has accepted their share. Once the money is locked you create the on-site codes, hand out Code 1 in person, and show the end-of-day QR when the job is done.",
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
              "İşveren bu tarihe kadar işi kapatmazsa: işe gelen çalışanlar paylarını alır, hiç gelmeyenlerin payı işverene döner.",
              "If the employer hasn't closed the job by then, workers who showed up get their shares and no-shows' shares go back to the employer.",
            )}
          </span>
        </label>

        <div className="field">
          {L("Çalışma saatleri", "Working hours")}
          <span className="row" style={{ gap: 6, fontWeight: 400 }}>
            <input type="datetime-local" value={workStart} onChange={(e) => setWorkStart(e.target.value)} aria-label={L("Çalışma başlangıcı", "Shift start")} />
            <span className="muted">→</span>
            <input type="datetime-local" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)} aria-label={L("Çalışma bitişi", "Shift end")} />
          </span>
          <span className="row" style={{ gap: 6 }}>
            {WORK_PRESETS().map(([l, mins]) => (
              <button
                key={l}
                type="button"
                className="btn secondary sm"
                onClick={() => {
                  const now = Date.now();
                  setWorkStart(toLocalInput(new Date(now)));
                  setWorkEnd(toLocalInput(new Date(now + mins * 60_000)));
                }}
              >
                {l}
              </button>
            ))}
          </span>
          {kod2At && (
            <span className="small muted row" style={{ fontWeight: 400, gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
              <Bell size={14} style={{ flex: "none", marginTop: 2 }} />
              <span>
                {L(
                  `Kod 2 yoklaması çalışma süresinin tam ortasında, ${kod2At.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })} itibarıyla sana bildirim olarak gelecek ve 15 dakika açık kalacak. Bu süre zincirde yazılı; dışında yoklama yapılamaz.`,
                  `The Code 2 roll call will reach you in the middle of the shift, at ${kod2At.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}, and stay open for 15 minutes. The window is enforced on-chain; no roll call is possible outside it.`,
                )}
              </span>
            </span>
          )}
        </div>

        <div className="field">
          {L("Saha akışı", "On-site flow")}
          <span className="small muted" style={{ fontWeight: 400 }}>
            {L(
              "Kod 1 · çalışan gelince ona elden verdiğin kodu girer, zincire \"geldi\" yazılır. Kod 2 · çalışma süresinin ortasında sana bildirim gelir, çalışmayanları işaretlersin. Gün sonu QR'ı · iş bitince okuttuğun QR, çalışanın payının tamamını öder. İlk iki adım para hareket ettirmez.",
              "Code 1 · when a worker arrives they type the code you give them and \"arrived\" goes on-chain. Code 2 · in the middle of the shift you get a notification and mark anyone not working. End-of-day QR · the QR you show when the job is done pays the worker's full share. The first two steps move no money.",
            )}
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
            <div style={{ fontWeight: 600 }}>
              {signer ? nameOf(signer.address) : "—"} · {L("ihaleci", "contractor")}
            </div>
            <div className="row" style={{ gap: 4 }}>
              %<input style={{ width: 70 }} inputMode="decimal" value={contractorPct} onChange={(e) => setContractorPct(e.target.value.replace(",", "."))} />
            </div>
            <div className="small muted">{((Number(amount) * Number(contractorPct)) / 100 || 0).toFixed(2)} USDC</div>
          </div>
          {rows.map((r, i) => (
            <div className="stake" key={i}>
              <div className="stack" style={{ gap: 6 }}>
                <select value={r.who} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)))} aria-label={L("Çalışan", "Worker")}>
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {r.who === "custom" && (
                  <input placeholder="G…" value={r.custom} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, custom: e.target.value } : x)))} />
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
