"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { bookAbi, erc20Abi, feedPrice, minOutForSell, placeParams } from "@splitroute/engine";
import { CHAIN_ID, LIMIT_BOOK, txUrl } from "@/lib/config";
import { feedAbi, feedFor, STOP_MAX_AGE } from "@/lib/feeds";
import { fmt, num, parseAmount, usd } from "@/lib/format";
import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { TokenPicker } from "./TokenPicker";
import { TokenDot } from "./TokenDot";
import { useOpenWallet, walletError } from "./Wallet";
import { priceStr } from "./LimitCard";

const GAINS = [5, 10, 25, 50];
const STOPS = [0, 5, 10, 20];
const EXPIRIES = [
  { label: "7 days", s: 7 * 86_400 },
  { label: "30 days", s: 30 * 86_400 },
  { label: "90 days", s: 90 * 86_400 },
];
const STOP_SLIPPAGE = 2; // % below the stop price the seller still accepts once it triggers

type Step = { gain: number; price: number; amount: bigint; minOut: bigint; stopMinOut?: bigint };

/**
 * The take-profit order: pick a stock you hold, set the gain you want and, if you like, a stop-loss below. One target
 * or a ladder of three, each its own order on BookTakestock (placed together with placeMany). Every step sells at its
 * price or better; with a stop, every step is a bracket that also sells if Chainlink's price falls to the stop.
 */
