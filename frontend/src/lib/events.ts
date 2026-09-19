import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACT_ID, RPC_URL } from "./config.ts";

/**
 * Kontratın event'leri, bir işin her adımının zincirdeki kaydıdır: hangi işlemde (tx hash) ve ne
 * zaman olduğu. Arayüz bunu iki yerde kullanır:
 *  - her adımın yanında "zincirde gör" linki (jüri: her adım doğrulanabilir olsun),
 *  - Kod 2 hatırlatması: "Kod 1 ne zaman serbest bırakıldı" kalıcı state'te yok, tek kaynak event.
 */

let server: rpc.Server | null = null;
function rpcServer() {
  server ??= new rpc.Server(RPC_URL);
  return server;
}

// Testnet RPC'si getEvents'te ~10.000 ledger'dan uzun aralıklarda hata vermeden sessizce boş
// döndürüyor; pencere bu sınırın altında tutulur (~11 saat). Daha eski işlerin adım kayıtları
// gösterilmez, escrow linkleri yine çalışır. (Mehmet Emin'in tespiti)
const LOOKBACK_LEDGERS = 8_000;
const MAX_PAGES = 5;
const FRESH_MS = 8_000;

export type ActivityKind =
  | "job_created"
  | "job_accepted"
  | "job_funded"
  | "tranche_released"
  | "codes_set"
  | "checked_in"
  | "payment_released"
  | "location_submitted"
  | "presence_checked"
  | "alert_raised"
  | "job_closed";

export interface Activity {
  kind: ActivityKind;
  jobId: bigint;
  worker?: string;
  data: Record<string, unknown>;
  txHash: string;
  at: Date;
}

function decode(v: xdr.ScVal | { xdr: string }): unknown {
  const val =
    "xdr" in (v as { xdr?: string }) && typeof (v as { xdr?: string }).xdr === "string"
      ? xdr.ScVal.fromXDR((v as { xdr: string }).xdr, "base64")
      : (v as xdr.ScVal);
  return scValToNative(val);
}

let feed: { at: number; p: Promise<Activity[]> } | null = null;

/** Kontratın son ~11 saatteki tüm event'leri (kısa süre önbellekli, tüm kartlar tek istek paylaşır) */
export function allActivity(force = false): Promise<Activity[]> {
  if (!force && feed && Date.now() - feed.at < FRESH_MS) return feed.p;
  const p = fetchAll().catch(() => [] as Activity[]);
  feed = { at: Date.now(), p };
  return p;
}

export async function jobActivity(jobId: bigint, force = false): Promise<Activity[]> {
  return (await allActivity(force)).filter((a) => a.jobId === jobId);
}

async function fetchAll(): Promise<Activity[]> {
  const srv = rpcServer();
  const latest = await srv.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - LOOKBACK_LEDGERS);
  const filters = [{ type: "contract" as const, contractIds: [CONTRACT_ID] }];
  const out: Activity[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res: rpc.Api.GetEventsResponse = await srv.getEvents(cursor ? { cursor, filters, limit: 1000 } : { startLedger, filters, limit: 1000 });
    for (const e of res.events) {
      try {
        const topics = e.topic.map(decode);
        // #[contractevent] topic'i struct adını snake_case'e çevirir: TrancheReleased → "tranche_released"
        const kind = topics[0] as ActivityKind;
        const jobId = topics.find((v) => typeof v === "bigint") as bigint | undefined;
        if (typeof kind !== "string" || jobId === undefined) continue;
        const worker = topics.find((v) => typeof v === "string" && v !== kind && /^[GC][A-Z2-7]{55}$/.test(v)) as string | undefined;
        const value = decode(e.value);
        const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        out.push({
          kind,
          jobId,
          // JobAccepted'ta çalışan topic değil, veri alanında
          worker: worker ?? (typeof data.worker === "string" ? data.worker : undefined),
          data,
          txHash: e.txHash,
          at: new Date(e.ledgerClosedAt),
        });
      } catch {
        // beklenmeyen event şekli — atla
      }
    }
    if (res.events.length < 1000) break;
    cursor = res.cursor;
  }
  return out;
}

/** Bir dilimin zincirde ne zaman serbest bırakıldığı; bulunamazsa (ufuk dışı / henüz değil) null */
export async function trancheReleasedAt(jobId: bigint, worker: string, tranche: number): Promise<Date | null> {
  const list = await jobActivity(jobId);
  const hit = list.find((a) => a.kind === "tranche_released" && a.worker === worker && Number(a.data.tranche) === tranche);
  return hit?.at ?? null;
}

/** Bir işlemden hemen sonra çağrılır ki kartlar yeni adımın kaydını beklemeden çeksin */
export function invalidateActivity() {
  feed = null;
}
