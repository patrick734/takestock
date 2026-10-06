// scripts/wells.js (the Wells add-on deploy) against burn contracts deployed the way scripts/deploy.js deploys them
// live, on real Uniswap v4 bytecode; then the two-batch timelock handoff (scripts/timelock-accept.js).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const V4 = require("../uniswap/v4.json");
const { deployWells } = require("../../scripts/wells");
const { handoff } = require("../../scripts/timelock-accept");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const DAY2 = 172_800;

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

async function launched() {
  const [dev, keeper, lp, other] = await ethers.getSigners();
  await network.provider.send("hardhat_setCode", [V4.Permit2.address, V4.Permit2.runtime]);
  const make = (name, ...args) => new ethers.ContractFactory(V4[name].abi, V4[name].bytecode, lp).deploy(...args);
  const pm = await make("PoolManager", lp.address);
  const posm = await make("PositionManager", pm, V4.Permit2.address, 300_000, lp.address, lp.address);
  const lpRouter = await make("PoolModifyLiquidityTest", pm);
  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  await usdg.mint(lp, USDG(1_000_000_000));
  await usdg.connect(lp).approve(lpRouter, ethers.MaxUint256);

  // The burn deploy as it went out live: timelock (dev wallet proposes and executes), swap adapter still owned by the
  // dev wallet with the timelock as pending owner, BuyBurn with the timelock as admin.
  const timelock = await ethers.deployContract("TimelockTakestock", [DAY2, [dev.address], [dev.address], ethers.ZeroAddress]);
  const swap = await ethers.deployContract("SwapAdapterTakestock", [dev.address, pm, usdg]);
  const buyBurn = await ethers.deployContract("BuyBurnTakestock", [ethers.ZeroAddress, swap, dev.address, dev.address, keeper.address, 3600, dev.address]);
  await buyBurn.grantRole(ethers.ZeroHash, timelock);
  await buyBurn.renounceRole(ethers.ZeroHash, dev.address);

  const markets = {};
  const stocks = {};
  for (const [t, price] of [["META", 744.49], ["NVDA", 240.66]]) {
    const stock = await ethers.deployContract("MockStockToken", [t, t]);
    await stock.mint(lp, EQ(1_000_000));
    await stock.connect(lp).approve(lpRouter, ethers.MaxUint256);
    const s0 = BigInt(await stock.getAddress()) < BigInt(await usdg.getAddress());
    const key = { currency0: s0 ? await stock.getAddress() : await usdg.getAddress(), currency1: s0 ? await usdg.getAddress() : await stock.getAddress(), fee: 3000, tickSpacing: 60, hooks: ethers.ZeroAddress };
    const raw = BigInt(Math.round(price * 1e6));
    await pm.initialize(key, s0 ? isqrt((raw << 192n) / 10n ** 18n) : isqrt((10n ** 18n << 192n) / raw));
    await lpRouter.connect(lp).modifyLiquidity(key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash }, "0x");
    const feed = await ethers.deployContract("MockAggregator", [8, BigInt(Math.round(price * 1e8))]);
    // Only META's pool was registered at the burn deploy; NVDA's gets added by the Wells deploy.
    if (t === "META") await swap.setPool(key);
    markets[t] = { token: await stock.getAddress(), feed: await feed.getAddress(), name: t, fee: 3000, tickSpacing: 60 };
    stocks[t] = { token: markets[t].token, name: t };
  }
  await swap.transferOwnership(timelock);

  const d = {
    network: "robinhood",
    roles: { admin: dev.address, guardian: dev.address, keeper: keeper.address },
    stocks,
    timelock: await timelock.getAddress(),
    swapAdapter: await swap.getAddress(),
    buyBurn: await buyBurn.getAddress(),
    usdg: await usdg.getAddress(),
    pendingTimelockAcceptances: [await swap.getAddress()],
  };
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, 100_000_000]);
  const chain = {
    markets,
    usdgFeed: await usdgFeed.getAddress(),
    sequencerFeed: ethers.ZeroAddress,
    uniswap: { poolManager: await pm.getAddress(), positionManager: await posm.getAddress(), permit2: V4.Permit2.address },
    wells: ["META", "NVDA"],
    lines: ["META"],
  };
  return { dev, keeper, other, d, chain, timelock, swap, buyBurn, usdg };
}

// loadFixture rewinds the chain but hands back the same objects, so every test gets its own copy of the deployment
// record and its own progress file.
async function fresh() {
  const w = await loadFixture(launched);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wells-"));
  return { ...w, d: JSON.parse(JSON.stringify(w.d)), progressFile: path.join(dir, "progress.json") };
}

const run = (w, extra = {}) => {
  let saved = null;
  const quiet = console.log;
  console.log = () => {};
  return deployWells({ signer: w.dev, d: w.d, live: true, progressFile: w.progressFile, save: (x) => (saved = JSON.parse(JSON.stringify(x))), chain: w.chain, ...extra })
    .then((r) => ({ ...r, saved }))
    .finally(() => (console.log = quiet));
};

