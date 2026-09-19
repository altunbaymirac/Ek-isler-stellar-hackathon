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
import { CODE_ARRIVAL, CODE_FINAL, CODES, commitReading, distanceM, makeCodes } from "../src/lib/codes.ts";

const log = (...a: unknown[]) => console.log("•", ...a);

const client = keypairSigner(Keypair.random(), "Müşteri");
const contractor = keypairSigner(Keypair.random(), "İhaleci");
const w1 = keypairSigner(Keypair.random(), "Japonca tercüman");
const w2 = keypairSigner(Keypair.random(), "İspanyolca tercüman");
const arbiter = keypairSigner(Keypair.random(), "Hakem");
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
  arbiter: arbiter.address,
  totalUsdc: total,
  shares: [
    { address: contractor.address, share_bps: 5000 },
    { address: w1.address, share_bps: 3200 },
    { address: w2.address, share_bps: 1800 },
  ],
  deadline: new Date(Date.now() + 2 * 24 * 3600 * 1000),
  // Kod 2 yoklaması çalışma saatlerinin tam ortasında açılır; senaryo beklemesin diye orta nokta "şimdi"
  workStart: new Date(Date.now() - 60_000),
  workEnd: new Date(Date.now() + 60_000),
  venue: { lat: 41.0339, lng: 28.9772, radiusM: 300 },
});
const id = created.result;
log(`create_job #${id} (${total} USDC)`, created.hash);

const { codes, commitments } = await makeCodes(3);
try {
  await c.depositJob(client, id);
  throw new Error("HATA: onaysız deposit geçti!");
} catch (e) {
  log("Onaysız deposit reddedildi ✓", c.friendlyError(e));
}

log("accept w1", (await c.acceptJob(w1, id)).hash);
log("accept w2", (await c.acceptJob(w2, id)).hash);
log("deposit · işveren parayı kilitler", (await c.depositJob(client, id)).hash);
try {
  await c.checkIn(w1, id, codes[1 * CODES + CODE_ARRIVAL]);
  throw new Error("HATA: kodlar belirlenmeden check_in geçti!");
} catch (e) {
  log("Kodlar belirlenmeden Kod 1 reddedildi ✓", c.friendlyError(e));
}
log("set_codes · ihaleci saha kodlarını yazar", (await c.setCodes(contractor, id, commitments)).hash);
const escrowId = (await c.getJob(id)).escrow;
log("Trustless Work escrow:", escrowId, "bakiye:", (await getBalances(escrowId).catch(() => null)) ?? "(kontrat)");
log("  görüntüleyici:", `https://viewer.trustlesswork.com/testnet/v1/${escrowId}`);

// w1: ihaleci sahada Kod 1'i elden verir — para hareket etmemeli
const before = (await getBalances(w1.address)).usdc;
log("w1 Kod 1 · varış", (await c.checkIn(w1, id, codes[1 * CODES + CODE_ARRIVAL])).hash);
const afterArrival = (await getBalances(w1.address)).usdc;
log(`Kod 1 sonrası w1 bakiyesi ${before} → ${afterArrival} ${before === afterArrival ? "(değişmedi ✓)" : "(HATA: para hareket etti!)"}`);
log("w1 geldi mi:", (await c.getJob(id)).stakeholders[1].arrived);

try {
  await c.claimPayment(w1, id, codes[2 * CODES + CODE_FINAL]);
  throw new Error("HATA: başkasının gün sonu QR'ı geçti!");
} catch (e) {
  log("Başka çalışanın gün sonu QR'ı reddedildi ✓", c.friendlyError(e));
}

// Kod 2 · yoklama penceresi (çalışma saatlerinin ortası + 15 dk): para hareket etmemeli
log("Kod 2 · ihaleci 'herkes çalışıyor' dedi", (await c.confirmPresenceAll(contractor, id, [])).hash);
const afterCheck = (await getBalances(w1.address)).usdc;
log(`Kod 2 sonrası w1 bakiyesi ${afterCheck} ${afterArrival === afterCheck ? "(değişmedi ✓)" : "(HATA: para hareket etti!)"}`);

// Gün sonu QR'ı: payın tamamı tek seferde
const m = await c.claimPayment(w1, id, codes[1 * CODES + CODE_FINAL]);
log("w1 gün sonu QR →", c.fromUnits(m.result, 4), "USDC", m.hash);

// w2: ihaleci Kod 1'i vermiyor → konum kanıtı + hakem
const loc = await commitReading({ lat: 41.03395, lng: 28.97725, at: Date.now() });
const meters = Math.round(distanceM(41.03395, 28.97725, 41.0339, 28.9772));
log(`w2 konum kanıtı (${meters} m, zincirde yalnızca mesafe + hash)`, (await c.submitLocation(w2, id, meters, loc.hash)).hash);
await ensureReady(arbiter);
log("hakem w2'yi gelmiş işaretledi (ödeme değil)", (await c.arbiterConfirmArrival(arbiter, id, w2.address)).hash);
const r = await c.arbiterRelease(arbiter, id, w2.address);
log("hakem w2 payını serbest bıraktı →", c.fromUnits(r.result, 4), "USDC", r.hash);

log("complete_and_split", (await c.completeJob(client, id)).hash);
const job = await c.getJob(id);
log("durum:", c.STATUS_LABEL[job.status], "· konum kanıtı:", job.locations.length);
const tw = await c.getEscrow(escrowId);
log("TW milestone'ları:", tw.milestones.map((m) => `${m.description}:${m.flags.released ? "✓" : "…"}`).join(" "));

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
