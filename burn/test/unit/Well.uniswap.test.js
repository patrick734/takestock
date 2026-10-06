// The Well, its position and the credit line against the real Uniswap v4 PoolManager, PositionManager and Permit2
// (the published 1.0.3 build output, in test/uniswap/v4.json), with the keeper's own rebalance planner choosing ranges.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const V4 = require("../uniswap/v4.json");
const { planRebalance } = require("../../../keeper/src/plan");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const PLAN = { halfWidthTicks: 1200, edgeThresholdPct: 15, minSwapUsdg: "5", minIdleUsdg: "10", maxIdlePct: 25 };

function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

async function world() {
  const [admin, guardian, keeper, alice, bob, lp, trader] = await ethers.getSigners();
  await network.provider.send("hardhat_setCode", [V4.Permit2.address, V4.Permit2.runtime]);
  const make = (name, ...args) => new ethers.ContractFactory(V4[name].abi, V4[name].bytecode, admin).deploy(...args);
  const pm = await make("PoolManager", admin.address);
  const posm = await make("PositionManager", pm, V4.Permit2.address, 300_000, admin.address, admin.address);
  const lpRouter = await make("PoolModifyLiquidityTest", pm);
  const swapRouter = await make("PoolSwapTest", pm);

  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const stock = await ethers.deployContract("MockStockToken", ["Meta Platforms Stock Token", "META"]);
  const stockIsToken0 = BigInt(await stock.getAddress()) < BigInt(await usdg.getAddress());
  const [c0, c1] = stockIsToken0 ? [stock, usdg] : [usdg, stock];
  const key = { currency0: await c0.getAddress(), currency1: await c1.getAddress(), fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };

  // Pool at 250 USDG per share with about 25M USDG of full-range third-party liquidity, so a Well rebalance moves
  // the price about as little as it does in the live pools.
  const sqrtAt = (price) => {
    const usdgRaw = BigInt(Math.round(price * 1e6));
    return stockIsToken0 ? isqrt((usdgRaw << 192n) / 10n ** 18n) : isqrt((10n ** 18n << 192n) / usdgRaw);
  };
  await pm.initialize(key, sqrtAt(250));
  for (const who of [lp, trader]) {
    await stock.mint(who, EQ(1_000_000));
    await usdg.mint(who, USDG(1_000_000_000));
    await stock.connect(who).approve(lpRouter, ethers.MaxUint256);
    await usdg.connect(who).approve(lpRouter, ethers.MaxUint256);
    await stock.connect(who).approve(swapRouter, ethers.MaxUint256);
    await usdg.connect(who).approve(swapRouter, ethers.MaxUint256);
  }
  await lpRouter.connect(lp).modifyLiquidity(key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 15n * 10n ** 17n, salt: ethers.ZeroHash }, "0x");

  const usdgFeed = await ethers.deployContract("MockAggregator", [8, 100_000_000]);
  const feed = await ethers.deployContract("MockAggregator", [8, 250n * 10n ** 8n]);
  const oracle = await ethers.deployContract("OracleTakestock", [admin.address, ethers.ZeroAddress, usdgFeed, 90_000, 6]);
  await oracle.setFeed(stock, feed, 86_400);

  const swap = await ethers.deployContract("SwapAdapterTakestock", [admin.address, pm, usdg]);
  await swap.setPool(key);
  const sink = ethers.Wallet.createRandom().address;
  const feeRouter = await ethers.deployContract("FeeRouterTakestock", [admin.address, sink]);

  const position = await ethers.deployContract("PositionTakestock", [pm, posm, V4.Permit2.address, oracle, key, stock, usdg]);
  const well = await ethers.deployContract("WellTakestock", [
    {
      usdg: await usdg.getAddress(),
      stock: await stock.getAddress(),
      position: await position.getAddress(),
      oracle: await oracle.getAddress(),
      swapAdapter: await swap.getAddress(),
      feeRouter: await feeRouter.getAddress(),
      admin: admin.address,
      guardian: guardian.address,
      keeper: keeper.address,
      heldValueCap: USDG(1_000_000),
    },
    "Takestock META Well",
    "twMETA",
  ]);
  await position.bind(well);

  const desk = await ethers.deployContract("CreditDeskTakestock", [
    well,
    feeRouter,
    admin.address,
    guardian.address,
    { ltvBps: 4000, liquidationThresholdBps: 5500, liquidationBonusBps: 600, closeFactorBps: 5000, maxCollateralShareBps: 3000, reserveFactorBps: 1000 },
    { baseRatePerYear: EQ("0.02"), slope1PerYear: EQ("0.06"), slope2PerYear: EQ("1"), kinkUtilization: EQ("0.8") },
    USDG(100_000),
    USDG(50_000),
    "Takestock META Credit Line",
    "tcMETA",
  ]);

  for (const who of [alice, bob]) await usdg.mint(who, USDG(100_000));

  // Moves the pool with a trade, then points the feed at the new pool price (as Chainlink would follow the market).
  async function trade(sellStock, amount) {
    const zeroForOne = sellStock === stockIsToken0;
    await swapRouter.connect(trader).swap(
      key,
      { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    );
  }
  async function syncFeed() {
    const spot = await position.spotUsdgValue(EQ(1)); // 6 dp
    await feed.setAnswer(spot * 100n);
  }

  // What the keeper does: read the chain, plan, send.
  async function keeperRebalance() {
    const [slot, liquidity, lower, upper, fair, [heldS, heldU], idleS, idleU] = await Promise.all([
      position.slot0(),
      position.liquidity(),
      position.tickLower(),
      position.tickUpper(),
      oracle.usdgValue(stock, EQ(1)),
      well.holdings(),
      stock.balanceOf(well),
      usdg.balanceOf(well),
    ]);
    const plan = planRebalance({
      cfg: PLAN,
      fair,
      stockUnit: EQ(1),
      stockIsToken0,
      spacing: 60,
      sqrtPriceX96: slot[0],
      poolTick: Number(slot[1]),
      liquidity,
      lower: Number(lower),
      upper: Number(upper),
      heldS,
      heldU,
      idleS,
      idleU,
    });
    if (plan.action !== "rebalance") return plan;
    await well.connect(keeper).rebalance(plan.target.lower, plan.target.upper, plan.sellUsdg, plan.amount, "0x");
    return plan;
  }

  return { admin, guardian, keeper, alice, bob, trader, pm, posm, usdg, stock, stockIsToken0, key, oracle, feed, swap, feeRouter, position, well, desk, trade, syncFeed, keeperRebalance };
}

