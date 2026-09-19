import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL } from "./config.ts";

/**
 * Kod 2 hatırlatma/zaman aşımı, "Kod 1 ne zaman serbest bırakıldı"nı bilmek zorunda; işveren ve
 * çalışan farklı cihazlarda olabileceğinden bu bilgi zincirden okunur. Kontrat bunu kalıcı state
 * olarak tutmuyor (yalnızca `released` bit maskesi kalıcı), tek kaynak `TrancheReleased` event'i.
 */

let server: rpc.Server | null = null;
function rpcServer() {
  server ??= new rpc.Server(RPC_URL);
  return server;
}

// Testnet RPC'si getEvents'te ~10.000 ledger'dan uzun aralıklarda hata vermeden sessizce boş
// döndürüyor; pencere bu sınırın altında tutulur (~11 saat). Daha eski işlerde hatırlatma gösterilmez.
// (Mehmet Emin'in tespiti)
const LOOKBACK_LEDGERS = 8_000;
const MAX_PAGES = 5;

function decode(v: xdr.ScVal | { xdr: string }): unknown {
  const val = "xdr" in (v as { xdr?: string }) && typeof (v as { xdr?: string }).xdr === "string"
    ? xdr.ScVal.fromXDR((v as { xdr: string }).xdr, "base64")
    : (v as xdr.ScVal);
  return scValToNative(val);
}

const cache = new Map<string, Promise<Date | null>>();

/**
 * `TrancheReleased` event'lerinde jobId + worker + tranche eşleşen ilk kaydın ledger kapanış
 * zamanını döner. Bulunamazsa (event ufku dışında ya da henüz serbest bırakılmadıysa) null döner.
 */
export function trancheReleasedAt(jobId: bigint, worker: string, tranche: number): Promise<Date | null> {
  const key = `${jobId}-${worker}-${tranche}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchTrancheReleasedAt(jobId, worker, tranche).catch(() => null);
    cache.set(key, p);
    p.then((d) => {
      if (d === null) cache.delete(key); // bulunamadıysa tekrar denenebilsin
    });
  }
  return p;
}

async function fetchTrancheReleasedAt(jobId: bigint, worker: string, tranche: number): Promise<Date | null> {
  const srv = rpcServer();
  const latest = await srv.getLatestLedger();
  const initialStart = Math.max(1, latest.sequence - LOOKBACK_LEDGERS);
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await srv.getEvents(
      cursor
        ? { cursor, filters: [{ type: "contract", contractIds: [CONTRACT_ID] }], limit: 1000 }
        : { startLedger: initialStart, filters: [{ type: "contract", contractIds: [CONTRACT_ID] }], limit: 1000 },
    );
    for (const e of res.events) {
      try {
        const topics = e.topic.map(decode);
        // #[contractevent] topic'i struct adını snake_case'e çevirir: TrancheReleased → "tranche_released"
        if (!topics.includes("tranche_released")) continue;
        if (!topics.some((v) => typeof v === "bigint" && v === jobId)) continue;
        if (!topics.includes(worker)) continue;
        const data = decode(e.value) as Record<string, unknown>;
        if (Number(data.tranche) === tranche) {
          return new Date(e.ledgerClosedAt);
        }
      } catch {
        // beklenmeyen event şekli — atla
      }
    }
    if (res.events.length < 1000) break;
    cursor = res.cursor;
  }
  return null;
}
