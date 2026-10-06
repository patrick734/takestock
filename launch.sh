#!/usr/bin/env bash
# Takestock launch: deploys everything from ONE dev wallet and exports the addresses to the website.
#   1. The burn contracts (burn/, Hardhat): TimelockTakestock (48h), SwapAdapterTakestock and BuyBurnTakestock.
#   2. The order contracts (contracts/, Foundry): RouterTakestock, QuoterTakestock and BookTakestock, whose protocol
#      fee is paid straight into BuyBurnTakestock. No owner on any of the three.
# The dev wallet is the timelock's proposer and executor and the guardian. The keeper is a separate bot wallet.
#
#   ./launch.sh               real deploy to Robinhood Chain
#   ./launch.sh --rehearsal   the same against the live chain without sending anything; spends nothing
#
# The dev wallet signs from ~/.foundry/keystores/$DEPLOYER_ACCOUNT (default takestock-dev, made by
# `node tools/import-key.js takestock-dev`), unlocked with ~/.foundry/takestock.pw. No key is typed or printed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
B="$ROOT/burn"; EXEC="$ROOT/contracts"; GEN="$ROOT/web/src/generated"
REHEARSAL=0; FORCE=0
for a in "$@"; do case "$a" in --rehearsal) REHEARSAL=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
mtime() { [ -f "$1" ] && { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; } || echo none; }

step "Settings"
export PATH="$HOME/.foundry/bin:$PATH"
command -v forge >/dev/null || stop "Foundry is not installed. Install it with: curl -L https://foundry.paradigm.xyz | bash && foundryup"
for d in "$B" "$ROOT/keeper"; do [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund); done
. "$ROOT/tools/env.sh"
[ -f "$ROOT/launch.env" ] && { load_launch_env "$ROOT/launch.env"; echo "Loaded launch.env"; }
[[ "${KEEPER_ADDRESS:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "KEEPER_ADDRESS is not set in launch.env (node tools/wallet.js keeper-secret prints it)."
export RPC_URL="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
[ -z "${TOKEN_ADDRESS:-}" ] && echo "No TOKEN_ADDRESS: deploying before the token. After the Pons launch, run ./set-token.sh with its address."

export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-takestock-dev}"
KS="$HOME/.foundry/keystores/$DEPLOYER_ACCOUNT"; PW="${DEPLOYER_PASSWORD_FILE:-$HOME/.foundry/takestock.pw}"
[ -f "$KS" ] || stop "No dev wallet keystore $KS. Create it with: node tools/import-key.js $DEPLOYER_ACCOUNT"
DEV="$(node "$ROOT/tools/wallet.js" address "$DEPLOYER_ACCOUNT")" || stop "Could not unlock the dev wallet keystore."
export DEPLOYER_ADDRESS="$DEV"
lc() { echo "$1" | tr A-F a-f; }
for n in ADMIN_MULTISIG GUARDIAN_MULTISIG; do
  v="${!n:-}"; [ -z "$v" ] || [ "$(lc "$v")" = "$(lc "$DEV")" ] || stop "$n in launch.env is $v, not the dev wallet. Remove it from launch.env (one-wallet launch)."
done
export ADMIN_MULTISIG="$DEV" GUARDIAN_MULTISIG="$DEV"
echo "Dev wallet: $DEV (deployer, timelock proposer/executor, guardian)"
echo "Keeper:     $KEEPER_ADDRESS"
[ "$(lc "$KEEPER_ADDRESS")" != "$(lc "$DEV")" ] || stop "The keeper must be a separate wallet from the dev wallet."

OUT="$B/deployments/robinhood.json"
BOOKED=0; grep -q '"book"' "$GEN/book.json" 2>/dev/null && BOOKED=1
if [ $REHEARSAL = 0 ] && [ -f "$OUT" ] && [ $BOOKED = 1 ] && [ $FORCE = 0 ]; then stop "Already deployed (burn/deployments/robinhood.json and web/src/generated/book.json). Use --force only for a second deployment."; fi

cd "$B" || exit 1
step "Compiling"
npx hardhat compile 2>&1 | tail -1 || stop "Burn contracts did not compile."
(cd "$EXEC" && forge build --skip test 2>&1 | tail -1) || stop "Order contracts did not compile."
step "Refreshing live pool data"
node scripts/probe-pools.js | grep -E "TSLA|NVDA|AAPL|PLTR|META|chainId" || stop "Could not read the live pools. Check your connection (or set ROBINHOOD_RPC_URL) and run again."
step "Preflight checks"
node scripts/preflight.js || stop "Preflight failed. Fix the FAIL lines above and run again."

if [ $REHEARSAL = 1 ]; then
  step "Rehearsal 1/2: burn contracts on a local copy of Robinhood Chain"
  FORK=1 DEPLOY_LIVE=1 LOCAL_SINGLE_WALLET=1 npx hardhat run scripts/deploy.js 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] && [ -f "$B/deployments/fork.json" ] || stop "Rehearsal did not finish (usually a dropped RPC connection). Set ROBINHOOD_RPC_URL and run it again."
  rm -f "$B/deployments/fork.json"
  step "Rehearsal 2/2: RouterTakestock, QuoterTakestock, BookTakestock (simulated against the live chain, not sent)"
  # The real fee sink only exists after step 1; any live contract stands in for it here.
  (cd "$EXEC" && FEE_SINK=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 forge script script/DeployTakestock.s.sol --rpc-url robinhood --sender "$DEV" 2>&1 \
    | grep -E "ROUTER=|QUOTER=|BOOK=|FeeBps=|Error|error"; exit "${PIPESTATUS[0]}") || stop "Order contracts simulation failed."
  step "Rehearsal complete. Nothing was sent to Robinhood Chain."; exit 0
