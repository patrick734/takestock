"use client";

import { BRAND } from "@/lib/brand";
import { BURN, LIMIT_BOOK, QUOTER, ROUTER, addressUrl } from "@/lib/config";
import { CopyCA } from "./CopyCA";

const feeTxt = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export type Fees = { filler: number; protocol: number };

export function HowItWorks({ fees }: { fees: Fees }) {
  const steps = [
    { n: "1", t: "Pick a stock and a target", d: "Choose a Stock Token you hold, how much to sell and the gain you want: +10%, +25%, or your own price. Add a stop-loss below if you like, or split the sale across up to three targets." },
    { n: "2", t: "Your tokens wait in the contract", d: "They sit in BookTakestock under your order, and only there. A keeper checks every Uniswap v3 and v4 pool on Robinhood Chain every few seconds, and Chainlink’s price for stops." },
    { n: "3", t: "It sells the moment you’re in profit", d: `When the pools pay your target, the order fills in one transaction through RouterTakestock, split across the pools that pay most. ${feeTxt(fees.filler + fees.protocol)} comes off the proceeds, only on fills. Cancel any time before.` },
  ];
  return (
    <section id="how" className="section wrap">
      <div className="section-head">
        <h2>Set the gain. Walk away.</h2>
        <p>Stock Tokens trade on Robinhood Chain around the clock. Your exit doesn’t need you watching.</p>
      </div>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.n}>
            <span className="step-n">{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Contracts({ fees }: { fees: Fees }) {
  const rows: [string, string | undefined][] = [
    ["BookTakestock (orders)", LIMIT_BOOK],
    ["RouterTakestock", ROUTER],
    ["QuoterTakestock", QUOTER],
    ["BuyBurnTakestock", BURN.buyBurn],
    ["SwapAdapterTakestock", BURN.swapAdapter],
    ["TimelockTakestock (48h)", BURN.timelock],
  ];
  const props: [string, string][] = [
    ["Your price", "Enforced on-chain. The contract refuses any fill that pays you less than your target after fees, part by part."],
    ["Stops", "Triggered by Chainlink’s price, not one pool or anyone’s say-so, and only on an answer fresh enough for your order. Your slippage floor still applies after the trigger."],
    ["No admin keys", "The order book, router and quoter have no owner, no admin, no pause and no upgrade path. Nobody can change a price source, a router or a fee under your order."],
    ["Custody", "Your tokens sit in the contract under your order. They can only leave to you (cancel, refund) or into your fill, and the proceeds go straight to your wallet."],
    ["Fees", `${feeTxt(fees.filler)} to whoever fills the order and ${feeTxt(fees.protocol)} to BuyBurnTakestock, which can only buy $${BRAND.token.symbol} and burn it. Only on fills, fixed forever at deployment.`],
    ["Cancel", "Any time, by you. After expiry anyone can trigger the refund, and it still only goes to you."],
  ];
  return (
    <section id="contracts" className="section wrap">
      <div className="section-head">
        <h2>Your exit, in code.</h2>
        <p>Every Takestock contract carries the Takestock name and is verified. Read them, don’t trust them.</p>
      </div>
      <div className="twocol">
        <div className="panel">
          <dl className="kv">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">
                  {v ? (
                    <a href={addressUrl(v)} target="_blank" rel="noopener">
                      {v.slice(0, 8)}…{v.slice(-6)}
                    </a>
                  ) : (
                    <span className="muted">Not deployed yet</span>
                  )}
                </dd>
              </div>
            ))}
            <div>
              <dt>Venues</dt>
              <dd>Uniswap v3 and v4 on Robinhood Chain</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>Robinhood Chain · 4663</dd>
            </div>
          </dl>
        </div>
        <div className="panel">
          <dl className="kv">
            {props.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <p className="disclose">
        The contracts have not been independently audited. They are tested against real Uniswap v3 and v4 code (fills,
        splits, partial fills, stops, ladders, native ETH, cancels, expiry, fee limits). An order is not
        a guarantee of a fill: the price has to reach yours in the pools and stay there long enough for the keeper’s
        transaction to land, and pools on Robinhood Chain are thin next to a large exchange. Stops follow Chainlink, which
        pauses outside US market hours; a price can gap past a stop’s floor, and then the order waits. Nothing here is
        investment advice.
      </p>
    </section>
  );
}

