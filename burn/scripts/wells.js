// Adds the Wells and the credit line to a Takestock deployment that already has its burn contracts (TimelockTakestock,
// SwapAdapterTakestock, BuyBurnTakestock). Shared by deploy-wells.js (the real deploy) and rehearse-wells.js (a
// local copy of Robinhood Chain).
//
//   OracleTakestock        Chainlink prices for the Stock Tokens, in USDG
//   FeeRouterTakestock     takes the Wells' and credit line's protocol share and forwards it to BuyBurnTakestock
//   RegistryTakestock      the on-chain list of Wells and credit lines
//   PositionTakestock      one per Well: its range in the hookless Stock Token / USDG Uniswap v4 pool
//   WellTakestock          one per Stock Token: USDG deposits, kept in a range around the Chainlink price
//   CreditDeskTakestock    the credit line: lenders supply USDG, borrowers pledge Well shares
//
// Settings go to the 48h timelock: it is admin of every Well and credit line from the start and owns the FeeRouter;
// the oracle and the registry are handed over with ./govern.sh handoff. The dev wallet is guardian (it can pause and
// lower caps) and the keeper moves the ranges.
//
// Every step is checked on chain before it is sent and every new address is saved as soon as it exists, so a run that
// stops halfway (a dropped RPC connection) continues where it stopped when started again.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const config = require("../config/robinhood.json");

const L = config.launch;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));
const send = async (p) => (await p).wait();
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const MAX_POOL_FEE = 3000; // 0.3%, in Uniswap's hundredths of a basis point

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 236.31, PLTR: 191.53, META: 778.25 };

