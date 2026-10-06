import type { Address, PublicClient } from "viem";
import { buildPaths } from "./paths.js";
import { loadV3Pools, loadV4Pools, usablePools } from "./pools.js";
import { planSwap, type SplitOptions } from "./split.js";
import { NATIVE, type ChainConfig, type Plan, type Pool, type V4PoolKey } from "./types.js";

export * from "./types.js";
export * from "./abi.js";
export { buildPaths, disjoint, feeLabel } from "./paths.js";
export { loadV3Pools, loadV4Pools, usablePools, discoverV4Pools, v4PoolId, midPrice } from "./pools.js";
export { planSwap, swapArgs, quoteJobs } from "./split.js";
export { ROBINHOOD, robinhoodConfig } from "./robinhood.js";
export { marketSnapshot, type MarketRow } from "./markets.js";
export { probeV4Pools, V4_STANDARD_TIERS } from "./v4probe.js";
export {
  bookAbi,
  limitBookAbi,
  OrderStatus,
  ZERO_ADDRESS,
  orderKind,
  readOrders,
  readOrdersOf,
  readStopState,
  proRata,
  readRequired,
  fillable,
  partialSizes,
  placeParams,
  minOutForBuy,
  minOutForSell,
  feedPrice,
  type LimitOrder,
  type OrderKind,
  type PlaceParams,
} from "./limit.js";

const lower = (a: string) => a.toLowerCase();

export type RouteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** Known v4 pools (from the indexer). Only those touching the route's tokens are read. */
  v4Pools?: V4PoolKey[];
  symbol?: (a: Address) => string;
} & SplitOptions;

export type RouteResult = { plan: Plan | null; pools: Pool[]; pathsConsidered: number };

/** Load pools → build paths → quote and split. One call from amount to executable plan. */
export async function findRoute(client: PublicClient, cfg: ChainConfig, req: RouteRequest): Promise<RouteResult> {
  const { tokenIn, tokenOut, amountIn } = req;
  const assets = uniq([tokenIn, tokenOut, cfg.weth, NATIVE, ...cfg.hubs]);
  const pairs: [Address, Address][] = [];
  for (let i = 0; i < assets.length; i++)
    for (let j = i + 1; j < assets.length; j++) pairs.push([assets[i], assets[j]]);

  const wanted = new Set(assets.map(lower));
  const v4Keys = (req.v4Pools ?? []).filter((k) => wanted.has(lower(k.currency0)) && wanted.has(lower(k.currency1)));

  const [v3, v4] = await Promise.all([loadV3Pools(client, cfg, pairs), loadV4Pools(client, cfg, v4Keys)]);
  const pools = usablePools([...v3, ...v4], cfg.weth);
  const paths = buildPaths(tokenIn, tokenOut, pools, cfg, { symbol: req.symbol });
  const plan = await planSwap(client, cfg, tokenIn, tokenOut, amountIn, paths, req);
  return { plan, pools, pathsConsidered: paths.length };
}

function uniq(xs: Address[]): Address[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(lower(x)) ? false : (seen.add(lower(x)), true)));
}
