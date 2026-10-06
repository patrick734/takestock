// One-wallet timelock handoff, sent from the dev wallet (the timelock's proposer and executor).
// Schedules acceptOwnership() for every batch not scheduled yet, and executes every batch whose 48h delay has passed:
// run it once now and once more after 48 hours. Batches: the burn contracts' swap adapter and, once the Wells are
// added, their oracle and registry. Nothing is sent when every batch is waiting or done.
//   npx hardhat run scripts/handoff.js --network robinhood
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { handoff } = require("./timelock-accept");

async function main() {
  const label = network.name === "hardhat" ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/takestock-dev (or DEPLOYER_ACCOUNT) not found.");
  if (signer.address.toLowerCase() !== d.roles.admin.toLowerCase()) throw new Error(`Send this from the dev wallet ${d.roles.admin}, not ${signer.address}.`);

  let later = 0;
  for (const h of await handoff(ethers.provider, d)) {
    const what = `${h.name} (${h.targets.length} contract${h.targets.length > 1 ? "s" : ""})`;
    if (h.status === "done") {
      console.log(`${what}: done, the timelock owns them.`);
      continue;
    }
    if (h.status === "scheduled") {
      later = Math.max(later, h.readyAt);
      console.log(`${what}: scheduled, executable after ${new Date(h.readyAt * 1000).toISOString()}.`);
      continue;
    }
    const tl = d.timelock.toLowerCase();
    if (h.owners.every((o) => o.owner.toLowerCase() === tl)) {
      console.log(`${what}: done, the timelock owns them.`);
      continue;
    }
    if (h.status === "unscheduled") {
      const bad = h.owners.filter((o) => o.pending.toLowerCase() !== tl && o.owner.toLowerCase() !== tl);
      if (bad.length) {
        later = 1;
        console.log(`${what}: NOT scheduled, ${bad.map((o) => o.target).join(", ")} do not have the timelock as pending owner.`);
        continue;
      }
    }
    const tx = h.status === "ready" ? h.execute : h.schedule;
    const sent = await signer.sendTransaction({ to: tx.to, data: tx.data });
    console.log(`${what}: ${h.status === "ready" ? "executing" : "scheduling"} ${sent.hash}`);
    await sent.wait();
    if (h.status === "ready") console.log(`${what}: done, the timelock owns them.`);
    else {
      later = Math.max(later, Math.floor(Date.now() / 1000) + Number(h.delay));
      console.log(`${what}: scheduled. Run ./govern.sh handoff again after ${Math.round(Number(h.delay) / 3600)}h.`);
    }
  }
  if (!later) console.log("The handoff is complete: the timelock owns every contract. The dev wallet keeps only its timelock and guardian roles, plus the one-time token setter until it is used.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
