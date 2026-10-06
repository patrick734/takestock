// Deploys the Takestock burn contracts: TimelockTakestock, SwapAdapterTakestock and BuyBurnTakestock. The order book
// (Foundry, contracts/) is deployed next by launch.sh and pays its protocol fee straight into BuyBurnTakestock.
//   Local check (mocks):   npx hardhat run scripts/deploy.js --network localhost
//   Robinhood Chain:       npx hardhat run scripts/deploy.js --network robinhood
// Live deploys read their roles from the environment: ADMIN_MULTISIG (the timelock's proposer and executor),
// GUARDIAN_MULTISIG and KEEPER_ADDRESS. launch.sh sets all of them.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");

// DEPLOY_LIVE=1 runs the live path against a local copy of the chain (FORK=1), as a rehearsal.
const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
const REAL_ROLES = network.name === "robinhood";
const L = config.launch;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));
const ADMIN = ethers.ZeroHash;

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
  return c;
}

const send = async (p) => (await p).wait();

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const roles = REAL_ROLES
    ? { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS") }
    : process.env.LOCAL_SINGLE_WALLET === "1"
      ? { admin: deployer.address, guardian: deployer.address, keeper: rest[2].address }
      : { admin: rest[0].address, guardian: rest[1].address, keeper: rest[2].address };

  console.log(`Deploying the Takestock burn contracts to ${network.name} from ${deployer.address}`);
  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), roles, stocks: {} };

  const timelock = await deploy("TimelockTakestock", [LIVE ? L.timelockDelaySeconds : 60, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  out.timelock = await timelock.getAddress();
  out.block = (await timelock.deploymentTransaction().wait()).blockNumber;

  const env = LIVE ? liveEnv() : await localEnv();
  out.usdg = env.usdg;

  // A live deploy goes out before the token launches on Pons: BuyBurn starts without a token and the deployer sets it
  // once with set-token.sh. The local check mints its own.
  const pendingToken = LIVE && !process.env.TOKEN_ADDRESS;
  const token = process.env.TOKEN_ADDRESS ? await existingToken(process.env.TOKEN_ADDRESS) : pendingToken ? null : await localToken(deployer, env);
  out.token = token ? await token.getAddress() : null;
  if (token) {
    const meta = await ethers.getContractAt(["function symbol() view returns (string)", "function name() view returns (string)"], token);
    out.tokenSymbol = await meta.symbol();
    out.tokenName = await meta.name();
  }
  out.tokenSetter = pendingToken ? deployer.address : null;
  if (pendingToken) console.log(`  ${"token".padEnd(24)} not yet: set it after the Pons launch with ./set-token.sh`);

  const swap = LIVE ? await deploy("SwapAdapterTakestock", [deployer.address, config.uniswap.poolManager, env.usdg]) : env.swap;
  out.swapAdapter = await swap.getAddress();
  if (LIVE) {
    // Buy-and-burn path: fee token, USDG, native ETH, then the token's Pons pool (registered after graduation by
    // ./govern.sh register-pool). The Pons hook and the hookless ETH/USDG leg go in now.
    await send(swap.setHookAllowed(config.pons.hook, true));
    const eth = config.uniswap.ethUsdgPool;
    await send(swap.setPool({ currency0: ethers.ZeroAddress, currency1: env.usdg, fee: eth.fee, tickSpacing: eth.tickSpacing, hooks: ethers.ZeroAddress }));
    console.log(`  Pons hook allowed; ETH/USDG ${eth.fee}/${eth.tickSpacing} pool registered`);
  }

  const buyBurn = await deploy("BuyBurnTakestock", [
    token ?? ethers.ZeroAddress,
    swap,
    deployer.address,
    roles.guardian,
    roles.keeper,
    L.buyBurnMinIntervalSeconds,
    pendingToken ? deployer.address : ethers.ZeroAddress,
  ]);
  out.buyBurn = await buyBurn.getAddress();
  // Small runs: a freshly graduated Pons pool is thin, so big buys would move its price a lot.
  await send(buyBurn.setInputLimit(env.usdg, usdgUnits(L.buyBurnMaxUsdgPerRun)));

  console.log("Fee inputs");
  for (const [ticker, t] of Object.entries(env.stocks)) {
    if (LIVE && !t.pooled) {
      console.log(`  ${ticker.padEnd(6)} no hookless pool: its fees wait in BuyBurn until one is registered`);
      continue;
    }
    if (LIVE) await send(swap.setPool(poolKey(t.address, env.usdg, t.fee, t.tickSpacing)));
    await send(buyBurn.setInputLimit(t.address, wad(L.buyBurnMaxStockPerRun)));
    out.stocks[ticker] = { token: t.address, name: t.name };
  }
  console.log(`  USDG and ${Object.keys(out.stocks).join(" ")} can be bought into the token and burned`);

  console.log("Handing governance to the timelock");
  await send(buyBurn.grantRole(ADMIN, out.timelock));
  await send(buyBurn.renounceRole(ADMIN, deployer.address));
  if (LIVE) await send(swap.transferOwnership(out.timelock));
  out.pendingTimelockAcceptances = LIVE ? [out.swapAdapter] : [];

  const label = REAL_ROLES ? network.name : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log(`FEE_SINK=${out.buyBurn}`);
}

/** BuyBurn calls burn(uint256) on the token, so anything that cannot burn is refused here. */
async function existingToken(address) {
  if (!ethers.isAddress(address)) throw new Error("TOKEN_ADDRESS is not a valid address");
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at TOKEN_ADDRESS ${address}`);
  const token = await ethers.getContractAt("MockERC20", address);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (decimals !== 18n) throw new Error(`The token must have 18 decimals, got ${decimals}`);
  try {
    await token.burn.staticCall(0);
  } catch {
    throw new Error(`${symbol} at ${address} has no burn(uint256), which BuyBurn needs`);
  }
  console.log(`  ${"token".padEnd(24)} ${address} (${symbol})`);
  return token;
}

async function localToken(deployer, env) {
  const t = await deploy("MockERC20", ["Takestock", "TSTK", 18]);
  await send(t.mint(deployer.address, wad(1_000_000_000)));
  // The mock venue sells it at 0.01 USDG, so a local buy-and-burn has something to do.
  await send(t.mint(env.swap, wad(100_000_000)));
  await send(env.swap.setRate(env.usdg, t, 10n ** 32n));
  for (const s of Object.values(env.stocks)) await send(env.swap.setRate(s.address, t, wad(Math.round(s.price * 100))));
  return t;
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for a live deploy`);
  return v;
}

