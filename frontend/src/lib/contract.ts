import { Buffer } from "buffer";
import { contract } from "@stellar/stellar-sdk";
import { codeBytes } from "./codes.ts";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL, USDC_DECIMALS, USDC_SAC } from "./config.ts";
import type { Signer } from "./signer.ts";

/** Kontrattaki JobStatus ile birebir */
export const JobStatus = {
  PendingApproval: 0,
  Approved: 1,
  Funded: 2,
  Completed: 3,
  Refunded: 4,
  Closing: 5,
} as const;

export const STATUS_LABEL: Record<number, string> = {
  0: "Çalışan onayı bekleniyor",
  1: "Onaylandı · Fonlama bekleniyor",
  2: "Trustless Work escrow'unda · iş sürüyor",
  3: "Kapandı",
  4: "İptal edildi",
  5: "Kapanış sürüyor",
};

export interface Stakeholder {
  address: string;
  share_bps: number;
  accepted: boolean; // çalışanın mutabakat onayı
  arrived: boolean; // Kod 1 girildi ya da hakem işaretledi — para hareket etmez
  checks: number; // Kod 2 yoklaması kaç kez yapıldı (para hareket etmez)
  released: boolean; // payı Trustless Work'ten ödendi
  disputed: boolean; // payı hakeme (Trustless Work dispute) devredildi
  paid: bigint;
  milestone: number; // Trustless Work escrow'undaki milestone indeksi
  amount: bigint; // milestone tutarı
}

export interface LocationProof {
  worker: string;
  distance_m: number; // etkinlik noktasına mesafe; ham koordinat zincire yazılmaz
  reading_hash: Buffer; // ham ölçümün sha256 taahhüdü
  timestamp: bigint;
}

/** 1: Kod 2'de ihaleci "burada değil" dedi · 2: çalışan etkinlik alanından çıktı */
export interface Alert {
  worker: string;
  kind: number;
  distance_m: number;
  timestamp: bigint;
}
export const ALERT_REPORTED_ABSENT = 1;
export const ALERT_LEFT_AREA = 2;

export interface JobTerms {
  client: string;
  arbiter: string;
  token: string;
  total_amount: bigint;
  shares: { address: string; share_bps: number }[];
  deadline: bigint;
  /** Çalışma saatleri. Kod 2 yoklaması bu aralığın tam ortasında açılır. */
  work_start: bigint;
  work_end: bigint;
  venue_lat_e6: bigint;
  venue_lng_e6: bigint;
  radius_m: number;
}

export interface Job {
  id: bigint;
  contractor: string;
  terms: JobTerms;
  stakeholders: Stakeholder[];
  status: number;
  escrow: string; // Trustless Work multi-release escrow kontratı
  commitments: Buffer[];
  locations: LocationProof[];
  alerts: Alert[];
  close_mode: number;
}

const ERRORS: Record<number, string> = {
  1: "İş bulunamadı",
  2: "Paylar geçersiz (toplam %100 olmalı, her pay > 0)",
  3: "Tüm çalışanlar henüz payını onaylamadı",
  4: "Yetkisiz işlem",
  5: "Bu işlem işin mevcut durumunda yapılamaz",
  6: "Tutar sıfırdan büyük olmalı",
  7: "Bu adres bu işte paydaş değil",
  8: "Aynı adres iki kez eklenmiş",
  9: "Son tarih gelecekte olmalı",
  10: "Son tarih henüz gelmedi",
  11: "Bu çalışan zaten gelmiş olarak işaretlendi",
  12: "Hakem; müşteri, ihaleci ya da çalışanlardan biri olamaz",
  13: "Kod hash'leri eksik: her çalışan için Kod 1 ve gün sonu QR'ı gerekli",
  14: "Kod geçersiz: bu çalışan için üretilmemiş",
  15: "Geçersiz kod türü",
  16: "Bu payın ödemesi zaten yapıldı",
  17: "Çok fazla çalışan: Trustless Work escrow'u en fazla 50 milestone alır",
  18: "İhaleci henüz saha kodlarını oluşturmadı",
  19: "Kod 2 yoklama penceresi açık değil (çalışma saatlerinin ortasında 15 dakika açılır)",
  20: "Çalışma saatleri geçersiz: başlangıç < bitiş olmalı ve bitiş son tarihi geçmemeli",
};

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) return ERRORS[Number(m[1])] ?? `Kontrat hatası #${m[1]}`;
  if (/trustline|TrustLine|trust line/i.test(msg)) return "Alıcı hesapta USDC trustline yok";
  if (/balance|insufficient|underfunded/i.test(msg)) return "Yetersiz USDC bakiyesi";
  if (/rejected|declined|cancel/i.test(msg)) return "İmza reddedildi";
  if (/geolocation|User denied/i.test(msg)) return "Konum izni verilmedi";
  return msg.length > 220 ? msg.slice(0, 220) + "…" : msg;
}

