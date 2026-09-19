import { createContext, useContext } from "react";
import type { Balances } from "./lib/horizon.ts";
import type { Signer } from "./lib/signer.ts";

export interface AppState {
  signer: Signer | null;
  demo: Record<string, Signer>;
  wallet: Signer | null;
  balances: Balances | null;
  refreshBalances: () => Promise<void>;
  /** 1 USDC kaç TRY (SEP-38 gösterge kur) */
  tryPerUsdc: number | null;
  nameOf: (address: string) => string;
  jobsVersion: number;
  bumpJobs: () => void;
  goTo: (tab: Tab) => void;
}

export type Tab = "jobs" | "create" | "ramp";

export const AppCtx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(AppCtx);
