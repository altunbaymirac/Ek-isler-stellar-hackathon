import { Keypair, TransactionBuilder, contract } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./config.ts";

/** Hem tarayıcı cüzdanı (Wallets Kit) hem demo anahtarı için ortak imzalayıcı arayüzü. */
export interface Signer {
  address: string;
  label: string;
  kind: "demo" | "wallet";
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ) => Promise<{ signedTxXdr: string; signerAddress?: string }>;
}

/** Sadece testnet demo hesapları için: anahtar tarayıcıda üretilir, gerçek para taşımaz. */
export function keypairSigner(kp: Keypair, label: string): Signer {
  const basic = contract.basicNodeSigner(kp, NETWORK_PASSPHRASE);
  return {
    address: kp.publicKey(),
    label,
    kind: "demo",
    signTransaction: basic.signTransaction,
  };
}

export async function signXdr(signer: Signer, xdr: string) {
  const { signedTxXdr } = await signer.signTransaction(xdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
    address: signer.address,
  });
  return TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
}

export const short = (a: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