// Kontrat arayüzü zincirden (wasm spec) bir kez okunur, sonra her imzalayıcı için yeniden kullanılır.
let specPromise: Promise<contract.Spec> | null = null;
function getSpec() {
  specPromise ??= contract.Client.from({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
  }).then((c) => c.spec);
  specPromise.catch(() => (specPromise = null));
  return specPromise;
}

type AnyClient = contract.Client &
  Record<string, (args?: object) => Promise<contract.AssembledTransaction<unknown>>>;

async function client(signer?: Signer): Promise<AnyClient> {
  const spec = await getSpec();
  return new contract.Client(spec, {
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: signer?.address,
    signTransaction: signer?.signTransaction,
  }) as AnyClient;
}

function unwrap<T>(v: unknown): T {
  // Result<T, Error> dönüşleri SDK'da Ok/Err nesnesi olarak gelir
  const r = v as { isOk?: () => boolean; unwrap?: () => T; unwrapErr?: () => { code?: number } };
  if (typeof r?.isOk === "function") {
    if (r.isOk()) return r.unwrap!();
    const code = r.unwrapErr!()?.code;
    throw new Error(`Error(Contract, #${code})`);
  }
  return v as T;
}

async function invoke<T>(signer: Signer, method: string, args: object): Promise<{ result: T; hash?: string }> {
  const c = await client(signer);
  const tx = await c[method](args);
  const sent = await tx.signAndSend();
  const hash = sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash;
  return { result: unwrap<T>(sent.result), hash };
}

export async function jobCount(): Promise<number> {
  const c = await client();
  const tx = await c.job_count();
  return Number(tx.result as bigint);
}

export async function getJob(id: number | bigint): Promise<Job> {
  const c = await client();
  const tx = await c.get_job({ job_id: BigInt(id) });
  return unwrap<Job>(tx.result);
}

export async function listJobs(): Promise<Job[]> {
  const n = await jobCount();
  const ids = Array.from({ length: n }, (_, i) => n - i); // en yeni önce
  return Promise.all(ids.map((id) => getJob(id)));
}

export const toE6 = (deg: number) => BigInt(Math.round(deg * 1e6));
export const fromE6 = (v: bigint) => Number(v) / 1e6;

export function createJob(
  signer: Signer,
  p: {
    client: string;
    arbiter: string;
    totalUsdc: string;
    shares: { address: string; share_bps: number }[];
    deadline: Date;
    workStart: Date;
    workEnd: Date;
    venue: { lat: number; lng: number; radiusM: number };
  },
) {
  const terms: JobTerms = {
    client: p.client,
    arbiter: p.arbiter,
    token: USDC_SAC,
    total_amount: toUnits(p.totalUsdc),
    shares: p.shares,
    deadline: BigInt(Math.floor(p.deadline.getTime() / 1000)),
    work_start: BigInt(Math.floor(p.workStart.getTime() / 1000)),
    work_end: BigInt(Math.floor(p.workEnd.getTime() / 1000)),
    venue_lat_e6: toE6(p.venue.lat),
    venue_lng_e6: toE6(p.venue.lng),
    radius_m: Math.round(p.venue.radiusM),
  };
  return invoke<bigint>(signer, "create_job", { contractor: signer.address, terms });
}