const near = (a, b, bps) => {
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= b * BigInt(bps);
};

describe("Well on real Uniswap v4", function () {
  it("deposits, places a range around the Chainlink price and keeps the value", async function () {
    const w = await loadFixture(world);
    await w.usdg.connect(w.alice).approve(w.well, USDG(10_000));
    await w.well.connect(w.alice).deposit(USDG(10_000), w.alice.address);

    const plan = await w.keeperRebalance();
    expect(plan.action).to.equal("rebalance");
    expect(plan.why).to.equal("no active range");
    expect(await w.position.liquidity()).to.be.gt(0n);
    expect(await w.position.tokenId()).to.be.gt(0n);
    const [, tick] = await w.position.slot0();
    expect(Number(tick)).to.be.gte(Number(await w.position.tickLower()));
    expect(Number(tick)).to.be.lt(Number(await w.position.tickUpper()));

    // The position holds nothing between calls; leftovers sit in the Well.
    expect(await w.usdg.balanceOf(w.position)).to.equal(0n);
    expect(await w.stock.balanceOf(w.position)).to.equal(0n);
    const [s, u] = await w.position.balances();
    expect(s).to.be.gt(0n);
    expect(u).to.be.gt(0n);
    // Placing it costs the swap fee and a little price impact, nothing more.
    expect(near(await w.well.totalAssets(), USDG(10_000), 100)).to.equal(true);
    // Mostly in the range now.
    const idle = await w.usdg.balanceOf(w.well);
    expect(idle).to.be.lt(USDG(1_000));
  });

  it("earns swap fees, sends the protocol share to the fee router and compounds the rest", async function () {
    const w = await loadFixture(world);
    await w.usdg.connect(w.alice).approve(w.well, USDG(20_000));
    await w.well.connect(w.alice).deposit(USDG(20_000), w.alice.address);
    await w.keeperRebalance();
    const before = await w.well.convertToAssets(10n ** 12n);

    for (let i = 0; i < 6; i++) {
      await w.trade(false, USDG(50_000));
      await w.trade(true, EQ(200));
    }
    await w.syncFeed();
    const tx = await w.well.harvest();
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return w.well.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "FeesHarvested");
    expect(ev).to.not.equal(undefined);
    const [stockFees, usdgFees, protoStock, protoUsdg] = ev.args;
    expect(stockFees + usdgFees).to.be.gt(0n);
    expect(protoStock).to.equal((stockFees * 3000n) / 10_000n);
    expect(protoUsdg).to.equal((usdgFees * 3000n) / 10_000n);
    expect(await w.usdg.balanceOf(w.feeRouter)).to.equal(protoUsdg);
    expect(await w.stock.balanceOf(w.feeRouter)).to.equal(protoStock);
    // Principal did not get counted as fees: the range is still there.
    expect(await w.position.liquidity()).to.be.gt(0n);
    expect(await w.well.grossUsdgFees()).to.equal(usdgFees);
    expect(await w.well.convertToAssets(10n ** 12n)).to.be.gte(before - before / 200n);

    // Anyone can forward the fees to BuyBurn.
    const sink = await w.feeRouter.buyBurn();
    await w.feeRouter.routeMany([w.usdg, w.stock]);
    expect(await w.usdg.balanceOf(sink)).to.equal(protoUsdg);
    expect(await w.stock.balanceOf(sink)).to.equal(protoStock);
  });

  it("pays an exact USDG withdrawal out of the range and redeems the rest in kind", async function () {
    const w = await loadFixture(world);
    await w.usdg.connect(w.alice).approve(w.well, USDG(10_000));
    await w.well.connect(w.alice).deposit(USDG(10_000), w.alice.address);
    await w.keeperRebalance();
    const l0 = await w.position.liquidity();

    const bal0 = await w.usdg.balanceOf(w.alice);
    await w.well.connect(w.alice).withdraw(USDG(3_000), w.alice.address, w.alice.address);
    expect((await w.usdg.balanceOf(w.alice)) - bal0).to.equal(USDG(3_000));
    expect(await w.position.liquidity()).to.be.lt(l0);

    const shares = await w.well.balanceOf(w.alice);
    const s0 = await w.stock.balanceOf(w.alice);
    const u0 = await w.usdg.balanceOf(w.alice);
    await w.well.connect(w.alice).redeemInKind(shares, w.alice.address, w.alice.address, 0, 0);
    const gotS = (await w.stock.balanceOf(w.alice)) - s0;
    const gotU = (await w.usdg.balanceOf(w.alice)) - u0;
    expect(gotS).to.be.gt(0n);
    expect(gotU).to.be.gt(0n);
    expect(near(gotU + (gotS * 250n) / 10n ** 12n, USDG(7_000), 150)).to.equal(true);
    expect(await w.well.totalSupply()).to.equal(0n);
    expect(await w.position.liquidity()).to.equal(0n);
  });

  it("re-centres when the price runs out of the range", async function () {
    const w = await loadFixture(world);
    await w.usdg.connect(w.alice).approve(w.well, USDG(10_000));
    await w.well.connect(w.alice).deposit(USDG(10_000), w.alice.address);
    await w.keeperRebalance();
    const lower0 = Number(await w.position.tickLower());
    const upper0 = Number(await w.position.tickUpper());

    // Roughly +30%: well past a +-1200 tick (+-12%) range.
    for (let i = 0; i < 6; i++) await w.trade(false, USDG(600_000));
    await w.syncFeed();
    const [, tick] = await w.position.slot0();
    expect(Number(tick) < lower0 || Number(tick) >= upper0).to.equal(true);

    const plan = await w.keeperRebalance();
    expect(plan.action).to.equal("rebalance");
    expect(plan.why).to.equal("pool tick out of range");
    const lower1 = Number(await w.position.tickLower());
    const upper1 = Number(await w.position.tickUpper());
    expect(Number(tick)).to.be.gte(lower1);
    expect(Number(tick)).to.be.lt(upper1);
    expect(await w.position.liquidity()).to.be.gt(0n);
  });

  it("refuses deposits while the pool is far from Chainlink", async function () {
    const w = await loadFixture(world);
    await w.trade(false, USDG(1_000_000));
    await w.usdg.connect(w.alice).approve(w.well, USDG(1_000));
    await expect(w.well.connect(w.alice).deposit(USDG(1_000), w.alice.address)).to.be.revertedWithCustomError(w.well, "PoolDeviation");
  });

  it("lends USDG against pledged Well shares and takes it back", async function () {
    const w = await loadFixture(world);
    await w.usdg.connect(w.alice).approve(w.desk, USDG(20_000));
    await w.desk.connect(w.alice).deposit(USDG(20_000), w.alice.address);

    await w.usdg.connect(w.alice).approve(w.well, USDG(30_000));
    await w.well.connect(w.alice).deposit(USDG(30_000), w.alice.address);
    await w.usdg.connect(w.bob).approve(w.well, USDG(10_000));
    await w.well.connect(w.bob).deposit(USDG(10_000), w.bob.address);
    await w.keeperRebalance();

    const shares = await w.well.balanceOf(w.bob);
    await w.well.connect(w.bob).approve(w.desk, shares);
    await w.desk.connect(w.bob).pledge(shares);
    const room = await w.desk.borrowable(w.bob);
    expect(near(room, USDG(4_000), 150)).to.equal(true); // 40% of about 10,000
    await w.desk.connect(w.bob).borrow(USDG(3_000), w.bob.address);
    await expect(w.desk.connect(w.bob).borrow(USDG(1_500), w.bob.address)).to.be.revertedWithCustomError(w.desk, "Unhealthy");
    expect(await w.desk.healthFactor(w.bob)).to.be.gt(10n ** 18n);

    await w.usdg.connect(w.bob).approve(w.desk, ethers.MaxUint256);
    await w.desk.connect(w.bob).repay(ethers.MaxUint256, w.bob.address);
    expect(await w.desk.debtOf(w.bob)).to.equal(0n);
    await w.desk.connect(w.bob).release(shares, w.bob.address);
    expect(await w.well.balanceOf(w.bob)).to.equal(shares);
  });
});
