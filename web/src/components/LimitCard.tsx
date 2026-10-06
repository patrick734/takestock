"use client";

import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { bookAbi, erc20Abi, minOutForBuy, minOutForSell, placeParams, feedPrice } from "@splitroute/engine";
import { CHAIN_ID, LIMIT_BOOK, txUrl } from "@/lib/config";
import { feedAbi, feedFor, STOP_MAX_AGE } from "@/lib/feeds";
import { fmt, num, parseAmount, usd } from "@/lib/format";
import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { TokenPicker } from "./TokenPicker";
import { TokenDot } from "./TokenDot";
import { useOpenWallet, walletError } from "./Wallet";

export type Side = "buy" | "sell";
export type Kind = "limit" | "stop" | "bracket";
export type Preset = { stock?: Token; side?: Side; kind?: Kind; nonce: number };

const EXPIRIES = [
  { label: "1 day", s: 86_400 },
  { label: "7 days", s: 7 * 86_400 },
  { label: "30 days", s: 30 * 86_400 },
];
const STEPS = [1, 3, 5, 10];
const STOP_STEPS = [3, 5, 10, 15];
const SLIPS = [1, 2, 5, 10];

const KINDS: Record<Side, { k: Kind; label: string }[]> = {
  buy: [
    { k: "limit", label: "Limit" },
    { k: "stop", label: "Stop" },
  ],
  sell: [
    { k: "limit", label: "Take profit" },
    { k: "stop", label: "Stop-loss" },
    { k: "bracket", label: "Bracket" },
  ],
};

/**
 * Place an order on BookTakestock:
 * - Limit / take profit: buy at or below a price, or sell at or above one.
 * - Stop: sell when Chainlink's price falls to a level (stop-loss), or buy when it rises to one (breakout),
 *   with a slippage floor.
 * - Bracket (sell): take profit at one price OR stop the loss at another, whichever comes first.
 */
