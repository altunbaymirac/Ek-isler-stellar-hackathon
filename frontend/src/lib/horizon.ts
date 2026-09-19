import { BASE_FEE, Horizon, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, HORIZON_URL, NETWORK_PASSPHRASE, USDC, USDC_ISSUER } from "./config.ts";
import { signXdr, type Signer } from "./signer.ts";

export const horizon = new Horizon.Server(HORIZON_URL);

export interface Balances {
  funded: boolean;
  xlm: string;
  usdc: string | null; // null = trustline yok
}

export async function getBalances(address: string): Promise<Balances> {
  try {
    const acct = await horizon.loadAccount(address);
    let xlm = "0";
    let usdc: string | null = null;
    for (const b of acct.balances) {
      if (b.asset_type === "native") xlm = b.balance;
      else if ("asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER)
        usdc = b.balance;
    }
    return { funded: true, xlm, usdc };
  } catch (e) {
    if ((e as { response?: { status?: number } }).response?.status === 404)
      return { funded: false, xlm: "0", usdc: null };
    throw e;
  }
}

export async function fundWithFriendbot(address: string) {
  const r = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
  if (!r.ok && r.status !== 400) throw new Error(`Friendbot hatası: HTTP ${r.status}`);
}

/** Hesap yoksa fonlar, USDC trustline yoksa açar. Workers dahil herkes USDC alabilmek için buna ihtiyaç duyar. */
export async function ensureReady(signer: Signer): Promise<Balances> {
  let bal = await getBalances(signer.address);
  if (!bal.funded) {
    await fundWithFriendbot(signer.address);
    bal = await getBalances(signer.address);
  }
  if (bal.usdc === null) {
    const acct = await horizon.loadAccount(signer.address);
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(120)
      .build();
    await horizon.submitTransaction(await signXdr(signer, tx.toXDR()));
    bal = await getBalances(signer.address);
  }
  return bal;
}

export async function payUsdc(signer: Signer, destination: string, amount: string, memo?: Memo) {
  const acct = await horizon.loadAccount(signer.address);
  const builder = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination, asset: USDC, amount }))
    .setTimeout(120);
  if (memo) builder.addMemo(memo);
  const res = await horizon.submitTransaction(await signXdr(signer, builder.build().toXDR()));
  return res.hash;
}