export const acceptJob = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "accept_job", { job_id: id, worker: signer.address });

/** İşveren parayı Trustless Work escrow'una kilitler. Saha kodları işverende değil ihalecidedir. */
export const depositJob = (signer: Signer, id: bigint) => invoke<void>(signer, "deposit", { job_id: id });

/** İhaleci saha kodlarının sha256 taahhütlerini zincire yazar; kodların kendisi cihazında kalır. */
export const setCodes = (signer: Signer, id: bigint, commitments: Buffer[]) =>
  invoke<void>(signer, "set_codes", { job_id: id, commitments });

/** Kod 1 · varış: ihalecinin elden verdiği 12 karakterlik kod. Para hareket etmez, "geldim" kanıtıdır. */
export const checkIn = (signer: Signer, id: bigint, code: string) =>
  invoke<void>(signer, "check_in", { job_id: id, worker: signer.address, code: codeBytes(code) });

/** Gün sonu QR'ı: payın tamamı anında ödenir. */
export const claimPayment = (signer: Signer, id: bigint, secret: string) =>
  invoke<bigint>(signer, "claim", { job_id: id, worker: signer.address, code: codeBytes(secret) });

/** Zincire yalnızca mesafe ve ham ölçümün hash'i gider; ham ölçüm (tuzla) çalışanın cihazında saklanır. */
export const submitLocation = (signer: Signer, id: bigint, distanceM: number, readingHash: Buffer) =>
  invoke<void>(signer, "submit_location", { job_id: id, worker: signer.address, distance_m: distanceM, reading_hash: readingHash });

/**
 * Kod 2 · devam kontrolü: ihaleci çalışanın hâlâ iş yerinde olup olmadığını bildirir.
 * Para hareket etmez; bu yalnızca yoklamadır ve gün boyunca tekrarlanabilir.
 */
export const confirmPresence = (signer: Signer, id: bigint, worker: string, present: boolean) =>
  invoke<void>(signer, "confirm_presence", { job_id: id, worker, present });

/**
 * Kod 2 · toplu yoklama: ihaleciye giden tek bildirimin yanıtı.
 * `absent` listesindekilere "ihaleci çalışmadığını söylüyor" bildirimi gider, kalanlar çalışıyor sayılır.
 */
export const confirmPresenceAll = (signer: Signer, id: bigint, absent: string[]) =>
  invoke<void>(signer, "confirm_presence_all", { job_id: id, absent });

/** Kontrattaki PRESENCE_WINDOW_SECS ile aynı: yoklama 15 dakika açık kalır. */
export const PRESENCE_WINDOW_SECS = 15 * 60;

/** Kod 2 penceresi (kontrattaki `presence_window` ile birebir aynı hesap), ms cinsinden. */
export function presenceWindow(job: Job) {
  const start = Number(job.terms.work_start);
  const end = Number(job.terms.work_end);
  const mid = start + Math.floor((end - start) / 2);
  return { from: mid * 1000, to: (mid + PRESENCE_WINDOW_SECS) * 1000 };
}

/** Hakem: konum kanıtına bakıp çalışanı "geldi" işaretler. Ödeme değildir; son tarih ödemesine dahil eder. */
export const arbiterConfirmArrival = (signer: Signer, id: bigint, worker: string) =>
  invoke<void>(signer, "arbiter_confirm_arrival", { job_id: id, worker });

