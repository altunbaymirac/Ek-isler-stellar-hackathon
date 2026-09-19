import { Asset, Networks } from "@stellar/stellar-sdk";

const env: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON_URL = env.VITE_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export const CONTRACT_ID =
  env.VITE_CONTRACT_ID ?? "CAR5QVVWGK4FNY3SGUHO7RU3OSRXTS6JQTEDR263CMUBOKOOVNPHB5TK";

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
