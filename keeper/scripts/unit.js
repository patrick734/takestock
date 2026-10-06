// Offline unit tests for the keeper's pure logic: tick math, rebalance planning, routes and revert decoding.
// Run with `npm test`. Needs no node or RPC, only burn/artifacts for the ABIs.
const assert = require("assert/strict");
const { ethers } = require("ethers");
const v4 = require("../src/v4math");
const { planRebalance } = require("../src/plan");
const { buildRoute } = require("../src/routes");
const { reason } = require("../src/chain");
const abis = require("../src/abis");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const CFG = { halfWidthTicks: 1200, edgeThresholdPct: 15, minSwapUsdg: "5", minIdleUsdg: "10", maxIdlePct: 25 };
const E18 = 10n ** 18n;
const usdg = (n) => ethers.parseUnits(String(n), 6);

// Pool state for a Stock Token at `price` USDG, as the v4 pool would store it.
function pool(price, stockIsToken0) {
  const raw = stockIsToken0 ? (price * 1e6) / 1e18 : 1e18 / (price * 1e6);
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
  return { sqrtPriceX96, poolTick: v4.tickFromPrice(raw), fair: usdg(price) };
}

function base(price, stockIsToken0, over = {}) {
  const pl = pool(price, stockIsToken0);
  return {
    cfg: CFG,
    fair: pl.fair,
    stockUnit: E18,
    stockIsToken0,
    spacing: 60,
    sqrtPriceX96: pl.sqrtPriceX96,
    poolTick: pl.poolTick,
    liquidity: 0n,
    lower: 0,
    upper: 0,
    heldS: 0n,
    heldU: 0n,
    idleS: 0n,
    idleU: 0n,
    ...over,
  };
}

const near = (a, b, tolBps) => {
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= b * BigInt(tolBps);
};

console.log("v4math");
test("tickFromPrice(1) = 0 and sign follows price", () => {
  assert.equal(v4.tickFromPrice(1), 0);
  assert.ok(v4.tickFromPrice(1.01) > 0 && v4.tickFromPrice(0.99) < 0);
});
test("rangeAround snaps outward to the spacing", () => {
  const r = v4.rangeAround(123, 1200, 60);
  assert.ok(r.lower % 60 === 0);
  assert.ok(r.upper % 60 === 0);
  assert.ok(r.lower <= 123 - 1200 && r.upper >= 123 + 1200);
  assert.deepEqual(v4.rangeAround(-123, 1200, 60), { lower: -1380, upper: 1080 });
});
test("range centred on price holds about half its value in each token", () => {
  const r = v4.rangeAround(0, 1200, 60);
  assert.ok(Math.abs(v4.token1ValueShare(1, r.lower, r.upper) - 0.5) < 0.01);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), 60, 120), 0);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), -120, -60), 1);
});