function poolKey(stock, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(stock) < BigInt(usdg) ? [stock, usdg] : [usdg, stock];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

/** Tickers that get a Well, and the one(s) that also get a credit line. */
function tickers() {
  const wells = [...L.liquidityVaults];
  for (const t of L.creditLines) if (!wells.includes(t)) throw new Error(`Credit line ${t} needs a Well for ${t} (config launch.liquidityVaults)`);
  return { wells, lines: [...L.creditLines] };
}

/**
 * @param {object} o
 * @param {import("ethers").Signer} o.signer   the dev wallet (live) or its impersonation (rehearsal)
 * @param {object} o.d                          the burn deployment (deployments/<network>.json), updated in place
 * @param {boolean} o.live                      real Uniswap pools and Chainlink feeds (live and rehearsal)
 * @param {string} o.progressFile               where addresses are saved as they appear
 * @param {(d: object) => void} o.save          writes the deployment file
 * @param {object} [o.chain]                    tests only: { markets, usdgFeed, sequencerFeed, uniswap, wells, lines }
 */
async function deployWells({ signer, d, live, progressFile, save, chain }) {
  const progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, "utf8")) : {};
  const remember = (k, v) => {
    progress[k] = v;
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2) + "\n");
  };
  if (progress.block === undefined) remember("block", await ethers.provider.getBlockNumber());
  let sent = 0;
  const tx = async (p) => {
    sent++;
    return send(p);
  };

  async function contract(keyName, name, args) {
    if (progress[keyName]) {
      // Never deploy a second copy of something already recorded: a missing contract here means a bad RPC answer.
      if ((await ethers.provider.getCode(progress[keyName])) === "0x")
        throw new Error(`${name} ${progress[keyName]} is recorded but the RPC shows no code there. Run again in a minute.`);
      console.log(`  ${name.padEnd(22)} ${progress[keyName]} (already deployed)`);
      return ethers.getContractAt(name, progress[keyName], signer);
    }
    const f = await ethers.getContractFactory(name, signer);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    sent++;
    const a = await c.getAddress();
    remember(keyName, a);
    console.log(`  ${name.padEnd(22)} ${a}`);
    return c;
  }

  const me = await signer.getAddress();
  if (!same(me, d.roles.admin)) throw new Error(`Send this from the dev wallet ${d.roles.admin} (the timelock's proposer), not ${me}.`);
  const { wells, lines } = chain ? { wells: chain.wells, lines: chain.lines } : tickers();
  const uniswap = (chain && chain.uniswap) || config.uniswap;
  const swap = await ethers.getContractAt("SwapAdapterTakestock", d.swapAdapter, signer);
  const ownsSwap = live && same(await swap.owner(), me);

  // Which pools: the live ones from probe-pools (config/robinhood.pools.json), or the local mocks.
  const env = chain || (live ? liveMarkets(wells) : await localMarkets(d, wells, signer));
  console.log(`Adding Wells for ${wells.join(" ")} and a credit line for ${lines.join(" ")} from ${me}`);

  const oracle = await contract("oracle", "OracleTakestock", [
    me,
    env.sequencerFeed,
    env.usdgFeed,
    config.chainlink.usdgMaxAge,
    config.tokens.usdg.decimals,
  ]);
  const feeRouter = await contract("feeRouter", "FeeRouterTakestock", [d.timelock, d.buyBurn]);
  const registry = await contract("registry", "RegistryTakestock", [me]);

  const out = {
    oracle: await oracle.getAddress(),
    feeRouter: await feeRouter.getAddress(),
    registry: await registry.getAddress(),
    markets: {},
    liquidityVaults: {},
    creditLines: {},
  };

  console.log("Price feeds");
  const oracleOwned = same(await oracle.owner(), me);
  for (const t of wells) {
    const m = env.markets[t];
    if (!m) continue;
    if (!same(await oracle.feedOf(m.token), m.feed)) {
      if (!oracleOwned) throw new Error("The oracle already belongs to the timelock; set feeds through it.");
      await tx(oracle.setFeed(m.token, m.feed, config.chainlink.stockMaxAge));
    }
    out.markets[t] = { token: m.token, feed: m.feed, name: m.name };
  }
  console.log(`  Chainlink feeds set for ${Object.keys(out.markets).join(" ")}`);

  console.log("Wells");
  for (const t of wells) {
    const m = env.markets[t];
    if (!m) continue;
    if (!(d.stocks && d.stocks[t]) && live) {
      console.log(`  ${t.padEnd(6)} skipped: BuyBurn has no input limit for ${t}, so its fees could never be burned`);
      continue;
    }
    // The Well sells and buys its Stock Token through the swap adapter's registered pool.
    if (live) {
      const [key, exists] = await swap.poolFor(m.token, d.usdg);
      if (exists && (Number(key.fee) !== Number(m.fee) || Number(key.tickSpacing) !== Number(m.tickSpacing) || !same(key.hooks, ethers.ZeroAddress)))
        console.log(`  ${t.padEnd(6)} note: the Well's range sits in the ${m.fee}/${m.tickSpacing} pool and its swaps go through the ${key.fee}/${key.tickSpacing} pool`);
      if (!exists) {
        if (!ownsSwap) {
          console.log(`  ${t.padEnd(6)} skipped: no ${t}/USDG pool on the swap adapter, which the timelock now owns`);
          continue;
        }
        await tx(swap.setPool(poolKey(m.token, d.usdg, m.fee, m.tickSpacing)));
      }
    }
    const position = live
      ? await contract(`position.${t}`, "PositionTakestock", [
          uniswap.poolManager,
          uniswap.positionManager,
          uniswap.permit2,
          out.oracle,
          poolKey(m.token, d.usdg, m.fee, m.tickSpacing),
          m.token,
          d.usdg,
        ])
      : await contract(`position.${t}`, "MockPosition", [m.token, d.usdg, usdgUnits(DEMO_PRICES[t])]);
    const well = await contract(`well.${t}`, "WellTakestock", [
      {
        usdg: d.usdg,
        stock: m.token,
        position: await position.getAddress(),
        oracle: out.oracle,
        swapAdapter: d.swapAdapter,
        feeRouter: out.feeRouter,
        admin: d.timelock,
        guardian: d.roles.guardian,
        keeper: d.roles.keeper,
        heldValueCap: usdgUnits(L.heldValueCapUsdg),
      },
      `Takestock ${t} Well`,
      `tw${t}`,
    ]);
    if (!same(await well.position(), await position.getAddress())) throw new Error(`The ${t} Well is not tied to its recorded position.`);
    if (same(await position.vault(), ethers.ZeroAddress)) await tx(position.bind(well));
    if (!same(await position.vault(), await well.getAddress())) throw new Error(`The ${t} position is bound to another vault.`);
    if ((await registry.indexPlusOne(well)) === 0n) await tx(registry.list(well, 0, t));
    out.liquidityVaults[t] = { vault: await well.getAddress(), position: await position.getAddress(), stock: m.token, name: m.name };
  }

  const cl = L.creditLine;
  for (const t of lines) {
    if (!out.liquidityVaults[t]) {
      console.log(`  ${t} credit line skipped: no ${t} Well`);
      continue;
    }
    const desk = await contract(`creditLine.${t}`, "CreditDeskTakestock", [
      out.liquidityVaults[t].vault,
      out.feeRouter,
      d.timelock,
      d.roles.guardian,
      cl.risk,
      {
        baseRatePerYear: wad(cl.rates.baseRatePerYear),
        slope1PerYear: wad(cl.rates.slope1PerYear),
        slope2PerYear: wad(cl.rates.slope2PerYear),
        kinkUtilization: wad(cl.rates.kinkUtilization),
      },
      usdgUnits(cl.supplyCapUsdg),
      usdgUnits(cl.borrowCapUsdg),
      `Takestock ${t} Credit Line`,
      `tc${t}`,
    ]);
    if ((await registry.indexPlusOne(desk)) === 0n) await tx(registry.list(desk, 1, t));
    out.creditLines[t] = await desk.getAddress();
  }
  if (!Object.keys(out.liquidityVaults).length) throw new Error("No Well could be added.");

  console.log("Handing the oracle and the registry to the timelock (it accepts with ./govern.sh handoff)");
  for (const c of [oracle, registry]) {
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    if (!same(owner, d.timelock) && !same(pending, d.timelock)) await tx(c.transferOwnership(d.timelock));
  }

  Object.assign(d, out, {
    wellsBlock: progress.block,
    wellsTimelockAcceptances: [out.oracle, out.registry],
  });
  save(d);
  console.log(`  ${Object.keys(out.liquidityVaults).length} Wells and ${Object.keys(out.creditLines).length} credit line(s) deployed (${sent} transactions this run)`);
  return { out, sent };
}

