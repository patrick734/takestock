import type { Address, PublicClient } from "viem";
import { bookAbi } from "./bookAbi.js";

/** BookTakestock ABI (generated from the compiled contract). `limitBookAbi` is the same, kept for older imports. */
export { bookAbi };
export const limitBookAbi = bookAbi;

export enum OrderStatus {
  None = 0,
  Open = 1,
  Filled = 2,
  Cancelled = 3,
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type LimitOrder = {
  id: bigint;
  maker: Address;
  expiry: bigint;
  status: OrderStatus;
  partialFill: boolean;
  stopBelow: boolean;
  feedPricesIn: boolean;
  triggered: boolean;
  tokenIn: Address;
  maxAge: number;
  tokenOut: Address;
  amountIn: bigint;
  remaining: bigint;
  minAmountOut: bigint;
  stopMinOut: bigint;
  feed: Address;
  stopPrice: bigint;
  received: bigint;
};

/** What kind of order this is, from its legs. */
export type OrderKind = "limit" | "stop" | "bracket";
export function orderKind(o: Pick<LimitOrder, "minAmountOut" | "feed">): OrderKind {
  const stop = o.feed.toLowerCase() !== ZERO_ADDRESS;
  if (stop && o.minAmountOut > 0n) return "bracket";
  return stop ? "stop" : "limit";
}

type RawOrder = Omit<LimitOrder, "id" | "status"> & { status: number };
const toOrder = (o: RawOrder, id: bigint): LimitOrder => ({ ...o, id, status: o.status as OrderStatus, maxAge: Number(o.maxAge) });

/** Reads orders [from, count) in pages. */
export async function readOrders(client: PublicClient, book: Address, from = 0n, page = 200n): Promise<LimitOrder[]> {
  const count = (await client.readContract({ address: book, abi: bookAbi, functionName: "orderCount" })) as bigint;
  const out: LimitOrder[] = [];
  for (let i = from; i < count; i += page) {
    const to = i + page > count ? count : i + page;
    const list = (await client.readContract({ address: book, abi: bookAbi, functionName: "getOrders", args: [i, to] })) as readonly RawOrder[];
    list.forEach((o, k) => out.push(toOrder(o, i + BigInt(k))));
  }
  return out;
}

/** Reads one maker's orders, newest first. */
export async function readOrdersOf(client: PublicClient, book: Address, maker: Address): Promise<LimitOrder[]> {
  const ids = (await client.readContract({ address: book, abi: bookAbi, functionName: "orderIdsOf", args: [maker] })) as readonly bigint[];
  const orders = await Promise.all(ids.map((id) => client.readContract({ address: book, abi: bookAbi, functionName: "getOrder", args: [id] })));
  return orders.map((o, k) => toOrder(o as RawOrder, ids[k])).reverse();
}

/** Stop state as the contract sees it right now. */
export async function readStopState(client: PublicClient, book: Address, id: bigint) {
  const [usable, latched, price, updatedAt] = (await client.readContract({
    address: book,
    abi: bookAbi,
    functionName: "stopState",
    args: [id],
  })) as readonly [boolean, boolean, bigint, bigint];
  return { usable, latched, price, updatedAt };
}

/** ceil(x * part / whole), as the contract rounds a partial floor. */
export function proRata(x: bigint, part: bigint, whole: bigint): bigint {
  if (part === whole) return x;
  return (x * part + whole - 1n) / whole;
}

const MAX = (1n << 256n) - 1n;

/** The least the maker must get for filling `amount` now (after the fee), exactly as the contract computes it
 *  (the stop floor follows Chainlink's fresh price); null if no leg can be used. */
export async function readRequired(client: PublicClient, book: Address, id: bigint, amount: bigint): Promise<bigint | null> {
  const need = (await client.readContract({ address: book, abi: bookAbi, functionName: "requiredOut", args: [id, amount] })) as bigint;
  return need === MAX ? null : need;
}

/**
 * What the maker would get from a quote after the fees, and whether that meets `need`.
 * `bufferBps` leaves room for the price to move between quote and inclusion.
 */
export function fillable(quotedOut: bigint, feeBps: bigint, need: bigint | null, bufferBps = 5n) {
  const makerGets = quotedOut - (quotedOut * feeBps) / 10_000n;
  if (need === null) return { makerGets, need: null, ok: false };
  return { makerGets, need, ok: makerGets >= need + (need * bufferBps) / 10_000n };
}

/** Partial-fill sizes worth trying, largest first, that the contract accepts (>= 5% moved, >= 5% or nothing left). */
export function partialSizes(o: LimitOrder): bigint[] {
  if (!o.partialFill) return [o.remaining];
  const min = (o.amountIn + 19n) / 20n;
  const out = [o.remaining];
  for (const div of [2n, 4n, 8n]) {
    const a = o.remaining / div;
    if (a >= min && o.remaining - a >= min) out.push(a);
  }
  return out;
}

/** Inputs for `place(Params)`. Leave the stop fields out for a plain limit order. */
export type PlaceParams = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  expiry: bigint;
  partialFill: boolean;
  feed: Address;
  stopPrice: bigint;
  stopBelow: boolean;
  feedPricesIn: boolean;
  stopMinOut: bigint;
  maxAge: number;
};

export function placeParams(p: Partial<PlaceParams> & Pick<PlaceParams, "tokenIn" | "tokenOut" | "amountIn" | "expiry">): PlaceParams {
  return {
    minAmountOut: 0n,
    partialFill: false,
    feed: ZERO_ADDRESS,
    stopPrice: 0n,
    stopBelow: false,
    feedPricesIn: false,
    stopMinOut: 0n,
    maxAge: 0,
    ...p,
  };
}

/**
 * Limit price helpers. Price is quoted as "tokenOut per 1 tokenIn" in human units, e.g.
 * buying NVDA with USDG at $170 means minAmountOut = amountIn / 170 (NVDA per USDG).
 */
export function minOutForBuy(amountInUsd: bigint, usdDecimals: number, stockDecimals: number, limitPriceUsd: number): bigint {
  const priceScaled = BigInt(Math.round(limitPriceUsd * 1e8));
  return (amountInUsd * 10n ** BigInt(stockDecimals) * 100_000_000n) / (priceScaled * 10n ** BigInt(usdDecimals));
}

export function minOutForSell(amountInShares: bigint, stockDecimals: number, usdDecimals: number, limitPriceUsd: number): bigint {
  const priceScaled = BigInt(Math.round(limitPriceUsd * 1e8));
  return (amountInShares * priceScaled * 10n ** BigInt(usdDecimals)) / (100_000_000n * 10n ** BigInt(stockDecimals));
}

/** A USD price as a Chainlink answer with `decimals` (8 for the Robinhood stock feeds). */
export function feedPrice(usd: number, decimals = 8): bigint {
  return BigInt(Math.round(usd * 10 ** Math.min(decimals, 8))) * 10n ** BigInt(Math.max(0, decimals - 8));
}
