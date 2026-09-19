import { Buffer } from "buffer";
import { CONTRACT_ID } from "./config.ts";
import { L } from "./i18n.ts";

/**
 * Ödeme dilimi kodları.
 * Müşteri parayı kilitlerken her çalışan × dilim için 32 baytlık rastgele bir kod üretir.
 * Zincire sadece kodların sha256 hash'i yazılır; kodların kendisi müşterinin cihazında kalır
 * ve sahada QR olarak gösterilir. Çalışan QR'ı okutunca kontrat hash'i doğrular ve dilimi öder.
 */

export const TRANCHE_LABELS = ["Kod 1 · Varış (kapora)", "Kod 2 · Devam kontrolü", "QR · Gün sonu"] as const;
export const TRANCHE_SHORT = ["Kod 1", "Kod 2", "QR"] as const;
const TRANCHE_LABELS_EN = ["Code 1 · Arrival (deposit)", "Code 2 · Still on site", "QR · End of day"] as const;
const TRANCHE_SHORT_EN = ["Code 1", "Code 2", "QR"] as const;
export const trancheLabel = (t: number) => L(TRANCHE_LABELS[t], TRANCHE_LABELS_EN[t]);
export const trancheShort = (t: number) => L(TRANCHE_SHORT[t], TRANCHE_SHORT_EN[t]);
export const TRANCHES = 3;

const key = (jobId: bigint | number) => `ekisler.codes.${CONTRACT_ID}.${jobId}`;

export function randomCode(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

export async function sha256(bytes: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** stakeholderCount × 3 kod üretir, sırası kontrattaki [i * 3 + t] ile aynıdır. */
export async function makeCodes(stakeholderCount: number) {
  const codes = Array.from({ length: stakeholderCount * TRANCHES }, () => randomCode());
  const commitments = await Promise.all(codes.map(sha256));
  return { codes: codes.map((c) => Buffer.from(c).toString("hex")), commitments };
}

export function saveCodes(jobId: bigint | number, codes: string[]) {
  try {
    localStorage.setItem(key(jobId), JSON.stringify(codes));
  } catch {
    /* depolama yoksa kodlar sadece bu oturumda kalır */
  }
  memory.set(String(jobId), codes);
}

const memory = new Map<string, string[]>();

export function loadCodes(jobId: bigint | number): string[] | null {
  const m = memory.get(String(jobId));
  if (m) return m;
  try {
    const raw = localStorage.getItem(key(jobId));
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

export interface QrPayload {
  jobId: bigint;
  tranche: number;
  worker: string;
  code: string; // hex
}

/** QR içeriği: EKISLER:<jobId>:<dilim>:<çalışan adresi>:<kod hex> */
export const encodeQr = (p: QrPayload) => `EKISLER:${p.jobId}:${p.tranche}:${p.worker}:${p.code}`;

export function decodeQr(text: string): QrPayload | null {
  const m = text.trim().match(/^EKISLER:(\d+):([0-2]):(G[A-Z2-7]{55}):([0-9a-f]{64})$/i);
  if (!m) return null;
  return { jobId: BigInt(m[1]), tranche: Number(m[2]), worker: m[3], code: m[4].toLowerCase() };
}

export interface LocationReading {
  lat: number;
  lng: number;
  at: number; // ms
  salt: string; // hex
}

/** Ham konum ölçümünün taahhüdü: sha256("enlem,boylam,zaman,tuz"). Tuz, hash'in tahmin edilmesini önler. */
export async function commitReading(r: Omit<LocationReading, "salt">): Promise<{ reading: LocationReading; hash: Buffer }> {
  const salt = Buffer.from(randomCode().slice(0, 16)).toString("hex");
  const reading = { ...r, salt };
  const hash = await sha256(new TextEncoder().encode(`${r.lat.toFixed(6)},${r.lng.toFixed(6)},${r.at},${salt}`));
  return { reading, hash };
}

/** Ham ölçümler zincire değil, yalnızca bu cihaza kaydedilir (anlaşmazlıkta hakeme gösterilebilir). */
export function saveReading(jobId: bigint, worker: string, reading: LocationReading) {
  const key = `ekisler.readings.${CONTRACT_ID}.${jobId}.${worker}`;
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]") as LocationReading[];
    list.push(reading);
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* depolama yoksa ölçüm sadece zincirdeki hash olarak kalır */
  }
}

/** İki koordinat arası mesafe (metre, haversine) */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
