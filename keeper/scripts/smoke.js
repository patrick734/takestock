// End-to-end check of the keeper against a local Hardhat node running the seeded demo deployment.
//
// First terminal:   cd burn && npx hardhat node --port 8547
// Second terminal:  cd burn && npx hardhat run scripts/deploy.js --network keeper
//                   cd ../keeper && npm run smoke
//
// Refuses to run on anything but a Hardhat chain (31337): it moves time and pushes mock prices.
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8547";
const NETWORK = process.env.KEEPER_NETWORK || "keeper";
// Hardhat's well-known dev accounts (not secrets): #3 is the keeper deploy.js sets on local chains, #0 pushes
// mock prices.
const HARDHAT_KEEPER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const HARDHAT_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

process.env.KEEPER_NETWORK = NETWORK;
const { loadDeployment } = require("../src/config");
const abis = require("../src/abis");

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${msg}`);
  if (!ok) failures++;
};

function runKeeper(label, extraEnv = {}) {
  console.log(`\n===== keeper --once (${label}) =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), "--once"], {
    env: { ...process.env, RPC_URL, KEEPER_NETWORK: NETWORK, KEEPER_CONFIG: path.join(__dirname, "smoke.config.json"), ...extraEnv },
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  if (r.status !== 0) {
    console.log(`  FAIL keeper exited with ${r.status}`);
    failures++;
  }
  return out;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  if (Number((await provider.getNetwork()).chainId) !== 31337) throw new Error("smoke test only runs against a local Hardhat node");
  const dep = loadDeployment(NETWORK);
  const signer = new ethers.NonceManager(new ethers.Wallet(HARDHAT_ACCOUNT_0, provider));
  const live = { DRY_RUN: "0", KEEPER_PRIVATE_KEY: HARDHAT_KEEPER_KEY };
  const keeperAddr = new ethers.Wallet(HARDHAT_KEEPER_KEY).address;
  const MINT = ["function mint(address,uint256)", ...abis.ERC20, "function totalSupply() view returns (uint256)"];
  const usdg = new ethers.Contract(dep.usdg, MINT, signer);
  const tok = new ethers.Contract(dep.token, MINT, provider);
  const nvda = new ethers.Contract(dep.stocks.NVDA.token, MINT, signer);
  async function warp(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  // The order book pays its protocol fee into BuyBurn: stand in for a few fills, in USDG and in a Stock Token.
  await (await usdg.mint(dep.buyBurn, 120_000_000n)).wait(); // 120 USDG
  await (await nvda.mint(dep.buyBurn, 10n ** 17n)).wait(); // 0.1 NVDA

  // 1. Dry run: simulates everything, sends nothing.
  const nonceBefore = await provider.getTransactionCount(keeperAddr);
  const supply0 = await tok.totalSupply();
  const dry = runKeeper("dry run");
  check(/DRY_RUN, would send/.test(dry), "dry run simulates a buy and burn");
  check((await provider.getTransactionCount(keeperAddr)) === nonceBefore, "dry run sent nothing");
  check((await tok.totalSupply()) === supply0, "dry run burned nothing");

  // 2. Live: USDG (the largest known value) is bought into the token and burned.
  runKeeper("live", live);
  const supply1 = await tok.totalSupply();
  check(supply1 < supply0, "USDG fees bought and burned some TSTK");
  check((await usdg.balanceOf(dep.buyBurn)) === 0n, "all USDG fees were spent");

  // 3. Within the interval nothing more is bought.
  const rl = runKeeper("live, rate limited", live);
  check(/rate limited by minInterval/.test(rl), "minInterval is respected");

  // 4. An hour later the Stock Token fee goes too.
  await warp(3601);
  runKeeper("live, an hour later", live);
  check((await tok.totalSupply()) < supply1, "NVDA fees bought and burned some TSTK");
  check((await nvda.balanceOf(dep.buyBurn)) === 0n, "all NVDA fees were spent");

  console.log(failures ? `\n${failures} smoke check(s) FAILED` : "\nsmoke test passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
