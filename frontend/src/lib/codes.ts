import { Buffer } from "buffer";
import { CONTRACT_ID } from "./config.ts";

/**
 * Saha kodları. İki tür var ve ikisi bilerek farklı biçimde:
 *
 * **Kod 1 · varış** — ihaleci sahada çalışana *elden* verir, çalışan *elle yazar*.
 * Bu yüzden kısa ve okunabilir: 32 harfli alfabeden 12 karakter (`K7M2-QX9F-4B3T`).
 * Karışan harfler (I, L, O, U) alfabede yok. Para ödemez, yalnızca "işe geldim" kanıtıdır.
 *
 * **Gün sonu · QR** — parayı aktaran adım. Yalnızca QR olarak gösterilir, elle yazılmaz;
 * bu yüzden kısa olması gerekmiyor ve tam 32 baytlık rastgele bir gizdir.
 *
 * Zincire her iki kodun da sadece sha256 özeti yazılır (`set_codes`); kodların kendisi
 * ihalecinin cihazından çıkmaz.
 */

/** Elle yazarken karışan harfler yok (Crockford base32). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Kod 1 uzunluğu. 12 × 5 bit = 60 bit: elle yazılabilir ama tahmin edilemez. */
export const CODE_LENGTH = 12;

/** Kod türleri: paydaş i'nin kodu → commitments[i * CODES + tür] (kontratla birebir aynı) */
export const CODE_ARRIVAL = 0;
export const CODE_FINAL = 1;
export const CODES = 2;

export const CODE_LABELS = ["Kod 1 · varış (elden verilir)", "Gün sonu QR · ödeme"] as const;
export const CODE_SHORT = ["Kod 1", "Gün sonu QR"] as const;

const key = (jobId: bigint | number) => `ekisler.codes.${CONTRACT_ID}.${jobId}`;

/** Kod 1: 12 karakter. 256 / 32 = 8 olduğu için `bayt & 31` sapmasız dağılır. */
export function randomArrivalCode(): string {
  const b = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => ALPHABET[x & 31]).join("");
}

/** Gün sonu gizi: 32 bayt, yalnızca QR ile taşınır. */
export function randomFinalSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}

/** Elle girilen Kod 1'i kanonik hâle getirir: büyük harf, ayraçsız, karışan harfler düzeltilmiş. */
export function normalizeCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CODE_LENGTH) return null;
  return [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** Okunması kolay olsun diye dörderli gruplar: K7M2-QX9F-4B3T */
export const formatCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

/** Zincire giden kod baytları: metnin UTF-8'i (kontrat bunun sha256'sını alır). */
export const codeBytes = (code: string) => Buffer.from(code, "utf8");

export async function sha256(bytes: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/**
 * Paydaş başına iki kod üretir: [Kod 1, gün sonu gizi].
 * Sıra kontrattaki `commitments[i * CODES + tür]` ile birebir aynıdır.
 */
export async function makeCodes(stakeholderCount: number) {
  const codes: string[] = [];
  for (let i = 0; i < stakeholderCount; i++) codes.push(randomArrivalCode(), randomFinalSecret());
  const commitments = await Promise.all(codes.map((c) => sha256(codeBytes(c))));
  return { codes, commitments };
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

/** QR yalnızca gün sonu ödemesi içindir: EKISLER:<jobId>:<çalışan adresi>:<giz> */
export const encodeQr = (p: { jobId: bigint; worker: string; secret: string }) =>
  `EKISLER:${p.jobId}:${p.worker}:${p.secret}`;

export function decodeQr(text: string): { jobId: bigint; worker: string; secret: string } | null {
  const m = text.trim().match(/^EKISLER:(\d+):(G[A-Z2-7]{55}):([0-9a-fA-F]{64})$/);
  return m ? { jobId: BigInt(m[1]), worker: m[2], secret: m[3].toLowerCase() } : null;
}

export interface LocationReading {
  lat: number;
  lng: number;
  at: number; // ms
  salt: string; // hex
}

/** Ham konum ölçümünün taahhüdü: sha256("enlem,boylam,zaman,tuz"). Tuz, hash'in tahmin edilmesini önler. */
export async function commitReading(r: Omit<LocationReading, "salt">): Promise<{ reading: LocationReading; hash: Buffer }> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const salt = Buffer.from(bytes).toString("hex");
  const reading = { ...r, salt };
  const hash = await sha256(new TextEncoder().encode(`${r.lat.toFixed(6)},${r.lng.toFixed(6)},${r.at},${salt}`));
  return { reading, hash };
}

/** Ham ölçümler zincire değil, yalnızca bu cihaza kaydedilir (anlaşmazlıkta hakeme gösterilebilir). */
export function saveReading(jobId: bigint, worker: string, reading: LocationReading) {
  const k = `ekisler.readings.${CONTRACT_ID}.${jobId}.${worker}`;
  try {
    const list = JSON.parse(localStorage.getItem(k) ?? "[]") as LocationReading[];
    list.push(reading);
    localStorage.setItem(k, JSON.stringify(list));
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
