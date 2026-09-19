import { Keypair } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./config.ts";
import { keypairSigner, type Signer } from "./signer.ts";

// ---- Stellar Wallets Kit (Freighter, xBull, Lobstr, Albedo, Hana, …) ----
let kitReady: Promise<typeof import("@creit.tech/stellar-wallets-kit/sdk")> | null = null;

function loadKit() {
  kitReady ??= (async () => {
    const [sdk, utils, types] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit/sdk"),
      import("@creit.tech/stellar-wallets-kit/modules/utils"),
      import("@creit.tech/stellar-wallets-kit/types"),
    ]);
    sdk.StellarWalletsKit.init({
      modules: utils.defaultModules(),
      network: types.Networks.TESTNET,
      theme: types.SwkAppLightTheme,
    });
    return sdk;
  })();
  return kitReady;
}

export async function connectWallet(): Promise<Signer> {
  const { StellarWalletsKit } = await loadKit();
  const { address } = await StellarWalletsKit.authModal();
  return walletSigner(address);
}

export async function disconnectWallet() {
  const { StellarWalletsKit } = await loadKit();
  await StellarWalletsKit.disconnect();
}

function walletSigner(address: string): Signer {
  return {
    address,
    label: "Cüzdanım",
    kind: "wallet",
    signTransaction: async (xdr, opts) => {
      const { StellarWalletsKit } = await loadKit();
      return StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: opts?.networkPassphrase ?? NETWORK_PASSPHRASE,
        address,
      });
    },
  };
}

// ---- Demo hesapları (yalnızca testnet, anahtarlar bu tarayıcıda saklanır) ----
export interface DemoRole {
  key: string;
  label: string;
  emoji: string;
  hint: string;
}

export const DEMO_ROLES: DemoRole[] = [
  { key: "client", label: "İşveren", emoji: "🏢", hint: "Parayı yatırır, sahada kodları gösterir" },
  { key: "contractor", label: "İhaleci", emoji: "🧑‍💼", hint: "İşi ve çalışan paylarını tanımlar" },
  { key: "w1", label: "İtalyanca Çevirmen", emoji: "🗣️", hint: "Kodları okutur, payını alır" },
  { key: "w2", label: "Kameraman", emoji: "🎥", hint: "Kodları okutur, payını alır" },
  { key: "w3", label: "Fotoğrafçı", emoji: "📷", hint: "Kodları okutur, payını alır" },
  { key: "arbiter", label: "Hakem", emoji: "⚖️", hint: "Anlaşmazlıkta karar verir" },
];

const LS_KEY = "ekisler.demo.v1";

export function loadDemoSigners(): Record<string, Signer> {
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    secrets = {};
  }
  let changed = false;
  const out: Record<string, Signer> = {};
  for (const r of DEMO_ROLES) {
    let kp: Keypair;
    try {
      kp = Keypair.fromSecret(secrets[r.key]);
    } catch {
      kp = Keypair.random();
      secrets[r.key] = kp.secret();
      changed = true;
    }
    out[r.key] = keypairSigner(kp, r.label);
  }
  if (changed) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(secrets));
    } catch {
      /* gizli pencere: demo hesapları bu oturumla sınırlı kalır */
    }
  }
  return out;
}

export function resetDemoSigners() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* yok say */
  }
  return loadDemoSigners();
}
