import { contract } from "@stellar/stellar-sdk";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL, USDC_DECIMALS, USDC_SAC } from "./config.ts";
import type { Signer } from "./signer.ts";

/** Kontrattaki JobStatus ile birebir */
export const JobStatus = {
  PendingApproval: 0,
  Approved: 1,
  Funded: 2,
  Completed: 3,
  Refunded: 4,
} as const;

export const STATUS_LABEL: Record<number, string> = {
  0: "Çalışan onayı bekleniyor",
  1: "Onaylandı · Fonlama bekleniyor",
  2: "Escrow'da kilitli",
  3: "Ödendi",
  4: "İade edildi",
};

export interface Stakeholder {
  address: string;
  share_bps: number;
  accepted: boolean;
}

export interface Job {
  id: bigint;
  client: string;
  contractor: string;
  token: string;
  total_amount: bigint;
  stakeholders: Stakeholder[];
  status: number;
  deadline: bigint;
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
};

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) return ERRORS[Number(m[1])] ?? `Kontrat hatası #${m[1]}`;
  if (/trustline|TrustLine|trust line/i.test(msg)) return "Alıcı hesapta USDC trustline yok";
  if (/balance|insufficient|underfunded/i.test(msg)) return "Yetersiz USDC bakiyesi";
  if (/rejected|declined|cancel/i.test(msg)) return "İmza reddedildi";
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

export function createJob(
  signer: Signer,
  p: { client: string; totalUsdc: string; stakeholders: { address: string; share_bps: number }[]; deadline: Date },
) {
  return invoke<bigint>(signer, "create_job", {
    client: p.client,
    contractor: signer.address,
    token: USDC_SAC,
    total_amount: toUnits(p.totalUsdc),
    stakeholders: p.stakeholders.map((s) => ({ ...s, accepted: false })),
    deadline: BigInt(Math.floor(p.deadline.getTime() / 1000)),
  });
}

export const acceptJob = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "accept_job", { job_id: id, worker: signer.address });

export const depositJob = (signer: Signer, id: bigint) => invoke<void>(signer, "deposit", { job_id: id });

export const completeJob = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "complete_and_split", { job_id: id });

export const releaseJob = (signer: Signer, id: bigint) =>
  invoke<void>(signer, "release_after_deadline", { job_id: id });

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