/** Hakem: çalışanın payını son tarihi beklemeden serbest bıraktırır. */
export const arbiterRelease = (signer: Signer, id: bigint, worker: string) =>
  invoke<bigint>(signer, "arbiter_release", { job_id: id, worker });

/**
 * Kapanış Trustless Work milestone'larını parça parça işler (her işlem en fazla 3 milestone):
 * ilk çağrıdan sonra iş "Kapanış sürüyor" durumundaysa continue_close ile bitirilir.
 */
async function closeFully(signer: Signer, id: bigint, method: string) {
  const first = await invoke<void>(signer, method, { job_id: id });
  let hash = first.hash;
  for (let i = 0; i < 20 && (await getJob(id)).status === JobStatus.Closing; i++) {
    hash = (await invoke<void>(signer, "continue_close", { job_id: id })).hash ?? hash;
  }
  return { result: undefined, hash };
}

export const completeJob = (signer: Signer, id: bigint) => closeFully(signer, id, "complete_and_split");

export const releaseJob = (signer: Signer, id: bigint) => closeFully(signer, id, "release_after_deadline");

export const continueClose = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "continue_close", { job_id: id });

// ---- Trustless Work escrow'u ----

export interface TwMilestone {
  description: string;
  status: string;
  evidence: string;
  amount: bigint;
  receiver: string;
  flags: { approved: boolean; disputed: boolean; released: boolean; resolved: boolean };
}

export interface TwEscrow {
  engagement_id: string;
  title: string;
  roles: { approver: string; service_provider: string; platform: string; release_signer: string; dispute_resolver: string };
  milestones: TwMilestone[];
  trustline: { address: string };
}

const twSpecs = new Map<string, Promise<contract.Spec>>();
async function twClient(escrow: string, signer?: Signer): Promise<AnyClient> {
  let spec = twSpecs.get(escrow);
  if (!spec) {
    spec = contract.Client.from({ contractId: escrow, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL }).then((c) => c.spec);
    twSpecs.set(escrow, spec);
    spec.catch(() => twSpecs.delete(escrow));
  }
  return new contract.Client(await spec, {
    contractId: escrow,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: signer?.address,
    signTransaction: signer?.signTransaction,
  }) as AnyClient;
}

export async function getEscrow(escrow: string): Promise<TwEscrow> {
  const c = await twClient(escrow);
  return unwrap<TwEscrow>((await c.get_escrow()).result);
}

let twFeePromise: Promise<string> | null = null;
/** Trustless Work testnet protokol ücreti adresi (Ek İşler kontratında kayıtlı) */
export function twFeeAddress() {
  twFeePromise ??= client()
    .then((c) => c.tw_config())
    .then((tx) => (tx.result as [unknown, string])[1]);
  return twFeePromise;
}

/** Hakem: Trustless Work'te dispute'taki milestone'u çözer ve tutarı işverene iade eder */
export async function resolveToClient(signer: Signer, job: Job, milestoneIndex: number, amount: bigint) {
  const c = await twClient(job.escrow, signer);
  const tx = await c.resolve_milestone_dispute({
    dispute_resolver: signer.address,
    milestone_index: milestoneIndex,
    trustless_work_address: await twFeeAddress(),
    distributions: new Map([[job.terms.client, amount]]),
  });
  const sent = await tx.signAndSend();
  return { result: undefined, hash: sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash };
}

/** Trustless Work testnet protokol ücreti: her serbest bırakmada %0,3 */
export const netOfTwFee = (gross: bigint) => gross - (gross * 30n) / 10_000n;

/** Çalışanın payı (en küçük birim) */
export const shareOf = (job: Job, s: Stakeholder) => (job.terms.total_amount * BigInt(s.share_bps)) / 10_000n;


export function toUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const f = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(f || "0");
}

export function fromUnits(v: bigint, digits = 2): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(USDC_DECIMALS, "0").slice(0, digits);
  return `${neg ? "-" : ""}${whole.toString()}${digits ? "." + frac : ""}`;
}
