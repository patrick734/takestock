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

async function deployVault(ctx, ticker, price) {
  const { admin, guardian, keeper, usdg, oracle, swap, feeRouter } = ctx;
  const stock = await ethers.deployContract("MockStockToken", [`${ticker} Stock Token`, ticker]);
  const feed = await ethers.deployContract("MockAggregator", [8, FEED(price)]);
  await oracle.connect(admin).setFeed(stock, feed, 3600);

  const position = await ethers.deployContract("MockPosition", [stock, usdg, USDG(price)]);
  const vault = await ethers.deployContract("WellTakestock", [
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
    `Takestock ${ticker} Well`,
    `tw${ticker}`,
  ]);
  await position.bind(vault);

  await swap.setRate(stock, usdg, rate(price, 18, 6));
  await swap.setRate(usdg, stock, rate(1 / price, 6, 18));
  await stock.mint(swap, EQ(1_000_000));
  return { stock, feed, position, vault };
}

async function deployToken(holder, supply) {
  const t = await ethers.deployContract("MockERC20", ["Takestock", "TSTK", 18]);
  await t.mint(holder.address, supply);
  return t;
}

async function baseFixture() {
  const [admin, guardian, keeper, alice, bob, carol] = await ethers.getSigners();

  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const sequencer = await ethers.deployContract("MockAggregator", [0, 0]);
  const now = await time.latest();
  await sequencer.set(0, now - 7200, now);
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
  const oracle = await ethers.deployContract("OracleTakestock", [admin.address, sequencer, usdgFeed, 90_000, 6]);

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
  const feeRouter = await ethers.deployContract("FeeRouterTakestock", [admin.address, buyBurn]);

  await usdg.mint(swap, USDG(100_000_000));
  await tok.connect(admin).transfer(swap, EQ(100_000_000));
  await swap.setRate(usdg, tok, rate(100, 6, 18));

  for (const user of [alice, bob, carol]) await usdg.mint(user, USDG(1_000_000));

  const ctx = { admin, guardian, keeper, alice, bob, carol, usdg, usdgFeed, sequencer, oracle, swap, tok, buyBurn, feeRouter };
  const amd = await deployVault(ctx, "AMD", 150);
  // The order book pays its fee in whatever the maker bought, so BuyBurn also takes Stock Tokens.
  await swap.setRate(amd.stock, tok, rate(150 * 100, 18, 18));
  return { ...ctx, amd, stock: amd.stock };
}

async function deposit(ctx, vault, user, amount) {
  await ctx.usdg.connect(user).approve(vault, amount);
  await vault.connect(user).deposit(amount, user.address);
}

module.exports = { deployToken, USDG, EQ, FEED, WAD, rate, deployVault, baseFixture, deposit };