export function GainCard({ tokens, markets, feeBps, onPlaced }: { tokens: Token[]; markets: Markets; feeBps: number; onPlaced: () => void }) {
  const { address, isConnected, chainId } = useAccount();
  const openWallet = useOpenWallet();
  const { switchChain, isPending: switching } = useSwitchChain();

  const usdg = tokens.find((t) => t.symbol === "USDG");
  const stocks = useMemo(() => tokens.filter((t) => t.kind === "stock"), [tokens]);
  const [stock, setStock] = useState<Token | undefined>();
  const [amountStr, setAmountStr] = useState("");
  const [costStr, setCostStr] = useState("");
  const [gain, setGain] = useState(10);
  const [gainStr, setGainStr] = useState("");
  const [ladder, setLadder] = useState(false);
  const [stopPct, setStopPct] = useState(0);
  const [expiry, setExpiry] = useState(EXPIRIES[1].s);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setStock((cur) => (cur && stocks.find((t) => t.address === cur.address)) ?? stocks.find((t) => t.symbol === "NVDA") ?? stocks[0]);
  }, [stocks]);

  const market = stock ? markets.usd(stock.address) : undefined;
  const cost = Number(costStr);
  const hasCost = costStr !== "" && Number.isFinite(cost) && cost > 0;
  const base = hasCost ? cost : market;
  const customGain = Number(gainStr);
  const g = gainStr !== "" && Number.isFinite(customGain) && customGain > 0 ? customGain : gain;
  const amountIn = stock ? parseAmount(amountStr, stock.decimals) : undefined;
  const feed = feedFor(stock?.address);
  const withStop = stopPct > 0;

  const decimals = useReadContract({
    address: feed,
    abi: feedAbi,
    functionName: "decimals",
    chainId: CHAIN_ID,
    query: { enabled: withStop && !!feed },
  });
  const feedDecimals = decimals.data as number | undefined;
  // The stop triggers on Chainlink's price, so it is set from Chainlink's current answer, not the pool's.
  const round = useReadContract({
    address: feed,
    abi: feedAbi,
    functionName: "latestRoundData",
    chainId: CHAIN_ID,
    query: { enabled: withStop && !!feed, refetchInterval: 60_000 },
  });
  const answer = round.data ? (round.data as readonly [bigint, bigint, bigint, bigint, bigint])[1] : undefined;
  const chainlinkPx = answer !== undefined && answer > 0n && feedDecimals !== undefined ? Number(answer) / 10 ** feedDecimals : undefined;
  const stopPx = withStop && chainlinkPx !== undefined ? chainlinkPx * (1 - stopPct / 100) : undefined;

  // The plan: one target, or three that sell a third each at g, 2g and 3g above the base.
  const steps: Step[] = useMemo(() => {
    if (!amountIn || !usdg || !stock || base === undefined) return [];
    const n = ladder ? 3 : 1;
    const part = amountIn / BigInt(n);
    if (part === 0n) return [];
    return Array.from({ length: n }, (_, i) => {
      const amount = i === n - 1 ? amountIn - part * BigInt(n - 1) : part;
      const price = base * (1 + (g * (i + 1)) / 100);
      const minOut = minOutForSell(amount, stock.decimals, usdg.decimals, price);
      const stopValue = stopPx !== undefined ? minOutForSell(amount, stock.decimals, usdg.decimals, stopPx) : undefined;
      const stopMinOut = stopValue !== undefined ? (stopValue * BigInt(100 - STOP_SLIPPAGE)) / 100n : undefined;
      return { gain: g * (i + 1), price, amount, minOut, stopMinOut };
    });
  }, [amountIn, usdg, stock, base, ladder, g, stopPx]);

  const balance = useReadContract({
    address: stock?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!stock },
  });
  const allowance = useReadContract({
    address: stock?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && LIMIT_BOOK ? [address, LIMIT_BOOK] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!LIMIT_BOOK && !!stock },
  });
  const bal = balance.data as bigint | undefined;

  const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const [lastKind, setLastKind] = useState<"approve" | "place" | null>(null);
  useEffect(() => {
    if (!receipt.isSuccess) return;
    allowance.refetch();
    balance.refetch();
    if (lastKind === "place") {
      setAmountStr("");
      onPlaced();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess]);

  const busy = isPending || receipt.isLoading;
  const allowed = allowance.data as bigint | undefined;
  const needsApproval = !!amountIn && allowed !== undefined && allowed < amountIn;
  const first = steps[0];
  // A target at or under the market (plus the fees) sells almost at once.
  const margin = feeBps / 10_000 + 0.005;
  const immediate = first && market !== undefined && first.price <= market * (1 + margin);
  const ready =
    steps.length > 0 &&
    steps.every((s) => s.minOut > 0n) &&
    (!withStop || (!!feed && feedDecimals !== undefined && stopPx !== undefined && steps.every((s) => (s.stopMinOut ?? 0n) > 0n)));

  let cta = ladder ? "Place 3 take-profit orders" : "Place take-profit order";
  let action: (() => void) | null = null;
  if (!LIMIT_BOOK) cta = "Opening soon";
  else if (!isConnected) {
    cta = "Connect wallet";
    action = openWallet;
  } else if (chainId !== CHAIN_ID) {
    cta = switching ? "Switching…" : "Switch to Robinhood Chain";
    action = () => switchChain({ chainId: CHAIN_ID });
  } else if (!amountIn) cta = "Enter an amount";
  else if (base === undefined) cta = "Waiting for a price";
  else if (withStop && !feed) cta = `No Chainlink price for ${stock?.symbol ?? "this stock"} yet`;
  else if (bal !== undefined && bal < amountIn) cta = `Not enough ${stock?.symbol}`;
  else if (allowed === undefined) cta = "Checking your wallet…";
  else if (withStop && stopPx === undefined) cta = "Reading Chainlink’s price…";
  else if (needsApproval && stock) {
    cta = `Approve ${amountStr} ${stock.symbol}`;
    action = () => {
      setLastKind("approve");
      writeContract({ address: stock.address, abi: erc20Abi, functionName: "approve", args: [LIMIT_BOOK!, amountIn], chainId: CHAIN_ID });
    };
  } else if (ready && stock && usdg) {
    action = () => {
      setLastKind("place");
      const exp = BigInt(Math.floor(Date.now() / 1000) + expiry);
      const ps = steps.map((s) =>
        placeParams({
          tokenIn: stock.address,
          tokenOut: usdg.address,
          amountIn: s.amount,
          minAmountOut: s.minOut,
          expiry: exp,
          partialFill: false,
          ...(withStop
            ? {
                feed: feed!,
                stopPrice: feedPrice(stopPx!, feedDecimals!),
                stopBelow: true,
                feedPricesIn: true,
                stopMinOut: s.stopMinOut!,
                maxAge: STOP_MAX_AGE,
              }
            : {}),
        }),
      );
      if (ps.length === 1) writeContract({ address: LIMIT_BOOK!, abi: bookAbi, functionName: "place", args: [ps[0]], chainId: CHAIN_ID });
      else writeContract({ address: LIMIT_BOOK!, abi: bookAbi, functionName: "placeMany", args: [ps], chainId: CHAIN_ID });
    };
  }
  if (busy) cta = lastKind === "approve" ? "Approving…" : "Placing…";

  const sym = stock?.symbol ?? "stock";
  const totalOut = steps.reduce((s, x) => s + x.minOut, 0n);

  return (
    <div className="swap gain" id="trade">
      <div className="field">
        <div className="field-top">
          <span className="label">Stock to sell</span>
          <span className="small muted">
            Now <b className="mono">{usd(market)}</b>
          </span>
        </div>
        <div className="field-row">
          <button className="token-btn big" onClick={() => setPicking(true)}>
            <TokenDot token={stock} />
            {sym} <span className="asset-name">{stock?.name}</span> <span className="caret" aria-hidden="true">▼</span>
          </button>
        </div>
      </div>

      <div className="field">
        <div className="field-top">
          <span className="label">Amount</span>
          {bal !== undefined && bal > 0n && stock && (
            <button className="bal small" onClick={() => setAmountStr(trimNum(formatUnits(bal, stock.decimals)))}>
              You hold {fmt(bal, stock.decimals)} · Max
            </button>
          )}
        </div>
        <div className="field-row">
          <input
            className="amount mono"
            inputMode="decimal"
            placeholder={`Amount of ${sym}`}
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Amount to sell"
          />
          <span className="token-btn static">
            <TokenDot token={stock} />
            {sym}
          </span>
        </div>
      </div>

      <div className="field">
        <div className="field-top">
          <span className="label">Target gain</span>
          {base !== undefined && (
            <span className="small muted">
              from {hasCost ? "your price" : "today’s price"} <b className="mono">{usd(base)}</b>
            </span>
          )}
        </div>
        <div className="gain-row">
          <div className="chips">
            {GAINS.map((k) => (
              <button
                key={k}
                className={`chip${gainStr === "" && gain === k ? " on" : ""}`}
                onClick={() => {
                  setGain(k);
                  setGainStr("");
                }}
              >
                +{k}%
              </button>
            ))}
          </div>
          <label className="pct">
            <span>+</span>
            <input inputMode="decimal" placeholder="Own" value={gainStr} onChange={(e) => setGainStr(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Custom gain in percent" />
            <span>%</span>
          </label>
        </div>
        <label className="cost small">
          <span className="muted">Bought earlier? Count the gain from your price:</span>
          <span className="cost-in">
            $
            <input inputMode="decimal" placeholder={market ? priceStr(market) : "Your price"} value={costStr} onChange={(e) => setCostStr(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Your buy price in USD" />
          </span>
        </label>
      </div>

      <div className="opts">
        <div className="opt">
          <span className="label">Exit</span>
          <div className="seg">
            <button className={!ladder ? "on" : ""} onClick={() => setLadder(false)}>
              All at once
            </button>
            <button className={ladder ? "on" : ""} onClick={() => setLadder(true)}>
              In 3 steps
            </button>
          </div>
        </div>
        <div className="opt">
          <span className="label">Stop-loss</span>
          <div className="seg">
            {STOPS.map((s) => (
              <button key={s} className={stopPct === s ? "on" : ""} onClick={() => setStopPct(s)}>
                {s === 0 ? "Off" : `−${s}%`}
              </button>
            ))}
          </div>
        </div>
        <div className="opt">
          <span className="label">Good for</span>
          <div className="seg">
            {EXPIRIES.map((e) => (
              <button key={e.s} className={e.s === expiry ? "on" : ""} onClick={() => setExpiry(e.s)}>
                {e.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {steps.length > 0 && usdg && stock && (
        <div className="plan">
          <table>
            <thead>
              <tr>
                <th>Sells</th>
                <th>Target</th>
                <th>You get at least</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i}>
                  <td className="mono">
                    {fmt(s.amount, stock.decimals)} {sym}
                  </td>
                  <td className="mono">
                    {usd(s.price)} <span className="up">+{num(s.gain)}%</span>
                  </td>
                  <td className="mono">{fmt(s.minOut, usdg.decimals)} USDG</td>
                </tr>
              ))}
            </tbody>
            {steps.length > 1 && (
              <tfoot>
                <tr>
                  <td colSpan={2}>All steps</td>
                  <td className="mono">{fmt(totalOut, usdg.decimals)} USDG</td>
                </tr>
              </tfoot>
            )}
          </table>
          {withStop && stopPx !== undefined && (
            <p className="small stop-line">
              Stop-loss: if Chainlink’s {sym} price (now {usd(chainlinkPx)}) falls to <b className="mono">{usd(stopPx)}</b>,{" "}
              {steps.length > 1 ? "every step sells" : "it sells"} for at least {STOP_SLIPPAGE}% under that.
            </p>
          )}
          <p className="small muted">
            Each step sells once the pools pay its target plus the {num(feeBps / 100)}% fee, so you get at least the amount shown.
            Cancel any time before; after it expires your {sym} comes back to you.
          </p>
        </div>
      )}

      {immediate && <p className="warn-box small">This target is at or under today’s price, so it will sell almost right away.</p>}

      <button className="cta" disabled={!action || busy} onClick={action ?? undefined}>
        {cta}
      </button>

      {writeError && <p className="err small">{walletError(writeError)}</p>}
      {receipt.isSuccess && hash && (
        <p className="ok small">
          {lastKind === "approve" ? (
            <>
              {stock?.symbol} approved. <b>Now place the order.</b>{" "}
            </>
          ) : (
            <>{steps.length > 1 ? "Orders placed." : "Order placed."} It sells on its own when your target is reached. </>
          )}
          <a href={txUrl(hash)} target="_blank" rel="noopener">
            View transaction ↗
          </a>
        </p>
      )}
      {receipt.isError && <p className="err small">The transaction failed on-chain. Nothing was taken except gas.</p>}

      {picking && (
        <TokenPicker
          tokens={stocks}
          markets={markets}
          onClose={() => setPicking(false)}
          onPick={(t) => {
            setStock(t);
            setCostStr("");
            setPicking(false);
            reset();
          }}
        />
      )}
    </div>
  );
}

function trimNum(s: string): string {
  if (!s.includes(".")) return s;
  const [w, f] = s.split(".");
  const cut = f.slice(0, 8).replace(/0+$/, "");
  return cut ? `${w}.${cut}` : w;
}
