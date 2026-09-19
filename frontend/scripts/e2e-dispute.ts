/**
 * Gelmeyen çalışan senaryosu (testnet, tarayıcısız):
 *   node scripts/e2e-dispute.ts
 * w1 gelir (varış QR'ı), w2 hiç gelmez. Son tarih dolunca kontrat w1 ve ihaleciye öder,
 * w2'nin milestone'larını Trustless Work'te dispute'a alır; hakem bunları işverene iade eder.
 */
import { Keypair } from "@stellar/stellar-sdk";
import * as anchor from "../src/lib/anchor.ts";
import { CODE_ARRIVAL, CODES, makeCodes } from "../src/lib/codes.ts";
import * as c from "../src/lib/contract.ts";
import { ensureReady, getBalances } from "../src/lib/horizon.ts";
import { keypairSigner } from "../src/lib/signer.ts";

const log = (...a: unknown[]) => console.log("•", ...a);
const [client, contractor, w1, w2, arbiter] = ["İşveren", "İhaleci", "w1", "w2", "Hakem"].map((l) =>
  keypairSigner(Keypair.random(), l),
);
await Promise.all([client, contractor, w1, w2, arbiter].map((s) => ensureReady(s)));

const info = await anchor.discover();
const token = await anchor.login(info, client);
await anchor.ensureKyc(info, token, client.address);
const dep = await anchor.startDeposit(info, token, client.address, "500");
await anchor.simulateBankTransfer(info, dep.id, "500");
await anchor.pollTx(info, token, dep.id);
log("İşveren USDC:", (await getBalances(client.address)).usdc);

const created = await c.createJob(contractor, {
  client: client.address,
  arbiter: arbiter.address,
  totalUsdc: "10",
  shares: [
    { address: contractor.address, share_bps: 5000 },
    { address: w1.address, share_bps: 3000 },
    { address: w2.address, share_bps: 2000 },
  ],
  deadline: new Date(Date.now() + 75_000),
  workStart: new Date(Date.now() - 30_000),
  workEnd: new Date(Date.now() + 30_000),
  venue: { lat: 41.0339, lng: 28.9772, radiusM: 300 },
});
const id = created.result;
await c.acceptJob(w1, id);
await c.acceptJob(w2, id);
const { codes, commitments } = await makeCodes(3);
await c.depositJob(client, id);
await c.setCodes(contractor, id, commitments);
const escrowId = (await c.getJob(id)).escrow;
log(`iş #${id} fonlandı · escrow https://viewer.trustlesswork.com/testnet/v1/${escrowId}`);
log("w1 Kod 1 · varış (para hareket etmez)", (await c.checkIn(w1, id, codes[1 * CODES + CODE_ARRIVAL])).hash);

const job0 = await c.getJob(id);
const wait = Number(job0.terms.deadline) * 1000 - Date.now() + 8_000;
log(`son tarih için ${Math.ceil(wait / 1000)} sn bekleniyor…`);
await new Promise((r) => setTimeout(r, Math.max(wait, 0)));

log("release_after_deadline", (await c.releaseJob(w1, id)).hash);
const job = await c.getJob(id);
log("durum:", c.STATUS_LABEL[job.status]);
const escrow = await c.getEscrow(escrowId);
const open = escrow.milestones.map((m, i) => ({ m, i })).filter(({ m }) => m.flags.disputed && !m.flags.resolved);
log("dispute'taki milestone'lar:", open.map(({ m, i }) => `#${i} ${m.description} ${c.fromUnits(m.amount)}`).join(", "));

const before = Number((await getBalances(client.address)).usdc);
for (const { m, i } of open) log(`hakem #${i} → işverene iade`, (await c.resolveToClient(arbiter, job, i, m.amount)).hash);
const after = Number((await getBalances(client.address)).usdc);
log(`İşverene iade: +${(after - before).toFixed(4)} USDC`);
for (const s of [contractor, w1, w2]) log(s.label, (await getBalances(s.address)).usdc);
log("BİTTİ ✅");
