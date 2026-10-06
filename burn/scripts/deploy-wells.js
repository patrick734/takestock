// Adds the Wells and the credit line to the deployed Takestock burn contracts. See scripts/wells.js for what goes out.
//   Robinhood Chain (launch-wells.sh):  npx hardhat run scripts/deploy-wells.js --network robinhood
//   Local demo, after deploy.js:        npx hardhat run scripts/deploy-wells.js --network keeper
// Started again after a dropped connection, it continues where it stopped.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { deployWells } = require("./wells");

const LIVE = network.name === "robinhood";
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const send = async (p) => (await p).wait();

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No ${path.relative(process.cwd(), file)}: deploy Takestock first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const progressFile = file.replace(/\.json$/, ".wells-progress.json");
  if (d.liquidityVaults && Object.keys(d.liquidityVaults).length && !fs.existsSync(progressFile)) {
    console.log(`The Wells are already in ${path.relative(process.cwd(), file)}. Nothing to do.`);
    return;
  }

  // Live: the dev wallet from its keystore. Local: the demo's admin account (unlocked on a Hardhat node).
  const signer = LIVE ? (await ethers.getSigners())[0] : await ethers.getSigner(d.roles.admin);
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/takestock-dev (or DEPLOYER_ACCOUNT) not found.");

  const save = (dep) => fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  const { out } = await deployWells({ signer, d, live: LIVE, progressFile, save });
  fs.rmSync(progressFile, { force: true });
  if (!LIVE) await seedLocal(d, out);
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
}

/** Gives the local demo something to show: Well deposits, a range, fees and a funded credit line with one loan. */
async function seedLocal(d, out) {
  const signers = await ethers.getSigners();
  const [keeper, demo, borrower] = [signers[3], signers[4], signers[5]];
  console.log("Seeding the local demo");
  const usdg = await ethers.getContractAt("MockERC20", d.usdg);
  for (const who of [demo, borrower]) await send(usdg.mint(who.address, usdgUnits(500_000)));
  for (const [t, w] of Object.entries(out.liquidityVaults)) {
    const well = await ethers.getContractAt("WellTakestock", w.vault);
    await send(usdg.connect(demo).approve(well, usdgUnits(6_000)));
    await send(well.connect(demo).deposit(usdgUnits(6_000), demo.address));
    await send(well.connect(keeper).rebalance(-600, 600, true, usdgUnits(3_000), "0x"));
    const position = await ethers.getContractAt("MockPosition", w.position);
    const price = require("./wells").DEMO_PRICES[t];
    await send(position.accrueFees(ethers.parseEther((30 / price).toFixed(6)), usdgUnits(30)));
    await send(well.harvest());
  }
  for (const desk of Object.values(out.creditLines)) {
    const c = await ethers.getContractAt("CreditDeskTakestock", desk);
    await send(usdg.connect(demo).approve(c, usdgUnits(8_000)));
    await send(c.connect(demo).deposit(usdgUnits(8_000), demo.address));
    const well = await ethers.getContractAt("WellTakestock", await c.vault());
    await send(usdg.connect(borrower).approve(well, usdgUnits(2_000)));
    await send(well.connect(borrower).deposit(usdgUnits(2_000), borrower.address));
    const shares = await well.balanceOf(borrower.address);
    await send(well.connect(borrower).approve(c, shares));
    await send(c.connect(borrower).pledge(shares));
    await send(c.connect(borrower).borrow(usdgUnits(500), borrower.address));
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
