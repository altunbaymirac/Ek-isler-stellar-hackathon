import { Address, FeeBumpTransaction, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { NETWORK_PASSPHRASE, RPC_URL } from "./config.ts";

/**
 * Bir işlemin hangi kontrat fonksiyonunu hangi argümanlarla çağırdığı; zincirdeki işlem zarfından
 * okunur (tahmin edilmez). Arayüz her aşamada "kontratın neyi çalıştırdığını" gösterir.
 */
export interface ContractCall {
  contract: string;
  fn: string;
  args: string[]; // kısa, okunur biçimde
}

let server: rpc.Server | null = null;
const cache = new Map<string, Promise<ContractCall | null>>();

export function contractCall(hash: string): Promise<ContractCall | null> {
  let p = cache.get(hash);
  if (!p) {
    p = fetchCall(hash).catch(() => null);
    cache.set(hash, p);
    p.then((r) => r === null && cache.delete(hash));
  }
  return p;
}

async function fetchCall(hash: string): Promise<ContractCall | null> {
  server ??= new rpc.Server(RPC_URL);
  const res = await server.getTransaction(hash);
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;
  // Üst seviye Transaction nesnesi: fee-bump sarmalıysa içteki işlem
  const parsed = TransactionBuilder.fromXDR(res.envelopeXdr.toXDR("base64"), NETWORK_PASSPHRASE);
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") continue;
    const ic = (op.func as unknown as { invokeContract?: { contractAddress: unknown; functionName: unknown; args: xdr.ScVal[] } }).invokeContract;
    if (!ic) continue;
    return {
      contract: Address.fromScAddress(ic.contractAddress as Parameters<typeof Address.fromScAddress>[0]).toString(),
      fn: String(ic.functionName),
      args: ic.args.map(fmt),
    };
  }
  return null;
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

function fmt(v: xdr.ScVal): string {
  try {
    const n = scValToNative(v);
    if (typeof n === "bigint" || typeof n === "number") return String(n);
    if (typeof n === "boolean") return String(n);
    if (typeof n === "string") return /^[GC][A-Z2-7]{55}$/.test(n) ? short(n) : n;
    if (n instanceof Uint8Array) return `0x${Buffer.from(n).toString("hex").slice(0, 8)}…`;
    if (Array.isArray(n)) return `[${n.length}]`;
    return "{…}";
  } catch {
    return "…";
  }
}
