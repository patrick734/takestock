// Read-only launch checks. Sends nothing and never needs a private key.
// Usage: node scripts/preflight.js
// Env: ADMIN_MULTISIG, GUARDIAN_MULTISIG, KEEPER_ADDRESS, TOKEN_ADDRESS (optional),
//      DEPLOYER_ADDRESS (optional, for the gas balance check), ROBINHOOD_RPC_URL (optional).
// Exits 1 if any check fails, so a launch script can stop before deploying.
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");
const pools = require("../config/robinhood.pools.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const MIN_DEPLOYER_ETH = ethers.parseEther(process.env.MIN_DEPLOYER_ETH || "0.01");

let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => console.log(`  warn  ${msg}`);
const fail = (msg) => {
  failed++;
  console.log(`  FAIL  ${msg}`);
};

async function withRetry(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });

  console.log("Network");
  const chainId = await withRetry(() => provider.send("eth_chainId", []));
  if (BigInt(chainId) === BigInt(config.network.chainId)) ok(`chainId ${BigInt(chainId)} (Robinhood Chain)`);
  else fail(`chainId ${BigInt(chainId)}, expected ${config.network.chainId}`);

  console.log("Roles");
  const roles = {};
  for (const name of ["ADMIN_MULTISIG", "GUARDIAN_MULTISIG", "KEEPER_ADDRESS"]) {
    const v = process.env[name];
    if (!v || !ethers.isAddress(v)) {
      fail(`${name} is not set to an address`);
      continue;
    }
    roles[name] = ethers.getAddress(v);
    const code = await withRetry(() => provider.getCode(v));
    const isContract = code !== "0x";
    const wantsContract = name !== "KEEPER_ADDRESS";
    if (wantsContract && !isContract) warn(`${name} ${roles[name]} is a plain wallet, not a multisig contract`);
    else ok(`${name} ${roles[name]}${isContract ? " (contract)" : ""}`);
  }
  if (roles.ADMIN_MULTISIG && roles.ADMIN_MULTISIG === roles.GUARDIAN_MULTISIG) ok("one wallet holds admin (via the 48h timelock) and guardian");

  if (process.env.DEPLOYER_ADDRESS) {
    console.log("Deployer");
    const d = process.env.DEPLOYER_ADDRESS;
    if (!ethers.isAddress(d)) fail("DEPLOYER_ADDRESS is not an address");
    else {
      const bal = await withRetry(() => provider.getBalance(d));
      const msg = `${ethers.getAddress(d)} holds ${ethers.formatEther(bal)} ETH`;
      if (bal >= MIN_DEPLOYER_ETH) ok(msg);
      else fail(`${msg}, needs at least ${ethers.formatEther(MIN_DEPLOYER_ETH)} for gas`);
      if (Object.values(roles).includes(ethers.getAddress(d))) warn("the deployer is also one of the role addresses");
    }
  }

  console.log("Token");
  const w = process.env.TOKEN_ADDRESS;
  if (!w) ok("no token yet: deploying first; plug it in after the Pons launch with ./set-token.sh");
  else if (!ethers.isAddress(w)) fail("TOKEN_ADDRESS is not an address");
  else {
    const t = new ethers.Contract(w, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function burn(uint256)"], provider);
    try {
      const [symbol, decimals, supply] = await withRetry(() => Promise.all([t.symbol(), t.decimals(), t.totalSupply()]));
      if (decimals !== 18n) fail(`${symbol} has ${decimals} decimals, needs 18`);
      else ok(`${symbol} at ${ethers.getAddress(w)}, supply ${ethers.formatEther(supply)}`);
      // A real burn must refuse to burn more than the caller holds; a fallback would accept it.
      const over = await provider.call({ from: ethers.ZeroAddress.replace(/0$/, "1"), to: w, data: t.interface.encodeFunctionData("burn", [10n ** 30n]) }).then(() => true, () => false);
      const zero = await provider.call({ from: ethers.ZeroAddress.replace(/0$/, "1"), to: w, data: t.interface.encodeFunctionData("burn", [0n]) }).then(() => true, () => false);
      if (zero && !over) ok("burn(uint256) works, as BuyBurn requires");
      else fail("token has no working burn(uint256); BuyBurn cannot retire it");
    } catch (e) {
      fail(`could not read the token at ${w}: ${e.shortMessage || e.message}`);
    }
  }

  // Fees paid in a Stock Token are swapped to USDG through its hookless v4 pool before buying the token.
  // A stock without one still works on the order book; its fees simply wait in BuyBurn until a pool is registered.
  console.log("Fee pools (snapshot from probe-pools, which launch.sh runs right before this)");
  for (const ticker of config.launch.burnStocks) {
    const p = pools[ticker];
    const pool = p && p.pool;
    if (!config.stockTokens[ticker]) fail(`${ticker}: not in config.stockTokens`);
    else if (!pool || !pool.liquidity || BigInt(pool.liquidity) === 0n) warn(`${ticker}: no liquid hookless pool; its fees will wait in BuyBurn`);
    else ok(`${ticker}: pool fee ${pool.fee}/${pool.tickSpacing}`);
  }

  console.log(failed ? `\n${failed} check(s) failed. Fix them before deploying.` : "\nAll checks passed.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Preflight could not finish:", e.shortMessage || e.message);
  process.exit(1);
});
