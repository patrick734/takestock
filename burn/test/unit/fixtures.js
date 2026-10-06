const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const FEED = (n) => ethers.parseUnits(String(n), 8);
const WAD = 10n ** 18n;

/** Rate for MockSwapAdapter: out = in * rate / 1e18. */
function rate(outPerInUnit, inDecimals, outDecimals) {
  return (ethers.parseUnits(String(outPerInUnit), outDecimals) * WAD) / 10n ** BigInt(inDecimals);
}

async function deployToken(holder, supply) {
  const t = await ethers.deployContract("MockERC20", ["Takestock", "TSTK", 18]);
  await t.mint(holder.address, supply);
  return t;
}

async function baseFixture() {
  const [admin, guardian, keeper, alice, bob, carol] = await ethers.getSigners();
  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const swap = await ethers.deployContract("MockSwapAdapter");
  const tok = await deployToken(admin, EQ(1_000_000_000));
  const buyBurn = await ethers.deployContract("BuyBurnTakestock", [
    tok,
    swap,
    admin.address,
    guardian.address,
    keeper.address,
    3600,
    ethers.ZeroAddress,
  ]);
  await usdg.mint(swap, USDG(100_000_000));
  await tok.connect(admin).transfer(swap, EQ(100_000_000));
  await swap.setRate(usdg, tok, rate(100, 6, 18));

  // A Stock Token fee input, as the order book pays when someone buys a stock.
  const stock = await ethers.deployContract("MockStockToken", ["AMD Stock Token", "AMD"]);
  await swap.setRate(stock, tok, rate(150 * 100, 18, 18));
  return { admin, guardian, keeper, alice, bob, carol, usdg, swap, tok, buyBurn, stock };
}

module.exports = { deployToken, USDG, EQ, FEED, WAD, rate, baseFixture };
