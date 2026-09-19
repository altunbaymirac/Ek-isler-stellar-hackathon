import { Buffer } from "buffer";
import { Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import { ANCHOR_URL, NETWORK_PASSPHRASE, USDC_ISSUER } from "./config.ts";
import { payUsdc } from "./horizon.ts";
import type { Signer } from "./signer.ts";

/**
 * TR Mock Anchor istemcisi.
 * SEP-1 (toml) → SEP-10 (auth) → SEP-12 (KYC) → SEP-38 (kur) → SEP-6 (TRY yatır / çek)
 */

export const TRY_ASSET = "iso4217:TRY";
export const USDC_ASSET = `stellar:USDC:${USDC_ISSUER}`;

export interface AnchorInfo {
  webAuth: string;
  transfer: string;
  kyc: string;
  quote: string;
  signingKey: string;
}

export interface Quote {
  id?: string;
  expires_at?: string;
  price: string;
  total_price: string;
  sell_amount: string;
  buy_amount: string;
  fee?: { total: string; asset: string };
}

export interface AnchorTx {
  id: string;
  kind: string;
  status: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  stellar_transaction_id?: string;
  message?: string;
  started_at?: string;
}

async function jfetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  const txt = await r.text();
  let data: unknown = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = { raw: txt };
  }
  if (!r.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new Error(`Anchor: ${d?.error ?? d?.message ?? `HTTP ${r.status}`}`);
  }
  return data as T;
}

const tomlValue = (toml: string, key: string) =>
  toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];

/** SEP-1: stellar.toml'dan uç noktaları keşfet */
export async function discover(): Promise<AnchorInfo> {
  const toml = await (await fetch(`${ANCHOR_URL}/.well-known/stellar.toml`)).text();
  const get = (k: string) => {
    const v = tomlValue(toml, k);
    if (!v) throw new Error(`stellar.toml içinde ${k} yok`);
    return v;
  };
  return {
    webAuth: get("WEB_AUTH_ENDPOINT"),
    transfer: get("TRANSFER_SERVER"),
    kyc: get("KYC_SERVER"),
    quote: get("ANCHOR_QUOTE_SERVER"),
    signingKey: get("SIGNING_KEY"),
  };
}

/** SEP-10: challenge'ı cüzdanla imzala, JWT al */
export async function login(info: AnchorInfo, signer: Signer): Promise<string> {
  const ch = await jfetch<{ transaction: string }>(
    `${info.webAuth}?account=${signer.address}`,
  );
  const tx = TransactionBuilder.fromXDR(ch.transaction, NETWORK_PASSPHRASE);
  if (tx.source !== info.signingKey) throw new Error("SEP-10 challenge anchor tarafından imzalanmamış");
  const { signedTxXdr } = await signer.signTransaction(ch.transaction, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: signer.address,
  });
  const res = await jfetch<{ token: string }>(info.webAuth, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedTxXdr }),
  });
  return res.token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** SEP-12: KYC durumunu sorgula; eksikse bilgileri gönder */
export async function ensureKyc(
  info: AnchorInfo,
  token: string,
  account: string,
  fields: Record<string, string> = {},
): Promise<string> {
  const cur = await jfetch<{ status: string }>(`${info.kyc}/customer?account=${account}`, {
    headers: auth(token),
  });
  if (cur.status === "ACCEPTED") return cur.status;
  await jfetch(`${info.kyc}/customer`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ account, ...fields }),
  });
  const after = await jfetch<{ status: string }>(`${info.kyc}/customer?account=${account}`, {
    headers: auth(token),
  });
  return after.status;
}

/** SEP-38: gösterge kur (auth gerekmez) */
export function price(info: AnchorInfo, sell: string, buy: string, sellAmount: string) {
  const q = new URLSearchParams({ sell_asset: sell, buy_asset: buy, sell_amount: sellAmount, context: "sep6" });
  return jfetch<Quote>(`${info.quote}/price?${q}`);
}

/** SEP-38: bağlayıcı (firm) kur teklifi */
export function firmQuote(info: AnchorInfo, token: string, sell: string, buy: string, sellAmount: string) {
  return jfetch<Quote>(`${info.quote}/quote`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ sell_asset: sell, buy_asset: buy, sell_amount: sellAmount, context: "sep6" }),
  });
}

