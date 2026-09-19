import { Keypair } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./config.ts";
import { getLang } from "./i18n.ts";
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
  tr: { label: string; hint: string };
  en: { label: string; hint: string };
  /** Kullanıcının kendi eklediği rol mü? Yalnızca bunlar silinebilir. */
  custom?: boolean;
}

export const DEMO_ROLES: DemoRole[] = [
  { key: "client", tr: { label: "İşveren", hint: "Parayı escrow'a kilitler, işi kapatır" }, en: { label: "Employer", hint: "Locks the money in escrow, closes the job" } },
  { key: "contractor", tr: { label: "İhaleci", hint: "İşi tanımlar, sahada kodları verir" }, en: { label: "Contractor", hint: "Defines the job, hands out codes on site" } },
  { key: "w1", tr: { label: "İtalyanca Çevirmen", hint: "Kodu girer, QR ile payını alır" }, en: { label: "Italian Interpreter", hint: "Enters the code, gets paid by QR" } },
  { key: "w2", tr: { label: "Kameraman", hint: "Kodu girer, QR ile payını alır" }, en: { label: "Camera Operator", hint: "Enters the code, gets paid by QR" } },
  { key: "arbiter", tr: { label: "Hakem", hint: "Anlaşmazlıkta karar verir" }, en: { label: "Arbiter", hint: "Decides disputes" } },
];

export const roleText = (r: DemoRole) => (getLang() === "en" ? r.en : r.tr);

const LS_KEY = "ekisler.demo.v1";
const LS_CUSTOM = "ekisler.roles.v1";

/** Kullanıcının eklediği demo rolleri (ör. "Garson", "Ses teknisyeni"); bu tarayıcıda saklanır */
export function loadCustomRoles(): DemoRole[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_CUSTOM) ?? "[]") as { key: string; label: string }[];
    return list.map(customRole);
  } catch {
    return [];
  }
}

function customRole({ key, label }: { key: string; label: string }): DemoRole {
  return {
    key,
    tr: { label, hint: "Kodu girer, QR ile payını alır" },
    en: { label, hint: "Enters the code, gets paid by QR" },
    custom: true,
  };
}

function saveCustomRoles(roles: DemoRole[]) {
  try {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(roles.map((r) => ({ key: r.key, label: r.tr.label }))));
  } catch {
    /* gizli pencere: rol bu oturumla sınırlı kalır */
  }
}

/** Yeni bir demo rolü ekler; hesabı bir sonraki loadDemoSigners'da oluşur */
export function addCustomRole(label: string): DemoRole {
  const role = customRole({ key: `c${Date.now().toString(36)}`, label: label.trim() });
  saveCustomRoles([...loadCustomRoles(), role]);
  return role;
}

export function removeCustomRole(key: string) {
  saveCustomRoles(loadCustomRoles().filter((r) => r.key !== key));
}

export const allRoles = () => [...DEMO_ROLES, ...loadCustomRoles()];

export function loadDemoSigners(): Record<string, Signer> {
  let secrets: Record<string, string> = {};
  try {
    secrets = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
  } catch {
    secrets = {};
  }
  let changed = false;
  const out: Record<string, Signer> = {};
  for (const r of allRoles()) {
    let kp: Keypair;
    try {
      kp = Keypair.fromSecret(secrets[r.key]);
    } catch {
      kp = Keypair.random();
      secrets[r.key] = kp.secret();
      changed = true;
    }
    out[r.key] = keypairSigner(kp, r.tr.label);
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
