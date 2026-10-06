import { zeroAddress, type Address } from "viem";

/** Native ETH, the same convention Uniswap v4 and the router use. */
export const NATIVE: Address = zeroAddress;

/** Mirrors HopKind in RouteTypes.sol. */
export enum HopKind {
  V3 = 0,
  V4 = 1,
  WRAP = 2,
  UNWRAP = 3,
}

export type Hop = {
  kind: HopKind;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type ChainConfig = {
  chainId: number;
  v3Factory: Address;
  poolManager: Address;
  weth: Address;
  /** Hub tokens a path may pass through (besides WETH/ETH, which are always hubs). */
  hubs: Address[];
  /** Deployed SplitQuoter. Leave undefined to quote "deployless" (the quoter code runs inside eth_call). */
  quoter?: Address;
  /** Deployed SplitRouter. Undefined = quotes only, no swaps. */
  router?: Address;
  multicall3?: Address;
};

export type Pool = {
  version: 3 | 4;
  /** v3: pool address. v4: poolId. */
  id: `0x${string}`;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
};

/** A v4 pool as stored by the indexer (state is read live). */
export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type Path = {
  hops: Hop[];
  /** Pools used, in order (ids). Two paths can share a split only if these don't overlap. */
  pools: string[];
  /** Tokens visited, tokenIn first. */
  tokens: Address[];
  /** Short human label, e.g. "USDG → WETH (v3 0.05%) → CASHCAT (v3 1%)". */
  label: string;
};

export type PlanLeg = { path: Path; amountIn: bigint; amountOut: bigint; share: number };

export type Plan = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  legs: PlanLeg[];
  /** Best single path at the full size, for comparison. */
  bestSingle: { path: Path; amountOut: bigint } | null;
  /** How much the split adds over the best single path, in basis points. */
  splitGainBps: number;
  /** Price impact vs. a tiny trade on the best path, in basis points. */
  impactBps: number;
  pathsConsidered: number;
  quotedAt: number;
};