function liveMarkets(wells) {
  const pools = require("../config/robinhood.pools.json");
  const markets = {};
  for (const t of wells) {
    const s = config.stockTokens[t];
    if (!s) throw new Error(`Unknown stock ${t} in config/robinhood.json`);
    const p = pools[t] && pools[t].pool;
    if (!p || !p.liquidity || BigInt(p.liquidity) === 0n) {
      console.log(`  ${t.padEnd(6)} skipped: no live hookless ${t}/USDG pool with liquidity right now (scripts/probe-pools.js)`);
      continue;
    }
    // A Well's swaps may lose at most 1% against Chainlink, so a pool whose fee alone is near that can never be used.
    if (Number(p.fee) > MAX_POOL_FEE) {
      console.log(`  ${t.padEnd(6)} skipped: its pool charges ${Number(p.fee) / 10_000}% a swap, too close to the Well's 1% swap-loss limit`);
      continue;
    }
    markets[t] = { token: s.address, feed: s.chainlinkFeed, name: s.name, fee: p.fee, tickSpacing: p.tickSpacing };
  }
  return {
    usdgFeed: config.chainlink.usdgUsdFeed,
    sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress,
    markets,
  };
}

/** Local demo: mock feeds, and the mock swap venue trades each Stock Token against USDG at its demo price. */
async function localMarkets(d, wells, signer) {
  const deploy = async (name, args) => {
    const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const swap = await ethers.getContractAt("MockSwapAdapter", d.swapAdapter, signer);
  const usdg = await ethers.getContractAt("MockERC20", d.usdg, signer);
  const markets = {};
  for (const t of wells) {
    const price = DEMO_PRICES[t];
    const token = d.stocks[t].token;
    const feed = await deploy("MockAggregator", [8, Math.round(price * 1e8)]);
    const stock = await ethers.getContractAt("MockStockToken", token, signer);
    await send(stock.mint(swap, wad(1_000_000)));
    await send(swap.setRate(token, usdg, usdgUnits(price)));
    await send(swap.setRate(usdg, token, 10n ** 36n / usdgUnits(price)));
    markets[t] = { token, feed: await feed.getAddress(), name: d.stocks[t].name };
  }
  return { usdgFeed: await usdgFeed.getAddress(), sequencerFeed: ethers.ZeroAddress, markets };
}

module.exports = { deployWells, poolKey, DEMO_PRICES };
