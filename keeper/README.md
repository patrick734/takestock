# Takestock keeper (Wells and buy-and-burn)

A small Node.js bot (ethers v6) that runs the Wells and burn duties, one cycle at a time. Order fills are a separate
bot: `engine/scripts/keeper.ts`, run by `.github/workflows/book-keeper.yml`.

| Duty | Calls | Who may call |
|---|---|---|
| Wells: keep the range around the Chainlink price, collect fees | `rebalance`, `harvest` | keeper / anyone |
| Credit lines: claim reserves | `claimReserves` | anyone |
| Forward Well and credit-line fees, then buy and burn the token (order-book fees arrive in BuyBurn directly) | `FeeRouter.routeMany`, `BuyBurn.buyAndBurn` | anyone / keeper |

Every call is simulated from the keeper address first. A call whose simulation reverts is logged and skipped, so one
failing Well or credit line never stops the rest of the cycle.

## Running

The keeper reads ABIs from `burn/artifacts` (run `npx hardhat compile` there first) and addresses from
`burn/deployments/<KEEPER_NETWORK>.json`.

```bash
node src/index.js --once                                   # dry run: simulates, sends nothing
DRY_RUN=0 KEEPER_PRIVATE_KEY=... node src/index.js         # live, looping
```

**Recommended:** GitHub Actions (`.github/workflows/burn-keeper.yml`). The key lives only in the repository secret
`KEEPER_PRIVATE_KEY`, created by `node tools/wallet.js keeper-secret`, which prints the address and
never the key. The workflow runs a cycle about every 15 minutes and stays in dry-run mode until the repository variable
`KEEPER_LIVE` is `1`.

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | Required when `DRY_RUN=0`. Read from the environment only, never logged. |
| `DRY_RUN` | dry run | Only `DRY_RUN=0` sends transactions. |
| `RPC_URL` | public Robinhood RPC | JSON-RPC endpoint. |
| `KEEPER_NETWORK` | `robinhood` | Picks the deployment file. |
| `KEEPER_CONFIG` | none | JSON file merged over `config.json`. |
| `KEEPER_STATE_FILE` | none | Keeps harvest times and scan positions between one-shot runs. |
| `LOG_JSON`, `LOG_LEVEL` | off, `info` | Log format and verbosity. |

## Settings (`config.json`)

`rebalance` and `harvest` cover the Wells (range width, when to re-centre, how often to collect fees), `creditLines`
covers reserve claims, and `buyBurn.defaultRoute` is `["IN","USDG","ETH","TOKEN"]`: the fee token, USDG, native ETH,
then the token's Pons pool.

Until the token's Pons pool is registered on the swap adapter (`./govern.sh register-pool`, after graduation), buy-and-burn
quotes revert and fees simply wait in BuyBurn.

## Tests

```bash
npm test                                         # offline: tick math, rebalance planning, routes
```

End to end against a local node (port 8547):

```bash
cd ../burn && npx hardhat node --port 8547                           # terminal 1
npx hardhat run scripts/deploy.js --network keeper && npx hardhat run scripts/deploy-wells.js --network keeper
cd ../keeper && npm run smoke
```

The smoke test runs a dry cycle (asserts nothing was sent), a live cycle (Wells rebalance and harvest, fees are bought
and burned), and a cycle two days later at a new price (Wells revalued, credit-line interest accrued and reserves
claimed). It only runs on chain id 31337.

## Safety

- Nothing is sent unless `DRY_RUN=0`.
- The keeper key holds only `KEEPER_ROLE` plus gas. The contracts bound what it can do: registered pools and swap-loss
  limits on rebalances; per-run caps and a minimum interval on buy-and-burn. The guardian can pause the vaults and halt buy-and-burn.
- Run one live keeper per key; nonces are managed locally.