export function TokenSection() {
  const { symbol, address } = BRAND.token;
  return (
    <section id="token" className="section wrap">
      <div className="section-head">
        <h2>${symbol}</h2>
        <p>
          The {BRAND.name} token. Every filled order pays a protocol fee into BuyBurnTakestock, which buys ${symbol} on its Pons
          pool and burns it. More orders filled, more ${symbol} burned. It is separate from your orders: placing, cancelling and
          filling never touch it.
        </p>
      </div>
      <div className="twocol">
        <div className="token-card">
          <span className="label">Contract address</span>
          <h3>${symbol}</h3>
          <CopyCA variant="dark" />
          <div className="bars" aria-hidden="true">
            {[14, 20, 26, 32, 44].map((h, i) => (
              <i key={i} style={{ height: h }} />
            ))}
          </div>
        </div>
        <div className="panel">
          <dl className="kv">
            <div>
              <dt>Ticker</dt>
              <dd className="mono">${symbol}</dd>
            </div>
            <div>
              <dt>Chain</dt>
              <dd>Robinhood Chain</dd>
            </div>
            <div>
              <dt>Official address</dt>
              <dd className="mono">{address || "Not launched"}</dd>
            </div>
            <div>
              <dt>Buy and burn</dt>
              <dd>
                {BURN.buyBurn ? (
                  <a href={addressUrl(BURN.buyBurn)} target="_blank" rel="noopener">
                    BuyBurnTakestock ↗
                  </a>
                ) : (
                  "Not deployed yet"
                )}
                . It has no withdrawal function.
              </dd>
            </div>
            <div>
              <dt>Heads up</dt>
              <dd>Copycat tokens appear within minutes of any launch. Only the address on this page is ours. If it isn’t here, it isn’t us.</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}


export function FAQ({ fees }: { fees: Fees }) {
  const qa: [string, string][] = [
    ["What is a take-profit order?", "An order to sell a stock once it reaches a price you choose. It waits until the market pays that price, then sells. If it never does, you get your tokens back."],
    ["How do I set a gain?", "Pick a stock and a target such as +10%. Takestock turns it into a price from the current market and sells at that price or better. You can type your own price instead."],
    ["What is a ladder?", "Selling in steps: for example a third at +10%, a third at +20% and the rest at +30%. Takestock places each step as its own order, in one transaction. Each one fills, or is refunded, on its own."],
    ["How does the stop-loss work?", "You set a stop price and a slippage floor. When Chainlink’s price for the stock reaches your stop, the order can fill and stays fillable, for at least your floor. If the price gaps past the floor, the order waits rather than selling cheap. With a ladder, every step carries the same stop."],
    ["Is my price guaranteed?", "Your minimum is. The contract checks every fill and refuses any that would pay you less after fees. You can get more than your target, never less."],
    ["Is a fill guaranteed?", "No. The pools have to reach your price and stay there long enough for the fill to land. A price that only touches your level for a moment may not fill."],
    ["Can anyone change the rules under my order?", "No. The order book has no owner and no admin. The price source for stops is fixed in your order, the router is fixed in the contract and the fees are fixed forever."],
    ["What does it cost?", `${feeTxt(fees.filler + fees.protocol)} of what you receive, only if the order fills: ${feeTxt(fees.filler)} to the filler and ${feeTxt(fees.protocol)} to buy and burn $${BRAND.token.symbol}. Placing and cancelling cost only gas.`],
    ["Can I cancel?", "Any time, from My orders. Your tokens go straight back to your wallet. After expiry, anyone can trigger the refund, and it still only goes to you."],
    ["Which stocks?", "Official Robinhood Stock Tokens with a live pool on Robinhood Chain, priced in USDG. You can also place limit buys and stop buys from Advanced."],
  ];
  return (
    <section id="faq" className="section wrap">
      <div className="section-head">
        <h2>Questions</h2>
        <p>Short answers. The contract is the long one.</p>
      </div>
      <div className="faq">
        {qa.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <p className="foot-big">{BRAND.name}</p>
        <div className="foot-row">
          <span>{BRAND.tagline}</span>
          <span className="foot-links">
            {BRAND.x && (
              <a href={BRAND.x} target="_blank" rel="noopener">
                X
              </a>
            )}
            <a href="/#markets">Markets</a>
            <a href="/#contracts">Contracts</a>
          </span>
        </div>
      </div>
    </footer>
  );
}
