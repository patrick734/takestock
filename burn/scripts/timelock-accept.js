// The timelock transactions that finish the ownership handoff after a deploy: schedule acceptOwnership() now, execute
// it once the delay has passed. There is one batch for the burn contracts (the swap adapter) and, once the Wells are
// added, one for the Wells' oracle and registry. Also reports where each batch stands.
// Read-only; sends nothing. scripts/handoff.js sends them.
//   node scripts/timelock-accept.js [deployments/robinhood.json]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
  "function getTimestamp(bytes32) view returns (uint256)",
];
const OWNABLE_ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"];

/** The handoff batches a deployment needs. The salts never change, so a scheduled batch is found again later. */
function batches(d) {
  const out = [];
  if ((d.pendingTimelockAcceptances || []).length)
    out.push({ name: "burn contracts", targets: d.pendingTimelockAcceptances, salt: ethers.id("takestock-accept-ownership") });
  if ((d.wellsTimelockAcceptances || []).length)
    out.push({ name: "Wells oracle and registry", targets: d.wellsTimelockAcceptances, salt: ethers.id("takestock-wells-accept-ownership") });
  return out;
}

// Builds the schedule/execute transactions for one batch and reads where it stands.
async function batchStatus(provider, d, b) {
  const timelock = new ethers.Contract(d.timelock, TIMELOCK_ABI, provider);
  const ownable = new ethers.Interface(OWNABLE_ABI);
  const payloads = b.targets.map(() => ownable.encodeFunctionData("acceptOwnership"));
  const values = b.targets.map(() => 0n);
  const predecessor = ethers.ZeroHash;
  const delay = await timelock.getMinDelay();
  const id = await timelock.hashOperationBatch(b.targets, values, payloads, predecessor, b.salt);

  const owners = [];
  for (const t of b.targets) {
    const c = new ethers.Contract(t, OWNABLE_ABI, provider);
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    owners.push({ target: t, owner, pending });
  }
  const [pendingOp, ready, done, ts] = await Promise.all([
    timelock.isOperationPending(id),
    timelock.isOperationReady(id),
    timelock.isOperationDone(id),
    timelock.getTimestamp(id),
  ]);
  const iface = new ethers.Interface(TIMELOCK_ABI);
  const schedule = { to: d.timelock, value: "0", data: iface.encodeFunctionData("scheduleBatch", [b.targets, values, payloads, predecessor, b.salt, delay]) };
  const execute = { to: d.timelock, value: "0", data: iface.encodeFunctionData("executeBatch", [b.targets, values, payloads, predecessor, b.salt]) };
  const status = done ? "done" : ready ? "ready" : pendingOp ? "scheduled" : "unscheduled";
  return { ...b, id, delay, owners, status, readyAt: Number(ts), schedule, execute };
}

async function handoff(provider, d) {
  const list = batches(d);
  if (!list.length) throw new Error("The deployment lists no pending timelock acceptances.");
  const out = [];
  for (const b of list) out.push(await batchStatus(provider, d, b));
  return out;
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "deployments", "robinhood.json"));
  if (!fs.existsSync(file)) throw new Error(`No deployment file at ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });
  for (const h of await handoff(provider, d)) {
    const hours = Number(h.delay) / 3600;
    console.log(`\n${h.name}: timelock ${d.timelock} (delay ${hours}h), proposer ${d.roles.admin}`);
    for (const { target, owner, pending } of h.owners) {
      const state =
        owner === d.timelock ? "done: owned by the timelock"
        : pending === d.timelock ? "waiting: timelock is pending owner"
        : `UNEXPECTED: owner ${owner}, pending ${pending}`;
      console.log(`  ${target}  ${state}`);
    }
    console.log(`Operation ${h.id}`);
    if (h.status === "done") console.log("Status: DONE.");
    else if (h.status === "ready") console.log("Status: READY. Run ./govern.sh handoff now.");
    else if (h.status === "scheduled") console.log(`Status: scheduled, executable after ${new Date(h.readyAt * 1000).toISOString()}.`);
    else console.log("Status: not scheduled yet. Run ./govern.sh handoff to schedule it.");
    if (h.status !== "done") {
      console.log("Schedule:", JSON.stringify(h.schedule));
      console.log(`Execute (after ${hours}h):`, JSON.stringify(h.execute));
    }
  }
}

module.exports = { handoff, batches };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
