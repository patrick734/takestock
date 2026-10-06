import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, concatHex, type Address, type PublicClient } from "viem";
import { QUOTER_CREATION_CODE } from "./quoterCode.js";
import { quoterAbi } from "./abi.js";
import { disjoint } from "./paths.js";
import type { ChainConfig, Hop, Path, Plan, PlanLeg } from "./types.js";

export const TENTHS = 10;

export type SplitOptions = {
  slippageBps?: number; // default 50 (0.5%)
  /** Paths kept after the first full-size quote. Default 6. */
  shortlist?: number;
  /** Quotes per eth_call. Each quote simulates real swaps, so keep batches modest. Default 40. */
  batchSize?: number;
  maxLegs?: number; // default 10 (SplitRouter.MAX_LEGS)
};

type Job = { path: number; amount: bigint };

const hopArg = (h: Hop) => ({
  kind: h.kind,
  tokenOut: h.tokenOut,
  fee: h.fee,
  tickSpacing: h.tickSpacing,
  hooks: h.hooks,
});

/** Runs quote jobs through SplitQuoter.quoteMany in batched eth_calls. Failed quotes come back as 0. */
export async function quoteJobs(
  client: PublicClient,
  cfg: ChainConfig,
  tokenIn: Address,
  paths: Path[],
  jobs: Job[],
  batchSize = 40,
): Promise<bigint[]> {
  const out: bigint[] = new Array(jobs.length).fill(0n);
  const batches: { idx: number[]; paths: number[]; amounts: bigint[][] }[] = [];
  for (let i = 0; i < jobs.length; i += batchSize) {
    const slice = jobs.slice(i, i + batchSize);
    const pathIdx = [...new Set(slice.map((j) => j.path))];
    batches.push({
      idx: slice.map((_, k) => i + k),
      paths: pathIdx,
      amounts: pathIdx.map((p) => slice.filter((j) => j.path === p).map((j) => j.amount)),
    });
  }
  await Promise.all(
    batches.map(async (b) => {
      const data = encodeFunctionData({
        abi: quoterAbi,
        functionName: "quoteMany",
        args: [tokenIn, b.paths.map((p) => paths[p].hops.map(hopArg)), b.amounts],
      });
      const ret = cfg.quoter
        ? await client.call({ to: cfg.quoter, data })
        : await client.call({ code: deploylessQuoter(cfg), data });
      const res = decodeFunctionResult({ abi: quoterAbi, functionName: "quoteMany", data: ret.data! }) as readonly (readonly bigint[])[];
      // Map results back to jobs, in the order they were grouped.
      const cursor = new Map<number, number>();
      for (const jobIndex of b.idx) {
        const j = jobs[jobIndex];
        const pi = b.paths.indexOf(j.path);
        const c = cursor.get(pi) ?? 0;
        out[jobIndex] = res[pi][c];
        cursor.set(pi, c + 1);
      }
    }),
  );
  return out;
}

/** Quoter creation code + constructor args, for quoting without a deployed quoter. */
function deploylessQuoter(cfg: ChainConfig): `0x${string}` {
  return concatHex([
    QUOTER_CREATION_CODE,
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [cfg.v3Factory, cfg.poolManager, cfg.weth]),
  ]);
}

const tenth = (amount: bigint, k: number) => (amount * BigInt(k)) / BigInt(TENTHS);

/**
 * Finds the best way to fill `amountIn`:
 *  1. quote every candidate path at full size (plus a tiny size on each, for price impact);
 *  2. keep the best few and quote each at every tenth of the order;
 *  3. hand out the order one tenth at a time to whichever path pays most for that tenth, only
 *     combining paths that share no pool, so the quotes add up exactly;
 *  4. use the split only if it beats the best single path, then re-quote the final legs exactly.
 */