function poolKey(stock, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(stock) < BigInt(usdg) ? [stock, usdg] : [usdg, stock];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

function liveEnv() {
  const pools = require("../config/robinhood.pools.json");
  const stocks = {};
  for (const ticker of L.burnStocks) {
    const t = config.stockTokens[ticker];
    if (!t) throw new Error(`Unknown stock ${ticker} in config/robinhood.json`);
    const p = pools[ticker] && pools[ticker].pool;
    stocks[ticker] = { address: t.address, name: t.name, pooled: Boolean(p && p.liquidity && BigInt(p.liquidity) > 0n), fee: p && p.fee, tickSpacing: p && p.tickSpacing };
  }
  return { usdg: config.tokens.usdg.address, stocks };
}

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 236.31, PLTR: 191.53, META: 778.25 };

async function localEnv() {
  console.log("Local check: mock USDG, Stock Tokens and swap venue");
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const swap = await deploy("MockSwapAdapter");
  await send(usdg.mint(swap, usdgUnits(100_000_000)));
  const stocks = {};
  for (const [ticker, price] of Object.entries(DEMO_PRICES)) {
    const token = await ethers.deployContract("MockStockToken", [config.stockTokens[ticker].name, ticker]);
    stocks[ticker] = { address: await token.getAddress(), name: config.stockTokens[ticker].name, price };
  }
  return { usdg: await usdg.getAddress(), swap, stocks };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
