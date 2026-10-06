import { createConfig, http, injected } from "wagmi";
import { defineChain, type Address } from "viem";
import { robinhoodConfig, ROBINHOOD, type ChainConfig } from "@splitroute/engine";

export const CHAIN_ID = 4663;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

import deployed from "@/generated/book.json";

const addr = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined);
const gen = deployed as Partial<Record<"router" | "quoter" | "book" | "block" | "buyBurn" | "swapAdapter" | "timelock", string | number>>;
/** RouterTakestock, QuoterTakestock and BookTakestock, written into src/generated/book.json by launch.sh.
 *  The env vars only fill in when there is no deployment yet (local testing). Until then the app shows prices only. */
export const ROUTER = addr(gen.router as string) ?? addr(process.env.NEXT_PUBLIC_ROUTER);
export const QUOTER = addr(gen.quoter as string) ?? addr(process.env.NEXT_PUBLIC_QUOTER);
export const LIMIT_BOOK = addr(gen.book as string) ?? addr(process.env.NEXT_PUBLIC_LIMIT_BOOK);
/** The burn side: BuyBurnTakestock (where the protocol fee goes), its swap adapter and the 48h timelock. */
export const BURN = {
  buyBurn: addr(gen.buyBurn as string),
  swapAdapter: addr(gen.swapAdapter as string),
  timelock: addr(gen.timelock as string),
};
/** The Wells (one per Stock Token) and the credit line, added by ./launch-wells.sh. Empty until then. */
type WellEntry = { vault: string; position: string; stock: string; name: string; feed?: string };
const wellsGen = deployed as { usdg?: string; oracle?: string; feeRouter?: string; registry?: string; wells?: Record<string, WellEntry>; creditLines?: Record<string, string> };
export type Well = { ticker: string; vault: Address; position: Address; stock: Address; name: string };
export const WELLS: Well[] = Object.entries(wellsGen.wells ?? {})
  .filter(([, w]) => addr(w.vault) && addr(w.position) && addr(w.stock))
  .map(([ticker, w]) => ({ ticker, vault: w.vault as Address, position: w.position as Address, stock: w.stock as Address, name: w.name }));
export const CREDIT_LINES: { ticker: string; desk: Address; well: Well }[] = Object.entries(wellsGen.creditLines ?? {})
  .map(([ticker, desk]) => ({ ticker, desk: addr(desk)!, well: WELLS.find((w) => w.ticker === ticker)! }))
  .filter((c) => c.desk && c.well);
export const WELL_CONTRACTS = { oracle: addr(wellsGen.oracle), feeRouter: addr(wellsGen.feeRouter), registry: addr(wellsGen.registry) };
export const USDG_ADDRESS = (addr(wellsGen.usdg) ?? addr(process.env.NEXT_PUBLIC_USDG) ?? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168") as Address;

/** First block of the deployment, for event scans. */
export const BOOK_BLOCK = BigInt(Number(gen.block ?? process.env.NEXT_PUBLIC_BOOK_BLOCK ?? 0));

/** Mainnet addresses by default; every one can be overridden (used for local testing against anvil). */
const base = robinhoodConfig(ROUTER, QUOTER, process.env.NEXT_PUBLIC_NO_MULTICALL !== "1");
const usdg = addr(process.env.NEXT_PUBLIC_USDG);
export const ENGINE: ChainConfig = {
  ...base,
  v3Factory: addr(process.env.NEXT_PUBLIC_V3_FACTORY) ?? base.v3Factory,
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER) ?? base.poolManager,
  weth: addr(process.env.NEXT_PUBLIC_WETH) ?? base.weth,
  hubs: usdg ? [usdg] : base.hubs,
};
export { ROBINHOOD };

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: process.env.NEXT_PUBLIC_NO_MULTICALL === "1" ? undefined : { multicall3: { address: ROBINHOOD.multicall3 } },
});

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  transports: { [robinhoodChain.id]: http(RPC_URL, { batch: true }) },
  // The engine batches its own reads (Multicall3 when present, plain calls otherwise).
  batch: { multicall: false },
  // Static export: hydrate with the server markup first, then reconnect the wallet (avoids hydration mismatches).
  ssr: true,
});

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
