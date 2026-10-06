"use client";

import { useEffect, useState } from "react";
import { usePublicClient, useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { bookAbi, OrderStatus, orderKind, readOrdersOf, type LimitOrder } from "@splitroute/engine";
import { CHAIN_ID, LIMIT_BOOK, txUrl } from "@/lib/config";
import { fmt, usd } from "@/lib/format";
import type { Markets } from "@/lib/useMarkets";
import type { Token } from "@/lib/tokens";
import { TokenDot } from "./TokenDot";
import { walletError } from "./Wallet";

const REFRESH = 15_000;
const lower = (a: string) => a.toLowerCase();

/** Human view of an order: side, stock, amount, limit and stop prices in USD. */
export function describe(o: LimitOrder, tokens: Token[]) {
  const t = (a: string) => tokens.find((x) => lower(x.address) === lower(a));
  const tin = t(o.tokenIn), tout = t(o.tokenOut);
  const buy = tin?.symbol === "USDG";
  const stock = buy ? tout : tin;
  const usdg = buy ? tin : tout;
  const kind = orderKind(o);
  let price: number | undefined;
  if (stock && usdg && o.minAmountOut > 0n) {
    const usdAmt = Number(buy ? o.amountIn : o.minAmountOut) / 10 ** usdg.decimals;
    const shares = Number(buy ? o.minAmountOut : o.amountIn) / 10 ** stock.decimals;
    price = shares > 0 ? usdAmt / shares : undefined;
  }
  // Robinhood Stock Token feeds answer with 8 decimals.
  const stop = kind === "limit" ? undefined : Number(o.stopPrice) / 1e8;
  const done = o.amountIn > 0n ? Number(o.amountIn - o.remaining) / Number(o.amountIn) : 0;
  return { buy, stock, tin, tout, price, stop, kind, done };
}

const KIND_LABEL = { limit: "", stop: "Stop", bracket: "Bracket" } as const;

export function MyOrders({ tokens, markets, refreshKey }: { tokens: Token[]; markets: Markets; refreshKey: number }) {
  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;
  const { address } = useAccount();
  const [orders, setOrders] = useState<LimitOrder[] | null>(null);
  const [tick, setTick] = useState(0);
  const { writeContract, data: hash, isPending, error, variables } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!client || !address || !LIMIT_BOOK) return;
    let dead = false;
    const run = () =>
      readOrdersOf(client, LIMIT_BOOK!, address)
        .then((o) => !dead && setOrders(o))
        .catch(() => {});
    run();
    const t = setInterval(() => document.visibilityState === "visible" && run(), REFRESH);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [client, address, refreshKey, tick]);
  useEffect(() => {
    if (receipt.isSuccess) setTick((x) => x + 1);
  }, [receipt.isSuccess]);

  if (!LIMIT_BOOK) return null;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const cancelling = (id: bigint) => (isPending || receipt.isLoading) && (variables?.args?.[0] as bigint | undefined) === id;

  return (
    <section id="orders" className="section wrap">
      <div className="section-head">
        <h2>
          Your orders
        </h2>
        <p>Open orders fill on their own, in parts if you allowed it. Cancel any time and whatever is left comes straight back to your wallet.</p>
      </div>
      {!address ? (
        <p className="muted">Connect your wallet to see your orders.</p>
      ) : orders === null ? (
        <p className="muted">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="muted">No orders yet. Set a price above and it will show up here.</p>
      ) : (
        <div className="markets-wrap">
          <table className="markets orders">
            <thead>
              <tr>
                <th>Order</th>
                <th className="num">Amount</th>
                <th className="num">Limit</th>
                <th className="num hide-m">Stop</th>
                <th className="num hide-m">Market</th>
                <th className="num hide-m">Expires</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const d = describe(o, tokens);
                const expired = o.status === OrderStatus.Open && o.expiry < now;
                const partly = o.status === OrderStatus.Open && o.remaining < o.amountIn;
                const status = expired ? "Expired" : partly ? "Partly filled" : ["—", "Open", "Filled", "Cancelled"][o.status];
                const market = d.stock ? markets.usd(d.stock.address) : undefined;
                const ref = d.price ?? d.stop;
                const gap = market && ref ? (ref / market - 1) * 100 : undefined;
                return (
                  <tr key={String(o.id)} className="static">
                    <td>
                      <div className="asset">
                        <TokenDot token={d.stock} />
                        <b>
                          <span className={d.buy ? "side-buy" : "side-sell"}>{d.buy ? "Buy" : "Sell"}</span> {d.stock?.symbol ?? "?"}
                          {d.kind !== "limit" && <span className={`kind-tag ${d.kind}`}>{KIND_LABEL[d.kind]}</span>}
                        </b>
                        <span className="asset-name mono">#{String(o.id + 1n)}</span>
                      </div>
                    </td>
                    <td className="num mono">
                      {fmt(o.amountIn, d.tin?.decimals)} {d.tin?.symbol}
                      {d.done > 0 && d.done < 1 && (
                        <span className="progress" title={`${Math.round(d.done * 100)}% filled`}>
                          <i style={{ width: `${Math.round(d.done * 100)}%` }} />
                        </span>
                      )}
                    </td>
                    <td className="num mono">{d.price !== undefined ? usd(d.price) : "—"}</td>
                    <td className="num mono hide-m">
                      {d.stop !== undefined ? usd(d.stop) : "—"}
                      {o.triggered && o.status === OrderStatus.Open && <span className="muted small"> triggered</span>}
                    </td>
                    <td className="num mono hide-m">
                      {usd(market)}
                      {o.status === OrderStatus.Open && !expired && gap !== undefined && (
                        <span className="muted small"> ({gap >= 0 ? "+" : ""}{gap.toFixed(1)}%)</span>
                      )}
                    </td>
                    <td className="num hide-m small muted">{o.status === OrderStatus.Open ? timeLeft(o.expiry - now) : "—"}</td>
                    <td>
                      <span className={`status s-${status.toLowerCase().replace(/ /g, "-")}`}>{status}</span>
                    </td>
                    <td className="num">
                      {o.status === OrderStatus.Open && (
                        <button
                          className="trade-pill"
                          disabled={cancelling(o.id)}
                          onClick={() =>
                            writeContract({ address: LIMIT_BOOK!, abi: bookAbi, functionName: "cancel", args: [o.id], chainId: CHAIN_ID })
                          }
                        >
                          {cancelling(o.id) ? "…" : expired ? "Reclaim" : "Cancel"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="err small">{walletError(error)}</p>}
      {receipt.isSuccess && hash && (
        <p className="ok small">
          Cancelled, the rest of the deposit is back in your wallet.{" "}
          <a href={txUrl(hash)} target="_blank" rel="noopener">
            View transaction ↗
          </a>
        </p>
      )}
    </section>
  );
}

function timeLeft(s: bigint): string {
  const n = Number(s);
  if (n <= 0) return "expired";
  if (n < 3600) return `${Math.ceil(n / 60)}m`;
  if (n < 86_400) return `${Math.floor(n / 3600)}h`;
  return `${Math.floor(n / 86_400)}d ${Math.floor((n % 86_400) / 3600)}h`;
}
