import { StrKey } from "@stellar/stellar-sdk";
import { useMemo, useState } from "react";
import { useApp } from "../app-context.tsx";
import { createJob, friendlyError } from "../lib/contract.ts";
import { ensureReady } from "../lib/horizon.ts";
import { DEMO_ROLES } from "../lib/wallet.ts";
import { AsyncButton, useToast } from "./ui.tsx";

interface Row {
  who: string; // demo rol anahtarı, "wallet" ya da "custom"
  custom: string;
  percent: string;
}

const DEADLINE_PRESETS: [string, number][] = [
  ["3 dk (demo)", 3 * 60],
  ["1 gün", 24 * 3600],
  ["3 gün", 3 * 24 * 3600],
  ["1 hafta", 7 * 24 * 3600],
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
    { who: "w1", custom: "", percent: "32" },
    { who: "w2", custom: "", percent: "18" },
  ]);
  const [contractorPct, setContractorPct] = useState("50");
  const [deadline, setDeadline] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)));
  const [arbiterWho, setArbiterWho] = useState("arbiter");
  const [arbiterCustom, setArbiterCustom] = useState("");
  const [arrivalPct, setArrivalPct] = useState("20");
  const [midPct, setMidPct] = useState("50");
  const [venue, setVenue] = useState({ lat: "41.033900", lng: "28.977200", radius: "300" });

  const resolve = (who: string, custom: string) =>
    who === "custom" ? custom.trim() : who === "wallet" ? (wallet?.address ?? "") : (demo[who]?.address ?? "");

  const options = [
    ...DEMO_ROLES.map((r) => ({ key: r.key, label: `${r.emoji} ${r.label}` })),
    ...(wallet ? [{ key: "wallet", label: "👛 Cüzdanım" }] : []),
    { key: "custom", label: "Başka adres…" },
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
  if (!signer) problems.push("Önce bir hesap seç");
  if (!StrKey.isValidEd25519PublicKey(clientAddr)) problems.push("Müşteri adresi geçersiz");
  if (clientAddr && clientAddr === signer?.address) problems.push("Müşteri ile ihaleci aynı hesap olamaz");
  if (!(Number(amount) > 0)) problems.push("Tutar 0'dan büyük olmalı");
  if (Math.abs(totalPct - 100) > 1e-9) problems.push(`Payların toplamı %100 olmalı (şu an %${totalPct})`);
  if (stakeholders.some((s) => !(s.percent > 0))) problems.push("Her pay 0'dan büyük olmalı");
  if (stakeholders.some((s) => !StrKey.isValidEd25519PublicKey(s.address))) problems.push("Geçersiz çalışan adresi var");
  if (new Set(stakeholders.map((s) => s.address)).size !== stakeholders.length) problems.push("Aynı kişi iki kez eklenmiş");
  if (new Date(deadline).getTime() <= Date.now()) problems.push("Son tarih gelecekte olmalı");
  if (!StrKey.isValidEd25519PublicKey(arbiterAddr)) problems.push("Hakem adresi geçersiz");
  else if (arbiterAddr === clientAddr || arbiterAddr === signer?.address || stakeholders.some((s) => s.address === arbiterAddr))
    problems.push("Hakem; işveren, ihaleci ya da çalışanlardan biri olamaz");
  if (!(Number(arrivalPct) > 0 && Number(arrivalPct) <= Number(midPct) && Number(midPct) <= 100))
    problems.push("Dilimler geçersiz: 0 < kapora ≤ mesai ≤ %100");
  if (!Number.isFinite(Number(venue.lat)) || !Number.isFinite(Number(venue.lng)) || !(Number(venue.radius) > 0))
    problems.push("Etkinlik konumu geçersiz");

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
      toast("ok", `İş #${result} oluşturuldu. Çalışanların onayı bekleniyor.`, hash);
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
          <h2>Yeni iş tanımla</h2>
          <p className="muted small" style={{ margin: 0 }}>
            İhaleci olarak işi ve payları zincire yazarsın. Çalışanlara verdiğin oranları{" "}
            <b>her çalışan kendi cüzdanıyla onaylamadan</b> işveren para yatıramaz. Çalışan sahada işverenin QR kodlarını okuttukça ödemesini alır.
          </p>
        </div>

        <label className="field">
          İhaleci (sen)
          <input value={signer ? nameOf(signer.address) : ""} disabled />
        </label>

        <label className="field">
          İşveren (ödemeyi yapan)
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
          Toplam iş bedeli (USDC)
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} />
          {tryPerUsdc && Number(amount) > 0 && (
            <span className="small muted" style={{ fontWeight: 400 }}>
              ≈ ₺{(Number(amount) * tryPerUsdc).toLocaleString("tr-TR", { maximumFractionDigits: 0 })} (SEP-38 kuru)
            </span>
          )}
        </label>

        <label className="field">
          Son tarih
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          <span className="row" style={{ gap: 6 }}>
            {DEADLINE_PRESETS.map(([l, s]) => (
              <button key={l} type="button" className="btn secondary sm" onClick={() => setDeadline(toLocalInput(new Date(Date.now() + s * 1000)))}>
                {l}
              </button>
            ))}
          </span>
          <span className="small muted" style={{ fontWeight: 400 }}>
            İşveren bu tarihe kadar işi kapatmazsa: işe gelen çalışanlar kalan paylarını alır, hiç gelmeyenlerin payı işverene döner.
          </span>
        </label>

        <div className="field">
          Saha ödeme dilimleri (her çalışanın payı üzerinden, kümülatif)
          <span className="row" style={{ gap: 8, fontWeight: 400 }}>
            <span className="row" style={{ gap: 4 }}>
              Varış QR'ı (kapora) %
              <input style={{ width: 64 }} inputMode="decimal" value={arrivalPct} onChange={(e) => setArrivalPct(e.target.value.replace(",", "."))} />
            </span>
            <span className="row" style={{ gap: 4 }}>
              Mesai QR'ı %
              <input style={{ width: 64 }} inputMode="decimal" value={midPct} onChange={(e) => setMidPct(e.target.value.replace(",", "."))} />
            </span>
            <span className="muted">Bitiş QR'ı %100</span>
          </span>
        </div>

        <div className="field">
          Etkinlik konumu (konum kanıtı için)
          <span className="row" style={{ gap: 6, fontWeight: 400 }}>
            <input style={{ width: 120 }} aria-label="Enlem" value={venue.lat} onChange={(e) => setVenue({ ...venue, lat: e.target.value })} />
            <input style={{ width: 120 }} aria-label="Boylam" value={venue.lng} onChange={(e) => setVenue({ ...venue, lng: e.target.value })} />
            <input style={{ width: 80 }} aria-label="Yarıçap (m)" value={venue.radius} onChange={(e) => setVenue({ ...venue, radius: e.target.value })} />
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
                  () => toast("err", "Konum izni verilmedi"),
                )
              }
            >
              Şu anki konumum
            </button>
          </span>
        </div>

        <label className="field">
          Hakem (konum anlaşmazlıklarında karar verir)
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
          <h2>Paylar</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Toplam %100 olmalı. Yuvarlama artığı ihaleciye gider.
          </p>
        </div>

        <div className="stake-list">
          <div className="stake me">
            <div style={{ fontWeight: 600 }}>{signer ? nameOf(signer.address) : "—"} · ihaleci</div>
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
                  aria-label="Çalışan"
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
                  aria-label="Pay yüzdesi"
                />
              </div>
              <div className="row" style={{ gap: 4 }}>
                <span className="small muted">{((Number(amount) * Number(r.percent)) / 100 || 0).toFixed(2)} USDC</span>
                <button className="btn ghost sm" aria-label="Çalışanı kaldır" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="btn secondary sm" onClick={() => setRows([...rows, { who: "custom", custom: "", percent: "0" }])}>
            + Çalışan ekle
          </button>
          <div className="spacer" />
          <span className={`badge ${Math.abs(totalPct - 100) < 1e-9 ? "ok" : "warn"}`}>Toplam %{totalPct}</span>
        </div>

        {problems.length > 0 && (
          <div className="callout warn">
            {problems.map((p) => (
              <div key={p}>• {p}</div>
            ))}
          </div>
        )}
        <AsyncButton className="btn" disabled={problems.length > 0} onClick={submit}>
          İşi zincire yaz
        </AsyncButton>
      </section>
    </div>
  );
}
