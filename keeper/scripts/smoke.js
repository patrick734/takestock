// End-to-end check of the keeper against a local Hardhat node running the seeded demo deployment.
//
// First terminal:   cd burn && npx hardhat node --port 8547
// Second terminal:  cd burn && npx hardhat run scripts/deploy.js --network keeper
//                   npx hardhat run scripts/deploy-wells.js --network keeper
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

const MOCK_FEED = ["function setAnswer(int256)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
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

  const oracle = new ethers.Contract(dep.oracle, abis.Oracle, provider);
  const tok = new ethers.Contract(dep.token, [...abis.ERC20, "function totalSupply() view returns (uint256)"], provider);
  const keeperAddr = new ethers.Wallet(HARDHAT_KEEPER_KEY).address;
  const wells = Object.entries(dep.liquidityVaults).map(([t, v]) => [t, new ethers.Contract(v.vault, abis.LiquidityVault, provider)]);
  const desks = Object.entries(dep.creditLines).map(([t, a]) => [t, new ethers.Contract(a, abis.CreditDesk, provider)]);

  async function pushPrices(bump = 1) {
    const usdgFeed = new ethers.Contract(await oracle.usdgFeed(), MOCK_FEED, signer);
    await (await usdgFeed.setAnswer(100_000_000n)).wait();
    for (const m of Object.values(dep.markets)) {
      const f = new ethers.Contract(m.feed, MOCK_FEED, signer);
      const [, a] = await f.latestRoundData();
      await (await f.setAnswer((a * BigInt(Math.round(bump * 1000))) / 1000n)).wait();
    }
  }
  async function warp(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }
  const values = async () => Promise.all(wells.map(([, w]) => w.totalAssets()));
  const MINT = ["function mint(address,uint256)", ...abis.ERC20];
  const usdg = new ethers.Contract(dep.usdg, MINT, signer);
  const nvda = new ethers.Contract(dep.stocks.NVDA.token, MINT, signer);

  // The order book pays its protocol fee straight into BuyBurn: stand in for a few fills, in USDG and in a Stock Token.
  await (await usdg.mint(dep.buyBurn, 120_000_000n)).wait(); // 120 USDG
  await (await nvda.mint(dep.buyBurn, 10n ** 17n)).wait(); // 0.1 NVDA

  // 1. Dry run: simulates everything, sends nothing.
  await pushPrices();
  const nonceBefore = await provider.getTransactionCount(keeperAddr);
  const dry = runKeeper("dry run");
  check(/DRY_RUN, would send/.test(dry) || /nothing to/.test(dry), "dry run simulates");
  check((await provider.getTransactionCount(keeperAddr)) === nonceBefore, "dry run sent nothing");

  // 2. Live: Wells rebalance and harvest, their fees go through the FeeRouter to BuyBurn, and BuyBurn burns TSTK.
  const supplyBefore = await tok.totalSupply();
  const out = runKeeper("live", live);
  check((await provider.getTransactionCount(keeperAddr)) > nonceBefore, "keeper sent transactions");
  check(/buying and burning|rate limited|no fees waiting/.test(out), "buy and burn ran");
  check((await tok.totalSupply()) < supplyBefore, "fees bought and burned some TSTK");
  for (const [t, w] of wells) check((await w.totalAssets()) > 0n, `${t} Well holds value`);
  const feeRouterUsdg = await usdg.balanceOf(dep.feeRouter);
  check(feeRouterUsdg === 0n, "the FeeRouter forwarded everything to BuyBurn");

  // 3. A day later, with prices up 2%: the Wells re-centre, credit lines accrue interest and reserves are claimed.
  const before = await values();
  await warp(2 * 24 * 3600);
  await pushPrices(1.02);
  const later = runKeeper("live, two days later", live);
  const after = await values();
  check(after.every((v, i) => v > 0n && v !== before[i]), "every Well was revalued at the new price");
  check(/\[credit\]/.test(later), "credit lines were checked");
  for (const [t, d] of desks) check((await d.totalDebt()) > 500_000_000n, `${t} credit line accrued interest on its 500 USDG loan`);
  check((await nvda.balanceOf(dep.buyBurn)) < 10n ** 17n || (await usdg.balanceOf(dep.buyBurn)) === 0n, "order-book fees are being spent on TSTK");

  console.log(failures ? `\n${failures} smoke check(s) FAILED` : "\nsmoke test passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
