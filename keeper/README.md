# Takestock burn keeper

A small Node.js bot (ethers v6) that spends the protocol fees waiting in BuyBurnTakestock on $TSTK and burns it.
(Order fills are a separate bot: `engine/scripts/keeper.ts`, run by `.github/workflows/book-keeper.yml`.)

| Duty | Calls | Who may call |
|---|---|---|
| Buy $TSTK with a fee token (USDG first) and burn it, at most once per `minInterval` | `BuyBurn.buyAndBurn` | keeper |

Every call is simulated from the keeper address first. A call whose simulation reverts is logged and skipped, so one
failing fee token never stops the rest.

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
| `LOG_JSON`, `LOG_LEVEL` | off, `info` | Log format and verbosity. |

## Settings (`config.json`)

`buyBurn.defaultRoute` is `["IN","USDG","ETH","TOKEN"]`: the fee token, USDG, native ETH, then the token's Pons pool.
`buyBurn.slippageBps` (200) is the most a run may get below its own quote.

Until the token's Pons pool is registered on the swap adapter (`./govern.sh register-pool`, after graduation), buy-and-burn
quotes revert and fees simply wait in BuyBurn.

## Tests

```bash
npm test                                         # offline: routes and revert decoding
```

End to end against a local node (port 8547):

```bash
cd ../burn && npx hardhat node --port 8547                       # terminal 1
npx hardhat run scripts/deploy.js --network keeper               # terminal 2
cd ../keeper && npm run smoke
```

The smoke test puts USDG and NVDA fees into BuyBurn, then runs a dry cycle (asserts nothing was sent or burned), a live
cycle (the USDG is spent and $TSTK burned), a cycle inside the interval (nothing happens) and one an hour later (the
NVDA is spent too). It only runs on chain id 31337.

## Safety

- Nothing is sent unless `DRY_RUN=0`.
- The keeper key holds only `KEEPER_ROLE` on BuyBurn plus gas. BuyBurn bounds what it can do: registered pools only,
  per-run caps and a minimum interval, and whatever it buys is burned. The guardian can halt buy-and-burn.
- Run one live keeper per key; nonces are managed locally.
