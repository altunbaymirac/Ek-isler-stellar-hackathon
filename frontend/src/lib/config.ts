import { Asset, Networks } from "@stellar/stellar-sdk";

// Tarayıcıda Vite `import.meta.env`'i derleme anında yerine koyar; tarayıcısız scriptler
// (scripts/e2e*.ts) ise `process.env` kullanır. İkisini de destekle, yoksa scriptler
// koda gömülü varsayılan kontrata bağlanır.
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const nodeEnv: Record<string, string | undefined> =
  typeof process !== "undefined" && process.env ? process.env : {};
const env: Record<string, string | undefined> = { ...nodeEnv, ...viteEnv };

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON_URL = env.VITE_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export const CONTRACT_ID =
  env.VITE_CONTRACT_ID ?? "CBPHNMV5DZ3IFT43GRQ6NS65U5W6KTRBENHK3NWFUXJCWTIK3BD72BMT";

export const ANCHOR_URL = env.VITE_ANCHOR_URL ?? "https://tr-mock-anchor.fly.dev";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = new Asset("USDC", USDC_ISSUER);
// USDC'nin Stellar Asset Contract adresi (stellar contract id asset --asset USDC:<issuer> --network testnet)
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_DECIMALS = 7;

/** Trustless Work'ün escrow görüntüleyicisi (zincirden okur) */
export const twViewer = (escrow: string) => `https://viewer.trustlesswork.com/testnet/v1/${escrow}`;

export const expertTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const expertAccount = (id: string) =>
  `https://stellar.expert/explorer/testnet/${id.startsWith("C") ? "contract" : "account"}/${id}`;
