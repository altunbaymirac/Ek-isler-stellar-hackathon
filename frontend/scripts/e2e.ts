/**
 * Uçtan uca testnet senaryosu (tarayıcısız).
 *   node scripts/e2e.ts
 * 4 yeni testnet hesabı açar: müşteri, ihaleci, 2 tercüman.
 * Müşteri TRY yatırır (SEP-10/12/38/6) → USDC ile iş fonlanır → dağıtılır → tercüman TRY çeker.
 */
import { Keypair } from "@stellar/stellar-sdk";
import * as anchor from "../src/lib/anchor.ts";
import * as c from "../src/lib/contract.ts";
import { ensureReady, getBalances } from "../src/lib/horizon.ts";
import { keypairSigner } from "../src/lib/signer.ts";

const log = (...a: unknown[]) => console.log("•", ...a);

const client = keypairSigner(Keypair.random(), "Müşteri");
const contractor = keypairSigner(Keypair.random(), "İhaleci");
const w1 = keypairSigner(Keypair.random(), "Japonca tercüman");
const w2 = keypairSigner(Keypair.random(), "İspanyolca tercüman");
const all = [client, contractor, w1, w2];

log("Hesaplar fonlanıyor + USDC trustline açılıyor…");
await Promise.all(all.map((s) => ensureReady(s)));

// ---- Anchor: müşteri TRY yatırır ----
const info = await anchor.discover();
log("SEP-1 ok:", info.transfer);
const token = await anchor.login(info, client);
log("SEP-10 JWT alındı");
log("SEP-12 KYC:", await anchor.ensureKyc(info, token, client.address, { first_name: "Demo", last_name: "Şirket" }));

const TRY_AMOUNT = "1000";
const quote = await anchor.firmQuote(info, token, anchor.TRY_ASSET, anchor.USDC_ASSET, TRY_AMOUNT);
log(`SEP-38 quote ${quote.id}: ${TRY_AMOUNT} TRY → ${quote.buy_amount} USDC (kur ${quote.price})`);

let dep: anchor.DepositInstructions;
try {
  dep = await anchor.startDeposit(info, token, client.address, TRY_AMOUNT, quote.id);
  log("SEP-6 deposit-exchange:", dep.id, dep.iban, dep.reference);
} catch (e) {
  log("deposit-exchange olmadı, düz deposit deneniyor:", (e as Error).message);
  dep = await anchor.startDeposit(info, token, client.address, TRY_AMOUNT);
  log("SEP-6 deposit:", dep.id, dep.iban, dep.reference);
}
await anchor.simulateBankTransfer(info, dep.id, TRY_AMOUNT);
const done = await anchor.pollTx(info, token, dep.id, (t) => process.stdout.write(`  ${t.status}\r`));
log("Deposit:", done.status, done.amount_out, "USDC", done.stellar_transaction_id);
const bal = await getBalances(client.address);
log("Müşteri USDC:", bal.usdc);

// ---- Kontrat ----
const total = (Math.floor(Number(bal.usdc) * 100) / 100).toFixed(2);
const created = await c.createJob(contractor, {
  client: client.address,
  totalUsdc: total,
  stakeholders: [
    { address: contractor.address, share_bps: 5000 },
    { address: w1.address, share_bps: 3200 },
    { address: w2.address, share_bps: 1800 },
  ],
  deadline: new Date(Date.now() + 2 * 24 * 3600 * 1000),
});
const id = created.result;
log(`create_job #${id} (${total} USDC)`, created.hash);

try {
  await c.depositJob(client, id);
  throw new Error("HATA: onaysız deposit geçti!");
} catch (e) {
  log("Onaysız deposit reddedildi ✓", c.friendlyError(e));
}

log("accept w1", (await c.acceptJob(w1, id)).hash);
log("accept w2", (await c.acceptJob(w2, id)).hash);
log("durum:", c.STATUS_LABEL[(await c.getJob(id)).status]);
log("deposit", (await c.depositJob(client, id)).hash);
log("complete_and_split", (await c.completeJob(client, id)).hash);

for (const s of all) log(s.label, (await getBalances(s.address)).usdc, "USDC");

// ---- Anchor: tercüman USDC → TRY çeker ----
const wToken = await anchor.login(info, w1);
await anchor.ensureKyc(info, wToken, w1.address, { bank_account_number: anchor.randomTestIban() });
const wAmount = (await getBalances(w1.address)).usdc!;
const sell = await anchor.price(info, anchor.USDC_ASSET, anchor.TRY_ASSET, wAmount);
log(`SEP-38 ${wAmount} USDC → ${sell.buy_amount} TRY`);
const wd = await anchor.withdraw(info, wToken, w1, wAmount);
log("SEP-6 withdraw ödeme tx:", wd.hash);
const wdDone = await anchor.pollTx(info, wToken, wd.id, (t) => process.stdout.write(`  ${t.status}\r`));
log("Withdraw:", wdDone.status, wdDone.amount_out, "TRY");
log("BİTTİ ✅");
