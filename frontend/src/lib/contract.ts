import { Buffer } from "buffer";
import { contract } from "@stellar/stellar-sdk";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL, USDC_DECIMALS, USDC_SAC } from "./config.ts";
import { L } from "./i18n.ts";
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

const STATUS_EN: Record<number, string> = {
  0: "Waiting for worker approval",
  1: "Approved · waiting for funding",
  2: "In Trustless Work escrow · job in progress",
  3: "Closed",
  4: "Cancelled",
  5: "Closing",
};

export const statusLabel = (s: number) => L(STATUS_LABEL[s], STATUS_EN[s]);

export interface Stakeholder {
  address: string;
  share_bps: number;
  accepted: boolean;
  paid: bigint;
  released: number; // dilim bit maskesi
  disputed: number; // hakeme (Trustless Work dispute) devredilen dilimler
  escrow: string; // bu paydaşın Trustless Work escrow'u (milestone i = dilim i)
  amounts: bigint[]; // dilim (milestone) tutarları
}

export interface LocationProof {
  worker: string;
  distance_m: number; // etkinlik noktasına mesafe; ham koordinat zincire yazılmaz
  reading_hash: Buffer; // ham ölçümün sha256 taahhüdü
  timestamp: bigint;
}

/** 1: Kod 2'de işveren "burada değil" dedi · 2: çalışan etkinlik alanından çıktı */
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
  arrival_bps: number;
  mid_bps: number;
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
  commitments: Buffer[];
  locations: LocationProof[];
  alerts: Alert[];
  close_mode: number;
}

const ERRORS: Record<number, [string, string]> = {
  1: ["İş bulunamadı", "Job not found"],
  2: ["Paylar geçersiz (toplam %100 olmalı, her pay > 0)", "Invalid shares (must total 100%, each > 0)"],
  3: ["Tüm çalışanlar henüz payını onaylamadı", "Not every worker has accepted their share yet"],
  4: ["Yetkisiz işlem", "Not authorized"],
  5: ["Bu işlem işin mevcut durumunda yapılamaz", "Not allowed in the job's current state"],
  6: ["Tutar sıfırdan büyük olmalı", "Amount must be greater than zero"],
  7: ["Bu adres bu işte paydaş değil", "This address is not a stakeholder in this job"],
  8: ["Aynı adres iki kez eklenmiş", "The same address was added twice"],
  9: ["Son tarih gelecekte olmalı", "Deadline must be in the future"],
  10: ["Son tarih henüz gelmedi", "The deadline has not passed yet"],
  11: ["Dilim oranları geçersiz (0 < kapora < mesai < %100)", "Invalid tranche split (0 < deposit < mid-shift < 100%)"],
  12: ["Hakem; müşteri, ihaleci ya da çalışanlardan biri olamaz", "The arbiter cannot be the employer, contractor or a worker"],
  13: ["Kod hash'leri eksik", "Code commitments are missing"],
  14: ["Kod geçersiz: bu çalışan ve dilim için üretilmemiş", "Invalid code: not issued for this worker and step"],
  15: ["Geçersiz dilim", "Invalid step"],
  16: ["Bu dilim zaten ödendi", "This step was already paid"],
  17: ["Bir işte en fazla 5 paydaş olabilir (ihaleci + 4 çalışan)", "A job can have at most 5 stakeholders (contractor + 4 workers)"],
};

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const pair = ERRORS[Number(m[1])];
    return pair ? L(...pair) : L(`Kontrat hatası #${m[1]}`, `Contract error #${m[1]}`);
  }
  if (/trustline|TrustLine|trust line/i.test(msg)) return L("Alıcı hesapta USDC trustline yok", "The receiving account has no USDC trustline");
  if (/balance|insufficient|underfunded/i.test(msg)) return L("Yetersiz USDC bakiyesi", "Insufficient USDC balance");
  if (/rejected|declined|cancel/i.test(msg)) return L("İmza reddedildi", "Signature was rejected");
  if (/geolocation|User denied/i.test(msg)) return L("Konum izni verilmedi", "Location permission was denied");
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
  const status = sent.getTransactionResponse?.status;
  if (status && status !== "SUCCESS") {
    const diag = (sent.getTransactionResponse as { diagnosticEventsXdr?: unknown[] } | undefined)?.diagnosticEventsXdr;
    throw new Error(`${L("İşlem ağda başarısız oldu", "Transaction failed on the network")} (${status})${hash ? ` · tx ${hash}` : ""}${diag ? ` · ${diag.length} diag` : ""}`);
  }
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
    arrivalPct: number;
    midPct: number;
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
    arrival_bps: Math.round(p.arrivalPct * 100),
    mid_bps: Math.round(p.midPct * 100),
    venue_lat_e6: toE6(p.venue.lat),
    venue_lng_e6: toE6(p.venue.lng),
    radius_m: Math.round(p.venue.radiusM),
  };
  return invoke<bigint>(signer, "create_job", { contractor: signer.address, terms });
}

export const acceptJob = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "accept_job", { job_id: id, worker: signer.address });

export const depositJob = (signer: Signer, id: bigint, commitments: Buffer[]) =>
  invoke<void>(signer, "deposit", { job_id: id, commitments });

export const claimTranche = (signer: Signer, id: bigint, tranche: number, codeHex: string) =>
  invoke<bigint>(signer, "claim", {
    job_id: id,
    worker: signer.address,
    tranche,
    code: Buffer.from(codeHex, "hex"),
  });

/** Zincire yalnızca mesafe ve ham ölçümün hash'i gider; ham ölçüm (tuzla) çalışanın cihazında saklanır. */
export const submitLocation = (signer: Signer, id: bigint, distanceM: number, readingHash: Buffer) =>
  invoke<void>(signer, "submit_location", { job_id: id, worker: signer.address, distance_m: distanceM, reading_hash: readingHash });

/** Kod 2: işveren çalışanın hâlâ iş yerinde olup olmadığını onaylar (evet → mesai dilimi ödenir) */
export const confirmPresence = (signer: Signer, id: bigint, worker: string, present: boolean) =>
  invoke<bigint>(signer, "confirm_presence", { job_id: id, worker, present });

export const arbiterRelease = (signer: Signer, id: bigint, worker: string, tranche: number) =>
  invoke<bigint>(signer, "arbiter_release", { job_id: id, worker, tranche });

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
export async function resolveToClient(signer: Signer, job: Job, escrow: string, milestoneIndex: number, amount: bigint) {
  const c = await twClient(escrow, signer);
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

/** Dilimin kümülatif hedefi */
export function trancheTarget(job: Job, s: Stakeholder, tranche: number) {
  const bps = tranche === 0 ? job.terms.arrival_bps : tranche === 1 ? job.terms.mid_bps : 10_000;
  return (shareOf(job, s) * BigInt(bps)) / 10_000n;
}

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
