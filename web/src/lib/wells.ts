"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { creditDeskAbi, oracleAbi, positionAbi, wellAbi } from "@/generated/wellsAbi";
import { CHAIN_ID, USDG_ADDRESS, WELLS, WELL_CONTRACTS, type Well } from "./config";

export const ONE = 10n ** 18n; // every Robinhood Stock Token has 18 decimals
/** Well and credit-line shares have 12 decimals (USDG's 6 plus a 6-decimal offset against share-price games). */
export const SHARE_DECIMALS = 12;

export type WellState = Well & {
  value?: bigint; // USDG value of everything the Well holds, at Chainlink; undefined while the price is stale
  supply: bigint;
  cap: bigint;
  paused: boolean;
  fresh: boolean;
  holdings?: readonly [bigint, bigint]; // stock, USDG; undefined while the price is stale
  protocolShareBps: number;
  feesUsdg: bigint; // gross fees earned so far, stock fees valued at today's price
  price?: bigint; // USDG per share of stock, 6 dp
  sharePrice?: bigint; // USDG per Well share, 6 dp
  inRange?: boolean;
  placed: boolean;
};

/** Every Well's public state, refreshed every 20 seconds. */
export function useWells() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  return useQuery({
    queryKey: ["wells", CHAIN_ID],
    enabled: Boolean(client && WELLS.length),
    refetchInterval: 20_000,
    queryFn: async (): Promise<WellState[]> =>
      Promise.all(
        WELLS.map(async (w): Promise<WellState | null> => {
          try {
          const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
            client!.readContract({ address: w.vault, abi: wellAbi, functionName, args } as never) as Promise<T>;
          const p = <T,>(functionName: string) => client!.readContract({ address: w.position, abi: positionAbi, functionName } as never) as Promise<T>;
          const [supply, cap, paused, fresh, holdings, protocolShareBps, grossU, grossS, liquidity] = await Promise.all([
            r<bigint>("totalSupply"),
            r<bigint>("heldValueCap"),
            r<boolean>("paused"),
            r<boolean>("priceFresh"),
            // Valued at Chainlink inside the Well, so this fails while the price is stale; the in-kind exit still works.
            r<readonly [bigint, bigint]>("holdings").catch(() => undefined),
            r<number>("protocolShareBps"),
            r<bigint>("grossUsdgFees"),
            r<bigint>("grossStockFees"),
            p<bigint>("liquidity").catch(() => 0n),
          ]);
          const price = fresh && WELL_CONTRACTS.oracle
            ? await client!.readContract({ address: WELL_CONTRACTS.oracle, abi: oracleAbi, functionName: "usdgValue", args: [w.stock, ONE] }).catch(() => undefined)
            : undefined;
          const value = price !== undefined && holdings ? holdings[1] + (holdings[0] * price) / ONE : undefined;
          const sharePrice = supply > 0n && value !== undefined ? (value * 10n ** BigInt(SHARE_DECIMALS)) / supply : undefined;
          let inRange: boolean | undefined;
          if (liquidity > 0n) {
            try {
              const [[, tick], lower, upper] = await Promise.all([p<readonly [bigint, number]>("slot0"), p<number>("tickLower"), p<number>("tickUpper")]);
              inRange = tick >= lower && tick < upper;
            } catch {
              inRange = undefined;
            }
          }
          const feesUsdg = grossU + (price !== undefined ? (grossS * price) / ONE : 0n);
          return { ...w, value, supply, cap, paused, fresh, holdings, protocolShareBps: Number(protocolShareBps), feesUsdg, price, sharePrice, inRange, placed: liquidity > 0n };
          } catch {
            return null; // one unreadable Well never hides the others
          }
        }),
      ).then((all) => all.filter((x): x is WellState => x !== null)),
  });
}

/** The connected wallet's side of one Well. */
export function useWellAccount(well?: Well) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  return useQuery({
    queryKey: ["wellAccount", CHAIN_ID, well?.vault, address],
    enabled: Boolean(client && well && address),
    refetchInterval: 20_000,
    queryFn: async () => {
      const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
        client!.readContract({ address: well!.vault, abi: wellAbi, functionName, args } as never) as Promise<T>;
      const shares = await r<bigint>("balanceOf", [address!]);
      const [value, maxWithdraw, maxDeposit, usdgBalance] = await Promise.all([
        shares > 0n ? r<bigint>("convertToAssets", [shares]).catch(() => undefined) : Promise.resolve(0n),
        r<bigint>("maxWithdraw", [address!]),
        r<bigint>("maxDeposit", [address!]),
        client!.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
      ]);
      return { shares, value, maxWithdraw, maxDeposit, usdgBalance };
    },
  });
}

/** One credit line, and the connected wallet's position in it. */
export function useCreditLine(desk: Address, vault: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  return useQuery({
    queryKey: ["credit", CHAIN_ID, desk, address],
    enabled: Boolean(client),
    refetchInterval: 20_000,
    queryFn: async () => {
      const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
        client!.readContract({ address: desk, abi: creditDeskAbi, functionName, args } as never) as Promise<T>;
      const [supplied, debt, utilization, borrowRate, supplyRate, risk, supplyCap, borrowCap, paused, totalPledged, vaultSupply] = await Promise.all([
        r<bigint>("totalAssets"),
        r<bigint>("totalDebt"),
        r<bigint>("utilization"),
        r<bigint>("borrowRatePerYear"),
        r<bigint>("supplyRatePerYear"),
        r<readonly [number, number, number, number, number, number]>("risk"),
        r<bigint>("supplyCap"),
        r<bigint>("borrowCap"),
        r<boolean>("paused"),
        r<bigint>("totalCollateralShares"),
        client!.readContract({ address: vault, abi: wellAbi, functionName: "totalSupply" }) as Promise<bigint>,
      ]);
      let me = null;
      if (address) {
        const [lent, acct, myDebt, collateral, borrowable, health, shares, usdgBal, maxDeposit] = await Promise.all([
          r<bigint>("maxWithdraw", [address]),
          r<readonly [bigint, bigint]>("accounts", [address]),
          r<bigint>("debtOf", [address]),
          r<bigint>("collateralValue", [address]).catch(() => undefined),
          r<bigint>("borrowable", [address]),
          r<bigint>("healthFactor", [address]).catch(() => undefined),
          client!.readContract({ address: vault, abi: wellAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
          client!.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          r<bigint>("maxDeposit", [address]),
        ]);
        me = { lent, pledged: acct[0], debt: myDebt, collateral, borrowable, health, shares, usdgBal, maxDeposit };
      }
      return { supplied, debt, utilization, borrowRate, supplyRate, risk, supplyCap, borrowCap, paused, totalPledged, vaultSupply, me };
    },
  });
}