export async function planSwap(
  client: PublicClient,
  cfg: ChainConfig,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  paths: Path[],
  opts: SplitOptions = {},
): Promise<Plan | null> {
  if (amountIn <= 0n || paths.length === 0) return null;
  const slippageBps = opts.slippageBps ?? 50;
  const shortlistN = opts.shortlist ?? 6;
  const batchSize = opts.batchSize ?? 40;
  const maxLegs = opts.maxLegs ?? 10;

  // 1. full size + tiny size on every path
  const tiny = amountIn / 1000n > 0n ? amountIn / 1000n : 1n;
  const stage1: Job[] = paths.flatMap((_, p) => [
    { path: p, amount: amountIn },
    { path: p, amount: tiny },
  ]);
  const q1 = await quoteJobs(client, cfg, tokenIn, paths, stage1, batchSize);
  const full = paths.map((_, p) => q1[p * 2]);
  const small = paths.map((_, p) => q1[p * 2 + 1]);

  // Best rate at a tiny size = the "no impact" reference.
  let refRate = 0;
  small.forEach((o) => {
    const r = Number(o) / Number(tiny);
    if (r > refRate) refRate = r;
  });

  const ranked = paths
    .map((_, p) => p)
    .filter((p) => full[p] > 0n || small[p] > 0n)
    .sort((a, b) => (full[b] > full[a] ? 1 : full[b] < full[a] ? -1 : 0));
  if (ranked.length === 0) return null;

  const bestP = ranked[0];
  const bestSingle = full[bestP] > 0n ? { path: paths[bestP], amountOut: full[bestP] } : null;

  // 2. every tenth on the shortlist (the 10/10 point is already known)
  const shortlist = ranked.slice(0, shortlistN);
  const stage2: Job[] = shortlist.flatMap((p) =>
    Array.from({ length: TENTHS - 1 }, (_, i) => ({ path: p, amount: tenth(amountIn, i + 1) })),
  );
  const q2 = await quoteJobs(client, cfg, tokenIn, paths, stage2, batchSize);
  const curve = new Map<number, bigint[]>(); // path -> out at 0..10 tenths
  shortlist.forEach((p, s) => {
    const pts = [0n, ...q2.slice(s * (TENTHS - 1), (s + 1) * (TENTHS - 1)), full[p]];
    curve.set(p, pts);
  });

  // 3. greedy by tenths over pool-disjoint paths
  const alloc = new Map<number, number>();
  for (let step = 0; step < TENTHS; step++) {
    let pick = -1;
    let gain = 0n;
    for (const p of shortlist) {
      const n = alloc.get(p) ?? 0;
      if (n === 0) {
        if (alloc.size >= maxLegs) continue;
        const used = [...alloc.keys()];
        if (!used.every((u) => disjoint(paths[u], paths[p]))) continue;
      }
      const pts = curve.get(p)!;
      if (n >= TENTHS || pts[n + 1] === 0n) continue; // can't take another tenth
      const g = pts[n + 1] - pts[n];
      if (pick === -1 || g > gain) {
        pick = p;
        gain = g;
      }
    }
    if (pick === -1) break;
    alloc.set(pick, (alloc.get(pick) ?? 0) + 1);
  }
  const allocated = [...alloc.values()].reduce((a, b) => a + b, 0);

  let legs: { path: number; amount: bigint }[];
  if (allocated === TENTHS && alloc.size > 1) {
    const entries = [...alloc.entries()].sort((a, b) => b[1] - a[1]);
    let assigned = 0n;
    legs = entries.map(([p, n], i) => {
      const amt = i === entries.length - 1 ? amountIn - assigned : tenth(amountIn, n);
      assigned += amt;
      return { path: p, amount: amt };
    });
    const splitOut = entries.reduce((s, [p, n]) => s + curve.get(p)![n], 0n);
    if (!bestSingle || splitOut <= bestSingle.amountOut) legs = bestSingle ? [{ path: bestP, amount: amountIn }] : legs;
  } else if (bestSingle) {
    legs = [{ path: bestP, amount: amountIn }];
  } else {
    return null; // nothing can fill the whole order
  }

  // 4. exact quotes for the final legs
  const finalQ = await quoteJobs(
    client,
    cfg,
    tokenIn,
    paths,
    legs.map((l) => ({ path: l.path, amount: l.amount })),
    batchSize,
  );
  if (finalQ.some((q) => q === 0n)) {
    if (!bestSingle) return null;
    legs = [{ path: bestP, amount: amountIn }];
    finalQ.splice(0, finalQ.length, bestSingle.amountOut);
  }
  const amountOut = finalQ.reduce((a, b) => a + b, 0n);

  const planLegs: PlanLeg[] = legs.map((l, i) => ({
    path: paths[l.path],
    amountIn: l.amount,
    amountOut: finalQ[i],
    share: Number((l.amount * 10000n) / amountIn) / 100,
  }));

  const ideal = refRate * Number(amountIn);
  const impactBps = ideal > 0 ? Math.max(0, Math.round((1 - Number(amountOut) / ideal) * 10000)) : 0;
  const splitGainBps =
    bestSingle && bestSingle.amountOut > 0n
      ? Math.max(0, Math.round((Number(amountOut) / Number(bestSingle.amountOut) - 1) * 10000))
      : 0;

  return {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    minAmountOut: (amountOut * BigInt(10000 - slippageBps)) / 10000n,
    legs: planLegs,
    bestSingle,
    splitGainBps,
    impactBps,
    pathsConsidered: paths.length,
    quotedAt: Date.now(),
  };
}

/** Arguments for SplitRouter.swap from a plan. */
export function swapArgs(plan: Plan, recipient: Address, deadlineSeconds = 600) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  return [
    plan.tokenIn,
    plan.tokenOut,
    plan.legs.map((l) => ({ amountIn: l.amountIn, hops: l.path.hops.map(hopArg) })),
    plan.minAmountOut,
    recipient,
    deadline,
  ] as const;
}
