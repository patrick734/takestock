// Protocol-fee pipeline: the order book pays its protocol fee into BuyBurn; the keeper buys the token with it and burns it.
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { buildRoute } = require("../routes");

const BPS = 10_000n;

// Tokens fees can arrive in: USDG (selling a stock) and the Stock Tokens with a registered pool (buying one).
function feeTokens(ctx) {
  const list = [{ symbol: "USDG", address: ethers.getAddress(ctx.dep.usdg) }];
  for (const [ticker, s] of Object.entries(ctx.dep.stocks || {})) list.push({ symbol: ticker, address: ethers.getAddress(s.token) });
  return list;
}

function erc20(ctx, address) {
  return new ethers.Contract(address, abis.ERC20, ctx.provider);
}

// ---------------------------------------------------------------- BuyBurn.buyAndBurn

async function runBuyBurn(ctx) {
  const log = logger("buyburn", "BuyBurn");
  const cfg = ctx.cfg.buyBurn;
  if (!cfg.enabled || !ctx.dep.buyBurn) return;
  const bb = new ethers.Contract(ctx.dep.buyBurn, abis.BuyBurn, ctx.runner);

  if (!(await bb.hasRole(await bb.KEEPER_ROLE(), ctx.keeper))) {
    return log.warn("keeper address lacks KEEPER_ROLE on BuyBurn; skipping", { keeper: ctx.keeper });
  }
  if (await bb.halted()) return log.info("halted by the guardian, skipping");
  // A deployment made before the token launched records none; set-token.sh sets it on-chain later.
  if (!ctx.dep.token) {
    const t = await bb.token();
    if (t === ethers.ZeroAddress) return log.info("token not set yet; fees wait in BuyBurn");
    ctx.dep.token = t;
  }
  // lastRun and minInterval are shared by every input: at most one buy per interval.
  const [last, interval, now] = await Promise.all([bb.lastRun(), bb.minInterval(), blockTime(ctx.provider)]);
  if (now < last + interval) return log.info("rate limited by minInterval", { nextInSec: last + interval - now });

  const candidates = [];
  for (const t of feeTokens(ctx)) {
    const [bal, cap] = await Promise.all([erc20(ctx, t.address).balanceOf(ctx.dep.buyBurn), bb.maxInputPerRun(t.address)]);
    if (bal === 0n) continue;
    if (cap === 0n) {
      log.warn("fee token held but its maxInputPerRun is 0; governance must set a limit", { token: t.symbol, balance: bal });
      continue;
    }
    const amount = bal < cap ? bal : cap;
    const value = t.symbol === "USDG" ? amount : null;
    candidates.push({ ...t, bal, cap, amount, value });
  }
  if (candidates.length === 0) return log.info("no fees waiting");
  // Largest known USDG value first; unpriced tokens last.
  candidates.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : a.value > b.value ? -1 : a.value < b.value ? 1 : 0));

  for (const c of candidates) {
    const tlog = logger("buyburn", c.symbol);
    let route;
    let hops;
    try {
      const spec = cfg.routes[c.symbol] ?? cfg.routes[c.address] ?? cfg.routes[c.address.toLowerCase()] ?? cfg.defaultRoute;
      ({ route, path: hops } = buildRoute(ctx, spec, c.address, ctx.dep.token));
    } catch (e) {
      tlog.error("bad route config", { reason: e.message });
      continue;
    }
    const pathText = hops ? hops.map((a) => symbolOf(ctx, a)).join("->") : "adapter-default";

    // Quote by simulating the real call with minOut = 1: it returns exactly what the swap delivers.
    let quoted;
    try {
      quoted = await bb.buyAndBurn.staticCall(c.address, c.amount, 1n, route, { from: ctx.keeper });
    } catch (e) {
      tlog.warn("quote failed, skipping this token", { amountIn: c.amount, path: pathText, reason: reason(e) });
      continue;
    }
    const minOut = (quoted * (BPS - BigInt(cfg.slippageBps))) / BPS;
    if (minOut === 0n) {
      tlog.warn("quote returned nothing, skipping", { amountIn: c.amount, path: pathText });
      continue;
    }
    tlog.info("buying and burning", {
      amountIn: c.amount,
      valueUsdg: c.value === null ? "unpriced" : ethers.formatUnits(c.value, 6),
      path: pathText,
      quoted: ethers.formatEther(quoted),
      minOut: ethers.formatEther(minOut),
    });
    const r = await exec(ctx, tlog, bb, "buyAndBurn", [c.address, c.amount, minOut, route], "buyAndBurn");
    if (r.ok) return; // the shared minInterval allows one per run
  }
}

function symbolOf(ctx, a) {
  if (a === ethers.ZeroAddress) return "ETH";
  if (a.toLowerCase() === String(ctx.dep.usdg).toLowerCase()) return "USDG";
  if (a.toLowerCase() === String(ctx.dep.token).toLowerCase()) return ctx.dep.tokenSymbol || "TOKEN";
  for (const [t, m] of Object.entries(ctx.dep.stocks || {})) if (a.toLowerCase() === m.token.toLowerCase()) return t;
  return a;
}

module.exports = { runBuyBurn };