console.log("planRebalance");
for (const stockIsToken0 of [false, true]) {
  const side = stockIsToken0 ? "stock=token0" : "stock=token1";
  test(`${side}: no range + idle USDG -> place range, sell about half the USDG`, () => {
    const p = planRebalance(base(778.25, stockIsToken0, { heldU: usdg(10_000), idleU: usdg(10_000) }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "no active range");
    assert.equal(p.sellUsdg, true);
    assert.ok(near(p.amount, usdg(5_000), 200), `amount ${p.amount}`);
    assert.ok(p.target.lower <= p.status.oracleTick && p.status.oracleTick < p.target.upper);
  });
  test(`${side}: no range + stock only -> sell about half the stock`, () => {
    const heldS = ethers.parseEther("10");
    const p = planRebalance(base(224.41, stockIsToken0, { heldS, idleS: heldS }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.sellUsdg, false);
    assert.ok(near(p.amount, ethers.parseEther("5"), 200), `amount ${p.amount}`);
  });
  test(`${side}: centred range -> nothing to do`, () => {
    const b = base(336.31, stockIsToken0);
    const r = v4.rangeAround(b.poolTick, 1200, 60);
    const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("15") });
    assert.equal(p.action, "none");
  });
  test(`${side}: price moved 20% -> out of range, new range around the oracle`, () => {
    const old = base(100, stockIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(120, stockIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("40") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick out of range");
    assert.ok(p.target.lower <= now.poolTick && now.poolTick < p.target.upper);
  });
  test(`${side}: price moved 10% -> near edge triggers`, () => {
    const old = base(100, stockIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(110, stockIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("50") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick near range edge");
  });
}
test("pool at edge but oracle centred on the current range -> skip, not a pointless rebalance", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, poolTick: r.upper - 10, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("50") });
  assert.equal(p.action, "skip");
});
test("large idle balance in an otherwise healthy range -> rebalance to deploy it", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(8000), heldS: ethers.parseEther("20"), idleU: usdg(4000) });
  assert.equal(p.action, "rebalance");
  assert.equal(p.why, "idle balance above maxIdlePct");
});
test("tiny imbalance below minSwapUsdg -> no swap", () => {
  const p = planRebalance(base(100, false, { heldU: usdg(10), heldS: ethers.parseEther("0.1"), idleU: usdg(10), cfg: { ...CFG, minSwapUsdg: "50" } }));
  assert.equal(p.action, "rebalance");
  assert.equal(p.amount, 0n);
});
test("dust with no range -> nothing", () => {
  assert.equal(planRebalance(base(100, false, { heldU: usdg(1), idleU: usdg(1) })).action, "none");
});

console.log("routes");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35";
const TOKEN = "0x1111111111111111111111111111111111111111";
const ctx = { dep: { usdg: USDG, token: TOKEN, markets: { META: { token: META } } } };
const decode = (r) => ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], r)[0].map(String);
test("default route for USDG collapses IN/USDG: USDG -> ETH -> TOKEN", () => {
  const { route, path } = buildRoute(ctx, ["IN", "USDG", "ETH", "TOKEN"], USDG, TOKEN);
  assert.deepEqual(path, [ethers.getAddress(USDG), ethers.ZeroAddress, TOKEN]);
  assert.deepEqual(decode(route), path);
});
test("default route for a Stock Token: META -> USDG -> ETH -> TOKEN", () => {
  const { path } = buildRoute(ctx, ["IN", "USDG", "ETH", "TOKEN"], META, TOKEN);
  assert.deepEqual(path, [ethers.getAddress(META), ethers.getAddress(USDG), ethers.ZeroAddress, TOKEN]);
});
test('"default" and [] mean the adapter default path (0x)', () => {
  assert.equal(buildRoute(ctx, "default", USDG, TOKEN).route, "0x");
  assert.equal(buildRoute(ctx, [], USDG, TOKEN).route, "0x");
});
test("a route that does not end at the token is rejected", () => {
  assert.throws(() => buildRoute(ctx, ["IN", "ETH"], USDG, TOKEN));
  assert.throws(() => buildRoute(ctx, ["IN", "NOPE", "TOKEN"], USDG, TOKEN));
  assert.throws(() => buildRoute({ dep: { usdg: USDG, token: null } }, ["IN", "TOKEN"], USDG, TOKEN));
});

console.log("revert decoding");
test("custom errors decode by name, including nested ones", () => {
  const bb = new ethers.Interface(abis.BuyBurn);
  assert.equal(reason({ data: bb.encodeErrorResult("TooSoon", []) }), "TooSoon()");
  const ad = new ethers.Interface(abis.SwapAdapter);
  assert.equal(reason({ error: { data: ad.encodeErrorResult("InvalidRoute", []) } }), "InvalidRoute()");
  const desk = new ethers.Interface(abis.CreditDesk);
  assert.equal(reason({ data: desk.encodeErrorResult("Unhealthy", []) }), "Unhealthy()");
});

console.log(process.exitCode ? "\nunit tests FAILED" : `\nall ${passed} unit tests passed`);