fi

printf '\n\033[33mThis deploys Takestock to Robinhood Chain with real gas from %s.\033[0m\n' "$DEV"
read -r -p "Type DEPLOY to continue: " ans; [ "$ans" = "DEPLOY" ] || stop "Cancelled."

step "1/2 Burn contracts: TimelockTakestock, SwapAdapterTakestock, BuyBurnTakestock"
if [ -f "$OUT" ] && [ $FORCE = 0 ]; then
  echo "Already deployed: $OUT (continuing with the order contracts)"
else
  ok=0
  for attempt in 1 2 3; do
    before="$(mtime "$OUT")"
    npx hardhat run scripts/deploy.js --network robinhood 2>&1 | grep -v '^\s\+at '
    status=${PIPESTATUS[0]}
    [ "$status" = 0 ] && [ "$(mtime "$OUT")" != "none" ] && [ "$(mtime "$OUT")" != "$before" ] && { ok=1; break; }
    # A half-finished attempt holds no funds and nothing points at it; a retry deploys a full fresh set.
    printf '\033[33mAttempt %s did not finish (usually a dropped connection to the Robinhood RPC).\033[0m\n' "$attempt"
    [ $attempt -lt 3 ] && sleep 10
  done
  [ $ok = 1 ] || stop "Burn contracts did not deploy after 3 attempts. Try another connection or set ROBINHOOD_RPC_URL in launch.env, then run ./launch.sh again."
fi
FEE_SINK="$(node -e 'console.log(require(process.argv[1]).buyBurn)' "$OUT")"
[[ "$FEE_SINK" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "No BuyBurnTakestock address in $OUT."

step "2/2 Order contracts: RouterTakestock, QuoterTakestock, BookTakestock (protocol fee to $FEE_SINK)"
RUN="$EXEC/broadcast/DeployTakestock.s.sol/4663/run-latest.json"
rm -f "$RUN"   # never read a previous run's record
(cd "$EXEC" && FEE_SINK="$FEE_SINK" forge script script/DeployTakestock.s.sol --rpc-url robinhood --broadcast --slow \
    --account "$DEPLOYER_ACCOUNT" --password-file "$PW" 2>&1 | grep -v '^\s\+at '; exit "${PIPESTATUS[0]}")
fstatus=$?
[ -f "$RUN" ] || stop "The order contracts were not sent (forge exit $fstatus). The burn contracts are deployed (kept); fix the message above and run ./launch.sh again."
node -e '
  const r = require(process.argv[1]); const fs = require("fs");
  const ok = (name) => {
    const tx = r.transactions.find((t) => t.contractName === name && t.contractAddress);
    const rc = tx && (r.receipts || []).find((x) => x.contractAddress && x.contractAddress.toLowerCase() === tx.contractAddress.toLowerCase());
    if (!tx || !rc || rc.status !== "0x1") { console.error(name + " deployment not confirmed"); process.exit(1); }
    return { address: tx.contractAddress, block: Number(rc.blockNumber) };
  };
  const router = ok("RouterTakestock"), quoter = ok("QuoterTakestock"), book = ok("BookTakestock");
  const out = { router: router.address, quoter: quoter.address, book: book.address, block: router.block };
  fs.mkdirSync(require("path").dirname(process.argv[2]), { recursive: true });
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
  console.log("RouterTakestock", out.router); console.log("QuoterTakestock", out.quoter); console.log("BookTakestock  ", out.book, "block", out.block);
' "$RUN" "$GEN/book.json" || stop "The order contracts did not all deploy. Run ./launch.sh again (the burn contracts are kept)."

step "Exporting addresses to the website"
node scripts/export-web.js robinhood || stop "Deployed, but exporting addresses failed. Run: (cd burn && node scripts/export-web.js)"
step "Deployed"
echo "Addresses: web/src/generated/book.json and burn/deployments/robinhood.json"
echo "Next:"
echo "  1. Publish (Vercel builds the site; both keepers start dry runs): git add -A && git commit -m Deploy && git push"
echo "  2. Publish the source code: ./verify.sh"
echo "  3. Timelock handoff (run it again after 48h): ./govern.sh handoff"
echo "  4. Keepers live: set the GitHub repository variable KEEPER_LIVE=1"