export function LimitCard({
  tokens,
  markets,
  preset,
  feeBps,
  onPlaced,
}: {
  tokens: Token[];
  markets: Markets;
  preset?: Preset;
  feeBps: number;
  onPlaced: () => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const openWallet = useOpenWallet();
  const { switchChain, isPending: switching } = useSwitchChain();

  const usdg = tokens.find((t) => t.symbol === "USDG");
  const stocks = useMemo(() => tokens.filter((t) => t.kind === "stock"), [tokens]);
  const [side, setSide] = useState<Side>("buy");
  const [kind, setKind] = useState<Kind>("limit");
  const [stock, setStock] = useState<Token | undefined>();
  const [amountStr, setAmountStr] = useState("");
  const [limitStr, setLimitStr] = useState("");
  const [stopStr, setStopStr] = useState("");
  const [slip, setSlip] = useState(2);
  const [partial, setPartial] = useState(false);
  const [touched, setTouched] = useState(false); // the user typed a price: stop auto-filling it
  const [stopTouched, setStopTouched] = useState(false);
  const [expiry, setExpiry] = useState(EXPIRIES[1].s);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setStock((cur) => (cur && stocks.find((t) => t.address === cur.address)) ?? stocks.find((t) => t.symbol === "NVDA") ?? stocks[0]);
  }, [stocks]);
  useEffect(() => {
    if (!preset) return;
    if (preset.stock) setStock(preset.stock);
    if (preset.side) setSide(preset.side);
    if (preset.kind) setKind(preset.kind);
    setTouched(false);
    setStopTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  const feed = feedFor(stock?.address);
  const hasLimit = kind === "limit" || kind === "bracket";
  const hasStop = kind === "stop" || kind === "bracket";
  const market = stock ? markets.usd(stock.address) : undefined;

  // Suggest prices until the user sets their own: limit 3% better than the market, stop 5% the other way.
  useEffect(() => {
    if (touched || market === undefined) return;
    setLimitStr(priceStr(market * (side === "buy" ? 0.97 : 1.03)));
  }, [market, side, touched, stock?.address]);
  useEffect(() => {
    if (stopTouched || market === undefined) return;
    setStopStr(priceStr(market * (side === "sell" ? 0.95 : 1.05)));
  }, [market, side, stopTouched, stock?.address]);

  const tokenIn = side === "buy" ? usdg : stock;
  const tokenOut = side === "buy" ? stock : usdg;
  const amountIn = tokenIn ? parseAmount(amountStr, tokenIn.decimals) : undefined;
  const limit = Number(limitStr);
  const stopPx = Number(stopStr);
  const validLimit = Number.isFinite(limit) && limit > 0;
  const validStop = Number.isFinite(stopPx) && stopPx > 0;

  const outAt = (price: number) =>
    amountIn && usdg && stock
      ? side === "buy"
        ? minOutForBuy(amountIn, usdg.decimals, stock.decimals, price)
        : minOutForSell(amountIn, stock.decimals, usdg.decimals, price)
      : undefined;
  const minOut = hasLimit && validLimit ? outAt(limit) : undefined;
  // Stop floor: what the stop price is worth, less the slippage the maker accepts.
  const stopValue = hasStop && validStop ? outAt(stopPx) : undefined;
  const stopMinOut = stopValue !== undefined ? (stopValue * BigInt(10_000 - slip * 100)) / 10_000n : undefined;

  const distance = market && validLimit ? limit / market - 1 : undefined;
  const stopDistance = market && validStop ? stopPx / market - 1 : undefined;
  const margin = feeBps / 10_000 + 0.005;
  const immediate = hasLimit && distance !== undefined && (side === "buy" ? distance >= margin : distance <= -margin);
  // A stop on the wrong side of the market triggers at once.
  const stopNow = hasStop && stopDistance !== undefined && (side === "sell" ? stopDistance >= 0 : stopDistance <= 0);
  const bracketCrossed = kind === "bracket" && validLimit && validStop && stopPx >= limit;

  const decimals = useReadContract({
    address: feed,
    abi: feedAbi,
    functionName: "decimals",
    chainId: CHAIN_ID,
    query: { enabled: hasStop && !!feed },
  });
  const feedDecimals = decimals.data as number | undefined;

  const balance = useReadContract({
    address: tokenIn?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!tokenIn },
  });
  const allowance = useReadContract({
    address: tokenIn?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && LIMIT_BOOK ? [address, LIMIT_BOOK] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!LIMIT_BOOK && !!tokenIn },
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
  const needsApproval = !!amountIn && (allowance.data as bigint | undefined) !== undefined && (allowance.data as bigint) < amountIn;
  const ready =
    !!tokenIn &&
    !!tokenOut &&
    !!amountIn &&
    (!hasLimit || (minOut !== undefined && minOut > 0n)) &&
    (!hasStop || (!!feed && feedDecimals !== undefined && stopMinOut !== undefined && stopMinOut > 0n)) &&
    !bracketCrossed;

  const label = KINDS[side].find((x) => x.k === kind)?.label ?? "Limit";
  let cta = kind === "limit" ? (side === "buy" ? "Place limit order" : "Place take-profit order") : `Place ${label.toLowerCase()} order`;
  let action: (() => void) | null = null;
  if (!LIMIT_BOOK) cta = "Opening soon";
  else if (!isConnected) {
    cta = "Connect wallet";
    action = openWallet;
  } else if (chainId !== CHAIN_ID) {
    cta = switching ? "Switching…" : "Switch to Robinhood Chain";
    action = () => switchChain({ chainId: CHAIN_ID });
  } else if (hasStop && !feed) cta = `No Chainlink price for ${stock?.symbol ?? "this stock"} yet`;
  else if (!amountIn) cta = "Enter an amount";
  else if (hasLimit && !validLimit) cta = "Set your price";
  else if (hasStop && !validStop) cta = "Set your stop price";
  else if (bracketCrossed) cta = "Stop must be below the take-profit price";
  else if (bal !== undefined && bal < amountIn) cta = `Not enough ${tokenIn?.symbol}`;
  else if (needsApproval && tokenIn) {
    cta = `Approve ${amountStr} ${tokenIn.symbol}`;
    action = () => {
      setLastKind("approve");
      writeContract({ address: tokenIn.address, abi: erc20Abi, functionName: "approve", args: [LIMIT_BOOK!, amountIn], chainId: CHAIN_ID });
    };
  } else if (ready) {
    action = () => {
      setLastKind("place");
      const p = placeParams({
        tokenIn: tokenIn!.address,
        tokenOut: tokenOut!.address,
        amountIn: amountIn!,
        minAmountOut: hasLimit ? minOut! : 0n,
        expiry: BigInt(Math.floor(Date.now() / 1000) + expiry),
        partialFill: partial,
        ...(hasStop
          ? {
              feed: feed!,
              stopPrice: feedPrice(stopPx, feedDecimals!),
              stopBelow: side === "sell",
              feedPricesIn: side === "sell",
              stopMinOut: stopMinOut!,
              maxAge: STOP_MAX_AGE,
            }
          : {}),
      });
      writeContract({ address: LIMIT_BOOK!, abi: bookAbi, functionName: "place", args: [p], chainId: CHAIN_ID });
    };
  }
  if (busy) cta = lastKind === "approve" ? "Approving…" : "Placing…";

  const sym = stock?.symbol ?? "stock";
  const chip = (k: number) => {
    if (market === undefined) return;
    setTouched(true);
    setLimitStr(priceStr(market * (1 + k / 100)));
  };
  const stopChip = (k: number) => {
    if (market === undefined) return;
    setStopTouched(true);
    setStopStr(priceStr(market * (1 + k / 100)));
  };
  const switchSide = (s: Side) => {
    setSide(s);
    if (!KINDS[s].some((x) => x.k === kind)) setKind("limit");
    setAmountStr("");
    setTouched(false);
    setStopTouched(false);
    reset();
  };

  return (
    <div className="swap limit" id="trade">
      <div className="swap-head">
        <div className="swap-tabs">
          <b>New order</b>
          <span className="label">{kind === "limit" ? "your price or better" : kind === "stop" ? "on Chainlink's price" : "profit or stop, first wins"}</span>
        </div>
        <div className="side-toggle" role="tablist">
          {(["buy", "sell"] as Side[]).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} className={side === s ? `on ${s}` : ""} onClick={() => switchSide(s)}>
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      </div>

      <div className="seg kinds" role="tablist" aria-label="Order type">
        {KINDS[side].map((x) => (
          <button
            key={x.k}
            role="tab"
            aria-selected={kind === x.k}
            className={kind === x.k ? "on" : ""}
            onClick={() => {
              setKind(x.k);
              reset();
            }}
          >
            {x.label}
          </button>
        ))}
      </div>

      <div className="field">
        <div className="field-top">
          <span className="label">{side === "buy" ? "Stock to buy" : "Stock to sell"}</span>
          <span className="small muted">
            Market <b className="mono">{usd(market)}</b>
          </span>
        </div>
        <div className="field-row">
          <button className="token-btn big" onClick={() => setPicking(true)}>
            <TokenDot token={stock} />
            {sym} <span className="asset-name">{stock?.name}</span> <span className="caret" aria-hidden="true">▼</span>
          </button>
        </div>
      </div>

      {hasLimit && (
        <div className="field">
          <div className="field-top">
            <span className="label">
              {side === "buy" ? `Buy when ${sym} is at or below` : kind === "bracket" ? `Take profit at or above` : `Sell when ${sym} is at or above`}
            </span>
            {distance !== undefined && (
              <span className={`small mono ${immediate ? "warn-text" : "muted"}`}>
                {distance >= 0 ? "+" : ""}
                {(distance * 100).toFixed(2)}% vs market
              </span>
            )}
          </div>
          <div className="field-row">
            <span className="amount mono dollar">$</span>
            <input
              className="amount mono"
              inputMode="decimal"
              placeholder={market ? priceStr(market) : "Price"}
              value={limitStr}
              onChange={(e) => {
                setTouched(true);
                setLimitStr(e.target.value.replace(/[^0-9.]/g, ""));
              }}
              aria-label="Limit price in USD"
            />
          </div>
          <div className="chips">
            <button className="chip" onClick={() => chip(0)}>
              Market
            </button>
            {STEPS.map((k) => (
              <button key={k} className="chip" onClick={() => chip(side === "buy" ? -k : k)}>
                {side === "buy" ? "−" : "+"}
                {k}%
              </button>
            ))}
          </div>
        </div>
      )}

      {hasStop && (
        <div className="field">
          <div className="field-top">
            <span className="label">{side === "sell" ? `Stop: sell if ${sym} falls to` : `Stop: buy if ${sym} rises to`}</span>
            {stopDistance !== undefined && (
              <span className={`small mono ${stopNow ? "warn-text" : "muted"}`}>
                {stopDistance >= 0 ? "+" : ""}
                {(stopDistance * 100).toFixed(2)}% vs market
              </span>
            )}
          </div>
          <div className="field-row">
            <span className="amount mono dollar">$</span>
            <input
              className="amount mono"
              inputMode="decimal"
              placeholder={market ? priceStr(market) : "Stop price"}
              value={stopStr}
              onChange={(e) => {
                setStopTouched(true);
                setStopStr(e.target.value.replace(/[^0-9.]/g, ""));
              }}
              aria-label="Stop price in USD"
            />
          </div>
          <div className="chips">
            {STOP_STEPS.map((k) => (
              <button key={k} className="chip" onClick={() => stopChip(side === "sell" ? -k : k)}>
                {side === "sell" ? "−" : "+"}
                {k}%
              </button>
            ))}
          </div>
          <div className="expiry slip">
            <span className="label">Max slippage after the stop</span>
            <div className="seg">
              {SLIPS.map((s) => (
                <button key={s} className={s === slip ? "on" : ""} onClick={() => setSlip(s)}>
                  {s}%
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="field">
        <div className="field-top">
          <span className="label">{side === "buy" ? "Spend" : "Sell amount"}</span>
          {bal !== undefined && bal > 0n && tokenIn && (
            <button className="bal small" onClick={() => setAmountStr(trimNum(formatUnits(bal, tokenIn.decimals)))}>
              Balance {fmt(bal, tokenIn.decimals)} · Max
            </button>
          )}
        </div>
        <div className="field-row">
          <input
            className="amount mono"
            inputMode="decimal"
            placeholder={side === "buy" ? "Amount in USDG" : `Amount of ${sym}`}
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Amount"
          />
          <span className="token-btn static">
            <TokenDot token={tokenIn} />
            {tokenIn?.symbol}
          </span>
        </div>
      </div>

      <div className="expiry">
        <span className="label">Expires in</span>
        <div className="seg">
          {EXPIRIES.map((e) => (
            <button key={e.s} className={e.s === expiry ? "on" : ""} onClick={() => setExpiry(e.s)}>
              {e.label}
            </button>
          ))}
        </div>
      </div>

      <label className="check small">
        <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
        <span>
          Allow partial fills <span className="muted">(fills large orders in parts when the pools are thin, each part at your price or better)</span>
        </span>
      </label>

      {tokenOut && (minOut !== undefined || stopMinOut !== undefined) && (
        <dl className="facts">
          {minOut !== undefined && (
            <div>
              <dt>{kind === "bracket" ? "Take profit: you get at least" : "You get at least"}</dt>
              <dd className="mono">
                {fmt(minOut, tokenOut.decimals)} {tokenOut.symbol}
              </dd>
            </div>
          )}
          {minOut !== undefined && (
            <div>
              <dt>Fills when</dt>
              <dd>
                {sym} {side === "buy" ? "≤" : "≥"} <span className="mono">{usd(limit)}</span>
              </dd>
            </div>
          )}
          {stopMinOut !== undefined && (
            <div>
              <dt>Stop triggers when</dt>
              <dd>
                Chainlink {sym} {side === "sell" ? "≤" : "≥"} <span className="mono">{usd(stopPx)}</span>
              </dd>
            </div>
          )}
          {stopMinOut !== undefined && (
            <div>
              <dt>At the stop price, at least</dt>
              <dd className="mono">
                {fmt(stopMinOut, tokenOut.decimals)} {tokenOut.symbol}
              </dd>
            </div>
          )}
          <div>
            <dt>Fee</dt>
            <dd>{num(feeBps / 100)}%, only if it fills. Your minimum already allows for it.</dd>
          </div>
          <div>
            <dt>If it doesn’t fill</dt>
            <dd>Cancel anytime. After expiry the deposit is sent back to you.</dd>
          </div>
        </dl>
      )}

      {hasStop && (
        <p className="small muted note">
          The stop uses Chainlink’s price, not a single pool, so one thin trade can’t set it off. Once triggered, it fills at
          Chainlink’s current price less at most your slippage. While Chainlink has no fresh price (markets closed), it won’t
          fill below your stop price less the slippage.
        </p>
      )}
      {immediate && (
        <p className="warn-box small">
          This price is already {side === "buy" ? "at or above" : "at or below"} the market, so the order will fill almost right
          away.
        </p>
      )}
      {stopNow && (
        <p className="warn-box small">This stop is already {side === "sell" ? "above" : "below"} the market, so it triggers right away.</p>
      )}

      <button className="cta" disabled={!action || busy} onClick={action ?? undefined}>
        {cta}
      </button>

      {writeError && <p className="err small">{walletError(writeError)}</p>}
      {receipt.isSuccess && hash && (
        <p className="ok small">
          {lastKind === "approve" ? (
            <>
              {tokenIn?.symbol} approved. <b>Now place the order.</b>{" "}
            </>
          ) : (
            <>Order placed. It fills on its own when its price is reached. </>
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
            setTouched(false);
            setStopTouched(false);
            setPicking(false);
            reset();
          }}
        />
      )}
    </div>
  );
}

/** Price to a sensible number of decimals: $180.43, $0.8421. */
export function priceStr(p: number): string {
  return p >= 1 ? p.toFixed(2) : p.toPrecision(4);
}

function trimNum(s: string): string {
  if (!s.includes(".")) return s;
  const [w, f] = s.split(".");
  const cut = f.slice(0, 8).replace(/0+$/, "");
  return cut ? `${w}.${cut}` : w;
}
