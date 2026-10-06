// Rehearses the Wells add-on on a local copy of Robinhood Chain (FORK=1), against the real Takestock burn contracts,
// Uniswap v4 pools and Chainlink feeds, as the dev wallet. Then it uses what it deployed: USDG into every Well, the
// keeper places each range, an exact USDG withdrawal, a redemption in kind, and a credit-line loan repaid in full.
// Ends with what the real deploy will cost. Nothing is sent to Robinhood Chain.
//   FORK=1 npx hardhat run scripts/rehearse-wells.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");
const { deployWells } = require("./wells");
const { planRebalance } = require("../../keeper/src/plan");
const keeperCfg = require("../../keeper/config.json");

const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const fmt = (v) => ethers.formatUnits(v, 6);
const send = async (p) => (await p).wait();
let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failures++;
};

async function as(address) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x56BC75E2D63100000"]); // 100 ETH, rehearsal only
  return ethers.getSigner(address);
}

async function main() {
  if (network.name !== "hardhat" || !process.env.FORK) throw new Error("Run with FORK=1 on the hardhat network.");
  const real = path.join(__dirname, "..", "deployments", "robinhood.json");
  if (!fs.existsSync(real)) throw new Error("No deployments/robinhood.json: deploy Takestock first (./launch.sh).");
  const d = JSON.parse(fs.readFileSync(real, "utf8"));
  if (d.liquidityVaults && Object.keys(d.liquidityVaults).length) throw new Error("The Wells are already deployed (deployments/robinhood.json).");

  // Mine one local block first: Hardhat cannot run calls against the forked block itself on a chain it has no
  // hardfork history for, but it can on every block it mines on top.
  await network.provider.send("evm_mine", []);
  const dev = d.roles.admin;
  const devBalance = await ethers.provider.getBalance(dev);
  const realChain = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
  const gasPrice = (await realChain.getFeeData()).gasPrice ?? 0n;
  const startBlock = await ethers.provider.getBlockNumber();
  const signer = await as(dev);

  const progressFile = path.join(__dirname, "..", "deployments", "fork.wells-progress.json");
  fs.rmSync(progressFile, { force: true });
  let deployed;
  try {
    ({ out: deployed } = await deployWells({ signer, d, live: true, progressFile, save: () => {} }));
  } finally {
    fs.rmSync(progressFile, { force: true });
  }

  // What the deploy used, priced at today's gas price.
  let gas = 0n;
  const endBlock = await ethers.provider.getBlockNumber();
  for (let b = startBlock + 1; b <= endBlock; b++) {
    const block = await ethers.provider.getBlock(b, true);
    for (const t of block.prefetchedTransactions) {
      if (t.from.toLowerCase() !== dev.toLowerCase()) continue;
      gas += (await ethers.provider.getTransactionReceipt(t.hash)).gasUsed;
    }
  }

  console.log("\nUsing it");
  const usdg = await ethers.getContractAt("MockERC20", d.usdg);
  const user = (await ethers.getSigners())[5];
  // The PoolManager holds the USDG of every v4 pool: borrow some for the rehearsal user.
  const pm = await as(config.uniswap.poolManager);
  const pool = await usdg.balanceOf(pm.address);
  await send(usdg.connect(pm).transfer(user.address, pool < usdgUnits(10_000) ? pool : usdgUnits(10_000)));
  let exercised = 0;
  const keeper = await as(d.roles.keeper);

  for (const [t, w] of Object.entries(deployed.liquidityVaults)) {
    const well = await ethers.getContractAt("WellTakestock", w.vault);
    const position = await ethers.getContractAt("PositionTakestock", w.position);
    const oracle = await ethers.getContractAt("OracleTakestock", deployed.oracle);
    if (!(await well.priceFresh())) {
      console.log(`  skip  ${t}: Chainlink price not fresh right now (market closed); deposits wait for the next update`);
      continue;
    }
    try {
      await send(usdg.connect(user).approve(well, usdgUnits(1_000)));
      await send(well.connect(user).deposit(usdgUnits(1_000), user.address));
      const stock = await ethers.getContractAt("MockERC20", w.stock);
      const unit = 10n ** BigInt(await stock.decimals());
      const [slot, liquidity, lower, upper, fair, [heldS, heldU], idleS, idleU] = await Promise.all([
        position.slot0(), position.liquidity(), position.tickLower(), position.tickUpper(),
        oracle.usdgValue(w.stock, unit), well.holdings(), stock.balanceOf(well), usdg.balanceOf(well),
      ]);
      const key = await position.poolKey();
      const plan = planRebalance({
        cfg: keeperCfg.rebalance, fair, stockUnit: unit, stockIsToken0: await position.stockIsToken0(),
        spacing: Number(key.tickSpacing), sqrtPriceX96: slot[0], poolTick: Number(slot[1]), liquidity,
        lower: Number(lower), upper: Number(upper), heldS, heldU, idleS, idleU,
      });
      let placed = false;
      for (const size of [plan.amount, plan.amount / 2n, plan.amount / 4n, 0n]) {
        try {
          await send(well.connect(keeper).rebalance(plan.target.lower, plan.target.upper, plan.sellUsdg, size, "0x"));
          placed = true;
          break;
        } catch {}
      }
      exercised++;
      check(placed && (await position.liquidity()) > 0n, `${t}: 1,000 USDG in, keeper placed the range [${plan.target.lower}, ${plan.target.upper}]`);
      const value = await well.totalAssets();
      check(value > usdgUnits(970), `${t}: Well worth ${fmt(value)} USDG after placing it`);
      const before = await usdg.balanceOf(user.address);
      await send(well.connect(user).withdraw(usdgUnits(300), user.address, user.address));
      check((await usdg.balanceOf(user.address)) - before === usdgUnits(300), `${t}: exact 300 USDG withdrawal`);
      if (t !== Object.keys(deployed.creditLines)[0]) {
        await send(well.connect(user).redeemInKind(await well.balanceOf(user.address), user.address, user.address, 0, 0));
        check((await well.balanceOf(user.address)) === 0n, `${t}: the rest redeemed in kind`);
      }
    } catch (e) {
      check(false, `${t}: ${e.shortMessage || e.message}`);
    }
  }

  for (const [t, address] of Object.entries(deployed.creditLines)) {
    const desk = await ethers.getContractAt("CreditDeskTakestock", address);
    const well = await ethers.getContractAt("WellTakestock", await desk.vault());
    if (!(await well.priceFresh()) || (await well.balanceOf(user.address)) === 0n) {
      console.log(`  skip  ${t} credit line: needs a fresh price and Well shares`);
      continue;
    }
    try {
      await send(usdg.connect(user).approve(desk, ethers.MaxUint256));
      await send(desk.connect(user).deposit(usdgUnits(500), user.address));
      // A credit line takes at most maxCollateralShareBps (30%) of a Well's shares as collateral.
      const shares = ((await well.totalSupply()) * 25n) / 100n;
      await send(well.connect(user).approve(desk, shares));
      await send(desk.connect(user).pledge(shares));
      const room = await desk.borrowable(user.address);
      await send(desk.connect(user).borrow(room / 2n, user.address));
      check((await desk.debtOf(user.address)) > 0n, `${t} credit line: borrowed ${fmt(room / 2n)} USDG against Well shares`);
      await send(desk.connect(user).repay(ethers.MaxUint256, user.address));
      await send(desk.connect(user).release(shares, user.address));
      check((await desk.debtOf(user.address)) === 0n && (await desk.accounts(user.address)).collateralShares === 0n, `${t} credit line: repaid and shares released`);
    } catch (e) {
      check(false, `${t} credit line: ${e.shortMessage || e.message}`);
    }
  }

  if (!exercised) {
    console.log("  FAIL  No Well could be tried: Chainlink prices are not fresh right now. Run the rehearsal again on a weekday.");
    failures++;
  }
  // Execution gas only: Robinhood Chain also charges for posting the data to Ethereum, hence the wide margin.
  const cost = gas * gasPrice;
  console.log(`\nThe real deploy uses about ${gas} gas: about ${ethers.formatEther(cost)} ETH of execution at today's gas price, plus a data fee.`);
  console.log(`The dev wallet ${dev} holds ${ethers.formatEther(devBalance)} ETH.`);
  if (gasPrice === 0n) {
    console.log("  FAIL  Could not read today's gas price from Robinhood Chain. Run the rehearsal again.");
    failures++;
  } else if (devBalance < cost * 3n) {
    console.log("  FAIL  Not enough ETH for the deploy with a safety margin. Withdraw more from KuCoin or OKX to the dev wallet.");
    failures++;
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
