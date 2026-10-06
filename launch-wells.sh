#!/usr/bin/env bash
# Adds the Wells and the credit line to the live Takestock deployment, from the same dev wallet:
#   OracleTakestock, FeeRouterTakestock, RegistryTakestock, one PositionTakestock + WellTakestock per stock
#   (TSLA NVDA AAPL META) and CreditDeskTakestock for META. Their protocol share goes through the FeeRouter into
#   the BuyBurnTakestock that ./launch.sh deployed. The timelock is admin of all of it.
#
#   ./launch-wells.sh --rehearsal   on a local copy of Robinhood Chain: deploys, then deposits, places ranges,
#                                   withdraws and borrows with what it deployed, and prints the gas cost. Spends nothing.
#   ./launch-wells.sh               the real deploy
#
# Signs from ~/.foundry/keystores/$DEPLOYER_ACCOUNT (default takestock-dev) with ~/.foundry/takestock.pw. No key is
# typed or printed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
B="$ROOT/burn"
REHEARSAL=0
for a in "$@"; do case "$a" in --rehearsal) REHEARSAL=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }

step "Settings"
for d in "$B" "$ROOT/keeper"; do [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund); done
. "$ROOT/tools/env.sh"
load_launch_env "$ROOT/launch.env"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
OUT="$B/deployments/robinhood.json"
[ -f "$OUT" ] || stop "No live deployment (burn/deployments/robinhood.json). Run ./launch.sh first."
grep -q '"liquidityVaults"' "$OUT" && [ ! -f "$B/deployments/robinhood.wells-progress.json" ] && stop "The Wells are already deployed (burn/deployments/robinhood.json)."
export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-takestock-dev}"
[ -f "$HOME/.foundry/keystores/$DEPLOYER_ACCOUNT" ] || stop "No dev wallet keystore ~/.foundry/keystores/$DEPLOYER_ACCOUNT."
DEV="$(node "$ROOT/tools/wallet.js" address "$DEPLOYER_ACCOUNT")" || stop "Could not unlock the dev wallet keystore."
ADMIN="$(node -e 'console.log(require(process.argv[1]).roles.admin)' "$OUT")"
[ "$(echo "$DEV" | tr A-F a-f)" = "$(echo "$ADMIN" | tr A-F a-f)" ] || stop "The keystore $DEPLOYER_ACCOUNT is $DEV, but this deployment's dev wallet is $ADMIN."
echo "Dev wallet: $DEV"

cd "$B" || exit 1
step "Compiling"
npx hardhat compile 2>&1 | tail -1 || stop "Contracts did not compile."
step "Refreshing live pool data"
node scripts/probe-pools.js | grep -E "TSLA|NVDA|AAPL|PLTR|META|chainId" || stop "Could not read the live pools. Check your connection (or ROBINHOOD_RPC_URL in launch.env) and run again."

if [ $REHEARSAL = 1 ]; then
  step "Rehearsal on a local copy of Robinhood Chain"
  FORK=1 npx hardhat run scripts/rehearse-wells.js 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] || stop "Rehearsal failed. Read the FAIL lines above (a dropped RPC connection: run it again)."
  step "Rehearsal complete. Nothing was sent to Robinhood Chain."; exit 0
fi

printf '\n\033[33mThis adds the Wells and the META credit line to Takestock with real gas from %s.\033[0m\n' "$DEV"
read -r -p "Type DEPLOY to continue: " ans; [ "$ans" = "DEPLOY" ] || stop "Cancelled."

step "Deploying the Wells and the credit line"
ok=0
for attempt in 1 2 3; do
  npx hardhat run scripts/deploy-wells.js --network robinhood 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] && grep -q '"liquidityVaults"' "$OUT" && { ok=1; break; }
  # Every address is saved as it appears, so the next attempt carries on from where this one stopped.
  printf '\033[33mAttempt %s did not finish (usually a dropped connection to the Robinhood RPC). Continuing.\033[0m\n' "$attempt"
  [ $attempt -lt 3 ] && sleep 10
done
[ $ok = 1 ] || stop "Not finished after 3 attempts. Run ./launch-wells.sh again: it continues where it stopped."

step "Exporting addresses to the website"
node scripts/export-web.js robinhood || stop "Deployed, but exporting addresses failed. Run: (cd burn && node scripts/export-web.js)"
step "Wells deployed"
echo "Next:"
echo "  1. Publish (site, keepers): git add -A && git commit -m Wells && git push"
echo "  2. Publish the source code: ./verify.sh"
echo "  3. Timelock handoff, now and again after 48h: ./govern.sh handoff"