describe("Wells add-on deploy (scripts/wells.js)", function () {
  it("wires every Well and the credit line to the existing timelock, BuyBurn and keeper", async function () {
    const w = await fresh();
    const { out, saved } = await run(w);
    expect(Object.keys(out.liquidityVaults)).to.deep.equal(["META", "NVDA"]);
    expect(Object.keys(out.creditLines)).to.deep.equal(["META"]);
    expect(saved.wellsTimelockAcceptances).to.deep.equal([out.oracle, out.registry]);
    expect(saved.pendingTimelockAcceptances).to.deep.equal([await w.swap.getAddress()]);

    const fr = await ethers.getContractAt("FeeRouterTakestock", out.feeRouter);
    expect(await fr.owner()).to.equal(w.d.timelock);
    expect(await fr.buyBurn()).to.equal(w.d.buyBurn);
    for (const [t, v] of Object.entries(out.liquidityVaults)) {
      const well = await ethers.getContractAt("WellTakestock", v.vault);
      expect(await well.hasRole(ethers.ZeroHash, w.d.timelock), `${t} admin`).to.equal(true);
      expect(await well.hasRole(ethers.ZeroHash, w.dev.address), `${t} dev not admin`).to.equal(false);
      expect(await well.hasRole(await well.GUARDIAN_ROLE(), w.dev.address)).to.equal(true);
      expect(await well.hasRole(await well.KEEPER_ROLE(), w.keeper.address)).to.equal(true);
      expect(await well.feeRouter()).to.equal(out.feeRouter);
      expect(await well.swapAdapter()).to.equal(w.d.swapAdapter);
      expect(await well.heldValueCap()).to.equal(USDG(25_000));
      expect(await well.symbol()).to.equal(`tw${t}`);
      const pos = await ethers.getContractAt("PositionTakestock", v.position);
      expect(await pos.vault()).to.equal(v.vault);
      expect(await well.priceFresh()).to.equal(true);
    }
    const desk = await ethers.getContractAt("CreditDeskTakestock", out.creditLines.META);
    expect(await desk.vault()).to.equal(out.liquidityVaults.META.vault);
    expect(await desk.hasRole(ethers.ZeroHash, w.d.timelock)).to.equal(true);
    expect(await desk.borrowCap()).to.equal(USDG(5_000));

    // NVDA had no pool on the swap adapter; the dev wallet (still its owner) added it.
    const [, exists] = await w.swap.poolFor(w.chain.markets.NVDA.token, w.d.usdg);
    expect(exists).to.equal(true);

    const reg = await ethers.getContractAt("RegistryTakestock", out.registry);
    const entries = await reg.entries();
    expect(entries.map((e) => [e.ticker, Number(e.kind)])).to.deep.equal([["META", 0], ["NVDA", 0], ["META", 1]]);
    for (const a of [out.oracle, out.registry]) {
      const c = await ethers.getContractAt("OracleTakestock", a);
      expect(await c.owner()).to.equal(w.dev.address);
      expect(await c.pendingOwner()).to.equal(w.d.timelock);
    }
  });

  it("continues after a stop halfway and sends nothing twice", async function () {
    const w = await fresh();
    // Stop after the oracle and fee router exist, as a dropped connection would.
    let n = 0;
    const flaky = new Proxy(w.dev, {
      get(target, prop) {
        if (prop === "sendTransaction") return async (tx) => { if (++n > 9) throw new Error("connection dropped"); return target.sendTransaction(tx); };
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(run(w, { signer: flaky })).to.be.rejectedWith("connection dropped");
    const half = JSON.parse(fs.readFileSync(w.progressFile, "utf8"));
    expect(half.oracle).to.match(/^0x/);

    const again = await run(w);
    expect(again.out.oracle).to.equal(half.oracle);
    expect(Object.keys(again.out.liquidityVaults)).to.deep.equal(["META", "NVDA"]);
    const third = await run(w);
    expect(third.sent).to.equal(0);
  });

  it("skips a Well whose pool is missing once the timelock owns the swap adapter", async function () {
    const w = await fresh();
    const ops = await handoff(ethers.provider, w.d);
    await w.dev.sendTransaction(ops[0].schedule);
    await time.increase(DAY2);
    await w.dev.sendTransaction(ops[0].execute);
    expect(await w.swap.owner()).to.equal(w.d.timelock);
    const { out } = await run(w);
    expect(Object.keys(out.liquidityVaults)).to.deep.equal(["META"]);
  });

  it("refuses any wallet but the dev wallet", async function () {
    const w = await fresh();
    await expect(run(w, { signer: w.other })).to.be.rejectedWith("Send this from the dev wallet");
  });

  it("hands the swap adapter, oracle and registry to the timelock in two batches", async function () {
    const w = await fresh();
    // The burn batch was scheduled before the Wells existed.
    let ops = await handoff(ethers.provider, w.d);
    expect(ops.map((o) => o.status)).to.deep.equal(["unscheduled"]);
    await w.dev.sendTransaction(ops[0].schedule);

    const { saved } = await run(w);
    ops = await handoff(ethers.provider, saved);
    expect(ops.map((o) => [o.name, o.status])).to.deep.equal([["burn contracts", "scheduled"], ["Wells oracle and registry", "unscheduled"]]);
    await w.dev.sendTransaction(ops[1].schedule);
    await time.increase(DAY2);
    ops = await handoff(ethers.provider, saved);
    expect(ops.map((o) => o.status)).to.deep.equal(["ready", "ready"]);
    for (const o of ops) await w.dev.sendTransaction(o.execute);
    ops = await handoff(ethers.provider, saved);
    expect(ops.map((o) => o.status)).to.deep.equal(["done", "done"]);
    for (const a of [saved.swapAdapter, saved.oracle, saved.registry]) {
      expect(await (await ethers.getContractAt("OracleTakestock", a)).owner()).to.equal(w.d.timelock);
    }
  });
});