export interface DepositInstructions {
  id: string;
  how?: string;
  bank?: string;
  iban?: string;
  reference?: string;
}

/** SEP-6 deposit-exchange: TRY havale et, SEP-38 kuru üzerinden USDC al */
export async function startDeposit(
  info: AnchorInfo,
  token: string,
  account: string,
  amountTry: string,
  quoteId?: string,
): Promise<DepositInstructions> {
  type Resp = { id: string; how?: string; instructions?: Record<string, { value: string }> };
  let d: Resp;
  if (quoteId) {
    const q = new URLSearchParams({
      destination_asset: "USDC",
      source_asset: TRY_ASSET,
      amount: amountTry,
      quote_id: quoteId,
      account,
      type: "bank_account",
      funding_method: "bank_account",
    });
    d = await jfetch<Resp>(`${info.transfer}/deposit-exchange?${q}`, { headers: auth(token) });
  } else {
    const q = new URLSearchParams({
      asset_code: "USDC",
      account,
      amount: amountTry,
      type: "bank_account",
      funding_method: "bank_account",
    });
    d = await jfetch<Resp>(`${info.transfer}/deposit?${q}`, { headers: auth(token) });
  }
  const ins = d.instructions ?? {};
  return {
    id: d.id,
    how: d.how,
    bank: ins.bank_name?.value,
    iban: ins.bank_account_number?.value,
    reference: ins.external_transfer_memo?.value,
  };
}

/** Sandbox: müşterinin bankadan TRY havalesini simüle et */
export function simulateBankTransfer(info: AnchorInfo, id: string, amountTry: string) {
  return jfetch(`${info.transfer}/tx/${id}/simulate-bank-transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: Number(amountTry).toFixed(2) }),
  });
}

export async function getTx(info: AnchorInfo, token: string, id: string): Promise<AnchorTx> {
  const r = await jfetch<{ transaction: AnchorTx }>(`${info.transfer}/transaction?id=${id}`, {
    headers: auth(token),
  });
  return r.transaction;
}

export async function pollTx(
  info: AnchorInfo,
  token: string,
  id: string,
  onStatus?: (t: AnchorTx) => void,
  tries = 48,
): Promise<AnchorTx> {
  for (let i = 0; i < tries; i++) {
    const t = await getTx(info, token, id);
    onStatus?.(t);
    if (["completed", "error", "refunded", "expired"].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("Anchor işlemi zaman aşımına uğradı");
}

export function listTxs(info: AnchorInfo, token: string) {
  return jfetch<{ transactions: AnchorTx[] }>(`${info.transfer}/transactions?asset_code=USDC`, {
    headers: auth(token),
  }).then((r) => r.transactions ?? []);
}

/** SEP-6 withdraw: USDC'yi anchor'a memo ile gönder, anchor IBAN'a TRY öder */
export async function withdraw(
  info: AnchorInfo,
  token: string,
  signer: Signer,
  amountUsdc: string,
): Promise<{ id: string; hash: string }> {
  const q = new URLSearchParams({ asset_code: "USDC", type: "bank_account", amount: amountUsdc });
  const w = await jfetch<{ id: string; account_id: string; memo: string; memo_type: string }>(
    `${info.transfer}/withdraw?${q}`,
    { headers: auth(token) },
  );
  const memo =
    w.memo_type === "id"
      ? Memo.id(String(w.memo))
      : w.memo_type === "hash"
        ? Memo.hash(Buffer.from(w.memo, "base64").toString("hex"))
        : Memo.text(String(w.memo));
  const hash = await payUsdc(signer, w.account_id, Number(amountUsdc).toFixed(7), memo);
  return { id: w.id, hash };
}

/** Checksum'ı geçerli, rastgele sandbox TR IBAN'ı üretir (TR + 2 kontrol + 22 hane). */
export function randomTestIban(): string {
  const bban = "00099" + "0" + Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join("");
  return ibanFromBban(bban);
}

export function ibanFromBban(bban: string): string {
  // "TR00" sona alınır; T=29, R=27
  const rearranged = BigInt(bban + "292700");
  const check = 98n - (rearranged % 97n);
  return `TR${check.toString().padStart(2, "0")}${bban}`;
}

export function isValidTrIban(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^TR\d{24}$/.test(s)) return false;
  return BigInt(s.slice(4) + "2927" + s.slice(2, 4)) % 97n === 1n;
}
