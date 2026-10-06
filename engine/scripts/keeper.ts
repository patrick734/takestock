/**
 * Takestock book keeper: fills open orders on BookTakestock the moment a leg holds (limit / take-profit
 * price reached, or the Chainlink stop triggered), in parts when the maker allows it, and sends expired
 * orders' deposits back to their makers.
 *
 * Runs on GitHub Actions (.github/workflows/book-keeper.yml): each run watches the book for RUN_FOR_MS and exits.
 *   RPC_URL=...  KEEPER_PRIVATE_KEY=... (GitHub secret)  KEEPER_LIVE=1  npx tsx scripts/keeper.ts
 *
 * Without KEEPER_LIVE=1 it is a dry run: it finds and simulates fills and refunds but sends nothing.
 * The key only pays gas and receives the filler fee; it cannot touch anyone's deposit (the contract pays makers).
 *
 * Addresses come from ../web/src/generated/book.json (written by launch.sh); LIMIT_BOOK / ROUTER / QUOTER override.
 * Optional: POLL_MS (15000), RUN_FOR_MS (0 = forever), BUFFER_BPS (5), REFUND_EXPIRED (1), ONCE=1,
 * and V3_FACTORY / POOL_MANAGER / WETH / USDG / NO_MULTICALL / CHAIN_ID overrides for local tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { findRoute, swapArgs } from "../src/index.js";
import { bookAbi, fillable, OrderStatus, partialSizes, readOrders, readRequired, readStopState, ZERO_ADDRESS, type LimitOrder } from "../src/limit.js";
import { ROBINHOOD, robinhoodConfig } from "../src/robinhood.js";
import { NATIVE, type V4PoolKey } from "../src/types.js";
import { probeV4Pools } from "../src/v4probe.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`set ${k}`);
  return v;
};
const GEN = new URL("../../web/src/generated/book.json", import.meta.url);
const gen = existsSync(GEN) ? (JSON.parse(readFileSync(GEN, "utf8")) as Partial<Record<"book" | "router" | "quoter", Address>>) : {};
const isAddr = (v?: string): v is Address => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);
const BOOK = (process.env.LIMIT_BOOK || gen.book) as Address;
const ROUTER = (process.env.ROUTER || gen.router) as Address;
const QUOTER = (process.env.QUOTER || gen.quoter) as Address;
if (!isAddr(BOOK) || !isAddr(ROUTER)) {
  console.log("No BookTakestock deployment yet (web/src/generated/book.json). Nothing to do.");
  process.exit(0);
}
const RPC = env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
const KEY = (process.env.KEEPER_PRIVATE_KEY || process.env.KEEPER_KEY || "") as `0x${string}`;
delete process.env.KEEPER_PRIVATE_KEY; // keep it out of anything that dumps the environment
delete process.env.KEEPER_KEY;
const LIVE = process.env.KEEPER_LIVE === "1";
const POLL = Number(env("POLL_MS", "15000"));
const RUN_FOR = Number(env("RUN_FOR_MS", "0"));
const BUFFER = BigInt(env("BUFFER_BPS", "5"));
const REFUND = env("REFUND_EXPIRED", "1") === "1";
const ONCE = process.env.ONCE === "1";
if (LIVE && !/^0x[0-9a-fA-F]{64}$/.test(KEY)) throw new Error("KEEPER_LIVE=1 needs KEEPER_PRIVATE_KEY");

const chain = defineChain({
  id: Number(env("CHAIN_ID", String(ROBINHOOD.chainId))),
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const client = createPublicClient({ chain, transport: http(RPC, { batch: true, retryCount: 3 }) }) as PublicClient;
const account = /^0x[0-9a-fA-F]{64}$/.test(KEY) ? privateKeyToAccount(KEY) : undefined;
const wallet = account ? createWalletClient({ account, chain, transport: http(RPC) }) : undefined;
// Dry runs simulate as a neutral address when no key is configured.
const sender = (account?.address ?? "0x000000000000000000000000000000000000dEaD") as Address;

const base = robinhoodConfig(ROUTER, isAddr(QUOTER) ? QUOTER : undefined, process.env.NO_MULTICALL !== "1");
const cfg = {
  ...base,
  ...(process.env.V3_FACTORY ? { v3Factory: process.env.V3_FACTORY as Address } : {}),
  ...(process.env.POOL_MANAGER ? { poolManager: process.env.POOL_MANAGER as Address } : {}),
  ...(process.env.WETH ? { weth: process.env.WETH as Address } : {}),
  ...(process.env.USDG ? { hubs: [process.env.USDG as Address] } : {}),
};
const lower = (a: string) => a.toLowerCase();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const first = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0];

// v4 pools per token, probed once and refreshed every 30 minutes.
const v4Cache = new Map<string, { at: number; keys: V4PoolKey[] }>();
async function v4For(tokens: Address[]): Promise<V4PoolKey[]> {
  const hubs = [cfg.hubs[0], NATIVE, cfg.weth];
  const want = tokens.filter((t) => !hubs.map(lower).includes(lower(t)));
  const out: V4PoolKey[] = [];
  for (const t of want) {
    const c = v4Cache.get(lower(t));
    if (c && Date.now() - c.at < 30 * 60_000) {
      out.push(...c.keys);
      continue;
    }
    const keys = await probeV4Pools(client, cfg, [t], hubs).catch(() => []);
    v4Cache.set(lower(t), { at: Date.now(), keys });
    out.push(...keys);
  }
  return out;
}

// Total fee taken from a fill's output (filler + protocol; native ETH output pays no protocol fee), per tokenOut.
const feeCache = new Map<string, bigint>();
async function feeFor(tokenOut: Address) {
  const k = lower(tokenOut);
  if (!feeCache.has(k)) feeCache.set(k, (await client.readContract({ address: BOOK, abi: bookAbi, functionName: "feeBpsFor", args: [tokenOut] })) as bigint);
  return feeCache.get(k)!;
}
let firstOpen = 0n; // orders below this id are all closed; skip them on later passes

async function send(functionName: "fill" | "cancel", args: readonly unknown[], what: string) {
  const { request } = await client.simulateContract({ account: account ?? sender, address: BOOK, abi: bookAbi, functionName, args } as never);
  if (!LIVE || !wallet) {
    log(`[dry run] would ${what}`);
    return;
  }
  const hash = await wallet.writeContract(request as never);
  const r = await client.waitForTransactionReceipt({ hash });
  log(`${what}: ${r.status} tx=${hash}`);
}

async function tryFill(o: LimitOrder, now: bigint) {
  const hasStop = lower(o.feed) !== lower(ZERO_ADDRESS);
  const stopUsable = hasStop ? (await readStopState(client, BOOK, o.id)).usable : false;
  if (o.minAmountOut === 0n && !stopUsable) return; // a stop that has not triggered, and no limit leg
  const v4Pools = await v4For([o.tokenIn, o.tokenOut]);
  for (const amount of partialSizes(o)) {
    const need = await readRequired(client, BOOK, o.id, amount); // exact, incl. the Chainlink-scaled stop floor
    if (need === null) return;
    const { plan } = await findRoute(client, cfg, { tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: amount, v4Pools, slippageBps: 0 });
    if (!plan) continue;
    const { makerGets, ok } = fillable(plan.amountOut, await feeFor(o.tokenOut), need, BUFFER);
    if (!ok) continue;
    const legs = swapArgs(plan, BOOK)[2];
    const part = amount === o.remaining ? "" : ` part ${amount}/${o.remaining}`;
    const leg = o.minAmountOut === 0n ? "stop" : stopUsable ? "limit or stop" : "limit";
    try {
      await send("fill", [o.id, amount, legs, now + 120n], `fill #${o.id} (${leg})${part} maker≈${makerGets} need=${need} legs=${legs.length}`);
    } catch (e) {
      log(`fill #${o.id} skipped: ${first(e)}`);
    }
    return;
  }
}

async function pass() {
  const orders = await readOrders(client, BOOK, firstOpen);
  const now = (await client.getBlock()).timestamp; // chain time, not the runner clock
  const open = orders.filter((o) => o.status === OrderStatus.Open);
  if (open.length) firstOpen = open[0].id;
  else if (orders.length) firstOpen = orders[orders.length - 1].id + 1n;
  for (const o of open) {
    if (o.expiry < now) {
      if (REFUND) await send("cancel", [o.id], `refund expired #${o.id}`).catch((e) => log(`refund #${o.id} skipped: ${first(e)}`));
      continue;
    }
    await tryFill(o, now).catch((e) => log(`order #${o.id} error: ${first(e)}`));
  }
  return open.length;
}

async function main() {
  const [filler, protocol] = await Promise.all([
    client.readContract({ address: BOOK, abi: bookAbi, functionName: "fillerFeeBps" }) as Promise<bigint>,
    client.readContract({ address: BOOK, abi: bookAbi, functionName: "protocolFeeBps" }) as Promise<bigint>,
  ]);
  log(`book keeper ${LIVE ? "LIVE" : "dry run"} · ${account?.address ?? "no key"} · book ${BOOK} · fees ${filler}+${protocol} bps · poll ${POLL} ms`);
  const start = Date.now();
  for (;;) {
    const n = await pass().catch((e) => {
      log(`pass error: ${first(e)}`);
      return -1;
    });
    if (ONCE || (RUN_FOR > 0 && Date.now() - start + POLL > RUN_FOR)) {
      log(`done, ${n} open`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
}
main().catch((e) => {
  console.error(first(e));
  process.exit(1);
});
