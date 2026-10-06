# Takestock

Take-profit and stop-loss orders for Robinhood Stock Tokens on Robinhood Chain. Pick a stock, set the gain you want
(+10%, +25%, your own price), add a stop-loss if you like, or sell in steps. The order fills itself the moment the
pools pay your target. Every contract carries the Takestock name.

- **BookTakestock**: deposit, set your exits, and the order fills in one transaction through **RouterTakestock**,
  split across the Uniswap v3 and v4 pools that pay most. Take-profit and limit legs are enforced on what you receive;
  stops trigger on Chainlink's price (not a single pool) with a slippage floor; a bracket is both. `placeMany` places
  a ladder of up to 10 orders in one transaction. Partial fills are optional. Cancel any time; whatever is left is
  refunded at expiry. No owner, no admin, no pause, no upgrades.
- **Fees**, fixed at deployment and only on fills: 0.05% to whoever fills the order and 0.25% to
  **BuyBurnTakestock**, which can only buy $TSTK and burn it (it has no withdrawal function). If an output token
  refuses the transfer to BuyBurn, that share goes to the maker instead, so a fee can never block a fill.
- **BuyBurnTakestock**, **SwapAdapterTakestock** and **TimelockTakestock** (48 hours): the burn side. A keeper spends
  the fees on $TSTK through the token's Pons pool at most once an hour, within per-run caps.
- **Wells** (**WellTakestock**, one per Stock Token, each with a **PositionTakestock**): ERC-4626 vaults that take USDG
  and keep one concentrated range in that stock's hookless Uniswap v4 USDG pool, centred on Chainlink's price. Shares
  are valued at Chainlink, never at the pool; deposits are refused while the pool is more than 2% off; keeper swaps are
  refused past a 1% loss against Chainlink. Swap fees compound for depositors; 30% goes through **FeeRouterTakestock**
  to BuyBurnTakestock. `redeemInKind` exits with no price and no swap, even while paused.
- **CreditDeskTakestock**: an isolated credit line (META at launch). Lenders supply USDG; borrowers pledge Well shares
  and borrow USDG up to 40% of their value, with liquidation below 55%. **OracleTakestock** prices every stock from
  Chainlink through the USDG/USD feed; **RegistryTakestock** lists the Wells and credit lines. The timelock is admin of
  all of it; the dev wallet is guardian (pause, lower caps).

```
contracts/  Foundry: BookTakestock, RouterTakestock, QuoterTakestock + tests
burn/       Hardhat: burn side, Wells and credit line + deploy/verify/governance scripts
engine/     routing engine + the book keeper (scripts/keeper.ts) that fills and refunds orders
keeper/     the Wells keeper (ranges, fee harvests, reserves, fee routing) and the burn keeper
web/        Next.js app (static export): take profit, advanced orders, my orders, markets, Wells, borrow
tools/      wallet tools: encrypted keystores, keeper key straight into a GitHub secret
```

Tests:

```
cd contracts && forge test --no-match-contract Fork      # order book, router, protocol fee, ladders
cd burn && npx hardhat test                              # burn side, Wells, credit line (also on real Uniswap v4 bytecode)
cd keeper && npm test                                    # keeper planning and routes
```

The order book and router build on the MIT-licensed Stocklimit contracts; the burn side on the MIT-licensed
Stonkwell contracts. Not independently audited. Nothing here is investment advice.
