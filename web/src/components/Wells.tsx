"use client";

import { useState } from "react";
import { formatUnits, maxUint256, type Address } from "viem";
import { useAccount } from "wagmi";
import { creditDeskAbi, wellAbi } from "@/generated/wellsAbi";
import { CREDIT_LINES, USDG_ADDRESS, WELLS, addressUrl, txUrl, type Well } from "@/lib/config";
import { num, parseAmount, usd } from "@/lib/format";
import { BRAND } from "@/lib/brand";
import { useTx } from "@/lib/tx";
import { SHARE_DECIMALS, useCreditLine, useWellAccount, useWells, type WellState } from "@/lib/wells";
import type { Token } from "@/lib/tokens";
import { TokenDot } from "./TokenDot";
import { useOpenWallet } from "./Wallet";

const usdgNum = (v: bigint | undefined) => (v === undefined ? undefined : Number(formatUnits(v, 6)));
const money = (v: bigint | undefined) => usd(usdgNum(v));
const wholeMoney = (v: bigint | undefined) => money(v).replace(/\.\d\d$/, "");
const stockToken = (w: Well): Token => ({ address: w.stock, symbol: w.ticker, name: w.name, decimals: 18, kind: "stock" });
const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

type Tx = ReturnType<typeof useTx>;

function TxLine({ tx }: { tx: Tx }) {
  if (tx.error) return <p className="err small">{tx.error}</p>;
  if (!tx.message) return null;
  return (
    <p className={tx.busy ? "small muted" : "ok small"}>
      {tx.message}{" "}
      {tx.hash && (
        <a href={txUrl(tx.hash)} target="_blank" rel="noopener">
          View ↗
        </a>
      )}
    </p>
  );
}

/* ------------------------------------------------------------------ Well list */

export function WellList({ wells, selected, onPick }: { wells: WellState[]; selected?: string; onPick: (ticker: string) => void }) {
  return (
    <div className="wells">
      {wells.map((w) => {
        const fill = w.value !== undefined && w.cap > 0n ? Math.min(100, Number((w.value * 1000n) / w.cap) / 10) : 0;
        const depositors = 10_000 - w.protocolShareBps;
        return (
          <button key={w.vault} className={`well${selected === w.ticker ? " on" : ""}`} onClick={() => onPick(w.ticker)}>
            <span className="well-top">
              <TokenDot token={stockToken(w)} />
              <span className="well-name">
                <b>{w.ticker}</b>
                <span className="muted small">{w.name}</span>
              </span>
              <span className={`well-state ${!w.fresh ? "closed" : w.placed && w.inRange !== false ? "live" : ""}`}>
                <i />
                {!w.fresh ? "Market closed" : !w.placed ? (w.value && w.value > 0n ? "Being placed" : "Ready for deposits") : w.inRange === false ? "Re-centring" : "Earning fees"}
              </span>
            </span>
            <span className="well-figs">
              <span>
                <em>Chainlink price</em>
                <b className="mono">{w.price !== undefined ? money(w.price) : "—"}</b>
              </span>
              <span>
                <em>Deposited</em>
                <b className="mono">{w.value && w.value > 0n ? wholeMoney(w.value) : "Open"}</b>
              </span>
              <span>
                <em>Fees to depositors</em>
                <b className="mono">{(depositors / 100).toFixed(0)}%</b>
              </span>
            </span>
            {fill > 0 && (
              <span className="cap" title={`${fill.toFixed(1)}% of the ${wholeMoney(w.cap)} cap`}>
                <i style={{ width: `${Math.max(fill, 1.5)}%` }} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The Wells on the home page: a way to earn on USDG (or stock you sold) between orders. */
export function WellsTeaser() {
  const { data: wells } = useWells();
  if (!WELLS.length) return null;
  return (
    <section id="wells" className="section wrap">
      <div className="section-head">
        <h2>Earn while you wait.</h2>
        <p>
          Put USDG in a Well and it earns the trading fees of one Stock Token’s pool, compounding. Borrow USDG against your Well
          shares on the credit line. <a href="/wells/">Open the Wells →</a>
        </p>
      </div>
      {wells ? (
        <WellList wells={wells} onPick={(t) => (window.location.href = `/wells/#${t.toLowerCase()}`)} />
      ) : (
        <div className="wells skeleton" style={{ height: 180 }} />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Well ticket */

type Mode = "deposit" | "withdraw" | "kind";

export function WellTicket({ w }: { w?: WellState }) {
  const { address } = useAccount();
  const openWallet = useOpenWallet();
  const { data: a } = useWellAccount(w);
  const tx = useTx();
  const [mode, setMode] = useState<Mode>("deposit");
  const [input, setInput] = useState("");
  if (!w) return <div className="swap well-ticket"><p className="muted small">Loading the Wells…</p></div>;

  const shares = mode === "kind";
  const amt = parseAmount(input, shares ? SHARE_DECIMALS : 6);
  const limit = mode === "deposit" ? (a ? (a.usdgBalance < a.maxDeposit ? a.usdgBalance : a.maxDeposit) : undefined) : mode === "withdraw" ? a?.maxWithdraw : a?.shares;
  const blocked =
    mode === "deposit" && w.paused
      ? "Deposits paused"
      : mode !== "kind" && !w.fresh
        ? "Market closed: withdraw in kind"
        : amt && limit !== undefined && amt > limit
          ? mode === "deposit" && a && amt > a.usdgBalance
            ? "Not enough USDG"
            : "More than available"
          : null;

  const go = async () => {
    if (!amt || !address) return;
    let ok = false;
    if (mode === "deposit")
      ok = await tx.run(`Depositing into the ${w.ticker} Well`, async ({ approve, call }) => {
        await approve(USDG_ADDRESS, w.vault, amt);
        return call({ address: w.vault, abi: wellAbi, functionName: "deposit", args: [amt, address] });
      });
    else if (mode === "withdraw")
      ok = await tx.run("Withdrawing", ({ call }) =>
        // All of it: redeem every share (withdraw would need extra shares to cover the cost of selling stock).
        a && limit !== undefined && amt >= limit
          ? call({ address: w.vault, abi: wellAbi, functionName: "redeem", args: [a.shares, address, address] })
          : call({ address: w.vault, abi: wellAbi, functionName: "withdraw", args: [amt, address, address] }),
      );
    else ok = await tx.run("Withdrawing in kind", ({ call }) => call({ address: w.vault, abi: wellAbi, functionName: "redeemInKind", args: [amt, address, address, 0n, 0n] }));
    if (ok) setInput("");
  };

  const notes: Record<Mode, string> = {
    deposit: `Your USDG joins the ${w.ticker}/USDG pool at the keeper’s next placement, in a range around Chainlink’s price. Shares are priced at Chainlink, never at the pool, so nobody can push the price to take value from you.`,
    withdraw: "Pays exactly this much USDG. If the Well has to sell some stock to raise it, that cost (capped at 1%) is yours, not the other depositors’.",
    kind: `Your share of the ${w.ticker} and USDG the Well holds, with no swap and no price needed. Works when the market is closed or the Well is paused.`,
  };

  return (
    <div className="swap well-ticket">
      <div className="well-ticket-head">
        <TokenDot token={stockToken(w)} />
        <div>
          <b>{w.ticker} Well</b>
          <span className="muted small">{w.price !== undefined ? `${w.name} · ${money(w.price)} on Chainlink` : w.name}</span>
        </div>
        <a className="small muted" href={addressUrl(w.vault)} target="_blank" rel="noopener">
          Contract ↗
        </a>
      </div>
      <div className="seg seg-full">
        {(
          [
            ["deposit", "Deposit"],
            ["withdraw", "Withdraw"],
            ["kind", "In kind"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            className={mode === m ? "on" : ""}
            onClick={() => {
              setMode(m);
              setInput("");
              tx.reset();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="field">
        <div className="field-top">
          <span className="label">{shares ? "Shares" : mode === "deposit" ? "You deposit" : "You withdraw"}</span>
          {limit !== undefined && limit > 0n && (
            <button className="bal small" onClick={() => setInput(trim(formatUnits(limit, shares ? SHARE_DECIMALS : 6)))}>
              Max {shares ? num(Number(formatUnits(limit, SHARE_DECIMALS))) : money(limit)}
            </button>
          )}
        </div>
        <div className="field-row">
          <input className="amount mono" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(",", "."))} />
          <span className="token-btn static">
            {shares ? (
              <>tw{w.ticker}</>
            ) : (
              <>
                <TokenDot token={{ address: USDG_ADDRESS as Address, symbol: "USDG", name: "Global Dollar", decimals: 6, kind: "base" }} /> USDG
              </>
            )}
          </span>
        </div>
      </div>
      <dl className="facts">
        {address && a && a.shares > 0n && (a.value === undefined || a.value >= 10_000n) && (
          <div>
            <dt>Your Well position</dt>
            <dd className="mono">{a.value !== undefined ? money(a.value) : `${num(Number(formatUnits(a.shares, SHARE_DECIMALS)))} tw${w.ticker}`}</dd>
          </div>
        )}
        {w.sharePrice !== undefined && w.supply > 0n && (
          <div>
            <dt>Share price</dt>
            <dd className="mono">{usd(Number(formatUnits(w.sharePrice, 6)))}</dd>
          </div>
        )}
        <div>
          <dt>Swap fees to depositors</dt>
          <dd className="good">{((10_000 - w.protocolShareBps) / 100).toFixed(0)}%, compounding</dd>
        </div>
        <div>
          <dt>Rest of the fees</dt>
          <dd>Buy ${BRAND.token.symbol} and burn it</dd>
        </div>
      </dl>
      <p className="small muted">{notes[mode]}</p>
      {address ? (
        <button className="cta" disabled={!amt || tx.busy || Boolean(blocked)} onClick={go}>
          {tx.busy ? tx.message : blocked ?? (mode === "deposit" ? `Deposit into ${w.ticker} Well` : mode === "withdraw" ? "Withdraw USDG" : `Withdraw ${w.ticker} + USDG`)}
        </button>
      ) : (
        <button className="cta" onClick={openWallet}>
          Connect wallet
        </button>
      )}
      <TxLine tx={tx} />
    </div>
  );
}

/* ------------------------------------------------------------------ Credit lines */

const TABS = [
  ["lend", "Lend"],
  ["withdraw", "Take back"],
  ["pledge", "Pledge"],
  ["borrow", "Borrow"],
  ["repay", "Repay"],
  ["release", "Release"],
] as const;
type Tab = (typeof TABS)[number][0];
const WAD = 10n ** 18n;

export function CreditLines() {
  if (!CREDIT_LINES.length) return null;
  return (
    <section id="borrow" className="section wrap">
      <div className="section-head">
        <h2>Borrow against your Well.</h2>
        <p>
          Pledge Well shares and borrow USDG against them, without selling. Or lend USDG to borrowers and earn their interest. Each
          credit line stands alone: its bad debt never touches another.
        </p>
      </div>
      {CREDIT_LINES.map((c) => (
        <CreditLine key={c.desk} ticker={c.ticker} desk={c.desk} well={c.well} />
      ))}
    </section>
  );
}

function CreditLine({ ticker, desk, well }: { ticker: string; desk: Address; well: Well }) {
  const { address } = useAccount();
  const openWallet = useOpenWallet();
  const { data: s } = useCreditLine(desk, well.vault);
  const tx = useTx();
  const [tab, setTab] = useState<Tab>("lend");
  const [input, setInput] = useState("");
  const shares = tab === "pledge" || tab === "release";
  const amt = parseAmount(input, shares ? SHARE_DECIMALS : 6);
  const me = s?.me;
  const min = (x?: bigint, y?: bigint) => (x === undefined || y === undefined ? undefined : x < y ? x : y);
  const pledgeRoom = s
    ? (() => {
        const cap = (s.vaultSupply * BigInt(s.risk[4])) / 10_000n;
        return cap > s.totalPledged ? cap - s.totalPledged : 0n;
      })()
    : undefined;
  const limit: bigint | undefined = me
    ? { lend: min(me.usdgBal, me.maxDeposit), withdraw: me.lent, pledge: min(me.shares, pledgeRoom), borrow: me.borrowable, repay: min(me.debt, me.usdgBal), release: me.pledged }[tab]
    : undefined;
  const rate = (v?: bigint) => (v === undefined ? "—" : `${(Number(formatUnits(v, 18)) * 100).toFixed(2)}%`);

  const go = async () => {
    if (!amt || !address) return;
    const c = (fn: string, args: readonly unknown[]) => ({ address: desk, abi: creditDeskAbi, functionName: fn, args });
    const actions: Record<Tab, () => Promise<boolean>> = {
      lend: () =>
        tx.run("Lending", async ({ approve, call }) => {
          await approve(USDG_ADDRESS, desk, amt);
          return call(c("deposit", [amt, address]));
        }),
      withdraw: () => tx.run("Taking it back", ({ call }) => call(c("withdraw", [amt, address, address]))),
      pledge: () =>
        tx.run("Pledging", async ({ approve, call }) => {
          await approve(well.vault, desk, amt);
          return call(c("pledge", [amt]));
        }),
      borrow: () => tx.run("Borrowing", ({ call }) => call(c("borrow", [amt, address]))),
      repay: () =>
        tx.run("Repaying", async ({ approve, call }) => {
          // Interest accrues until the transaction lands: a full repayment sends the max and the line caps it.
          const full = me && amt >= me.debt && me.usdgBal > me.debt + me.debt / 1000n;
          await approve(USDG_ADDRESS, desk, full ? amt + amt / 1000n + 1n : amt);
          return call(c("repay", [full ? maxUint256 : amt, address]));
        }),
      release: () => tx.run("Releasing", ({ call }) => call(c("release", [amt, address]))),
    };
    if (await actions[tab]()) setInput("");
  };

  const blurb: Record<Tab, string> = {
    lend: `Lend USDG to borrowers on the ${ticker} line and earn the lend rate. You get tc${ticker} lender shares.`,
    withdraw: "Take lent USDG back, up to the cash the line holds right now.",
    pledge: `Pledge ${ticker} Well shares (tw${ticker}) as collateral. They keep earning the Well’s fees while pledged.`,
    borrow: "Borrow USDG against what you pledged, up to the max loan-to-value. Needs a fresh Chainlink price. The rate floats with use.",
    repay: "Repay any part of your loan at any time. Repaying never waits for a price.",
    release: "Take pledged shares back. With a loan open, what stays pledged must still cover it at the max loan-to-value.",
  };
  const paused = s?.paused && (tab === "lend" || tab === "pledge" || tab === "borrow");
  const blocked = paused ? "Paused by the guardian" : amt && limit !== undefined && amt > limit ? "More than available" : null;
  const health = me?.health;
  const healthText = health === undefined ? "…" : health > 1000n * WAD ? "No loan" : Number(formatUnits(health, 18)).toFixed(2);
  const hasLine = me && (me.lent > 0n || me.pledged > 0n || me.debt > 0n);

  return (
    <div className="credit">
      <div className="credit-info">
        <div className="well-ticket-head">
          <TokenDot token={stockToken(well)} />
          <div>
            <b>{ticker} credit line</b>
            <span className="muted small">Collateral: {ticker} Well shares · Loans in USDG</span>
          </div>
          <a className="small muted" href={addressUrl(desk)} target="_blank" rel="noopener">
            Contract ↗
          </a>
        </div>
        <div className="figures credit-figs">
          <div>
            <b>{s ? `${(s.risk[0] / 100).toFixed(0)}%` : "—"}</b>
            <span>Max loan-to-value</span>
          </div>
          <div>
            <b>{rate(s?.borrowRate)}</b>
            <span>Borrow rate a year</span>
          </div>
          <div>
            <b>{s && s.supplyRate > 0n ? rate(s.supplyRate) : s && s.supplied === 0n && s.supplyCap > 0n ? wholeMoney(s.supplyCap) : "—"}</b>
            <span>{s && s.supplyRate > 0n ? "Lend rate a year" : s && s.supplied === 0n ? "Open to lenders, up to" : "Lend rate a year"}</span>
          </div>
        </div>
        <dl className="kv">
          {s && s.supplied > 0n && (
            <div>
              <dt>Lent in</dt>
              <dd className="mono">{wholeMoney(s.supplied)}</dd>
            </div>
          )}
          {s && s.debt > 0n && (
            <div>
              <dt>Borrowed out</dt>
              <dd className="mono">
                {wholeMoney(s.debt)}
                {Number(formatUnits(s.utilization, 18)) >= 0.01 ? ` · ${(Number(formatUnits(s.utilization, 18)) * 100).toFixed(0)}% in use` : ""}
              </dd>
            </div>
          )}
          <div>
            <dt>Liquidation</dt>
            <dd>{s ? `Below ${(s.risk[1] / 100).toFixed(0)}% cover, anyone may repay part of the loan and take shares worth ${(s.risk[2] / 100).toFixed(0)}% more` : "…"}</dd>
          </div>
          {hasLine && me && (
            <>
              {me.lent > 0n && (
                <div>
                  <dt>You lent</dt>
                  <dd className="mono">{money(me.lent)}</dd>
                </div>
              )}
              {me.pledged > 0n && (
                <div>
                  <dt>You pledged</dt>
                  <dd className="mono">
                    {num(Number(formatUnits(me.pledged, SHARE_DECIMALS)))} tw{ticker}
                    {me.collateral ? ` · ${money(me.collateral)}` : ""}
                  </dd>
                </div>
              )}
              {me.debt > 0n && (
                <div>
                  <dt>Your loan</dt>
                  <dd className="mono">
                    {money(me.debt)} · health {healthText}
                  </dd>
                </div>
              )}
              {me.borrowable > 0n && (
                <div>
                  <dt>You can borrow</dt>
                  <dd className="mono">{money(me.borrowable)}</dd>
                </div>
              )}
            </>
          )}
        </dl>
      </div>
      <div className="swap credit-ticket">
        <div className="seg seg-full seg-wrap">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              className={tab === t ? "on" : ""}
              onClick={() => {
                setTab(t);
                setInput("");
                tx.reset();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="field">
          <div className="field-top">
            <span className="label">{shares ? "Well shares" : "USDG"}</span>
            {limit !== undefined && limit > 0n && (
              <button className="bal small" onClick={() => setInput(trim(formatUnits(limit, shares ? SHARE_DECIMALS : 6)))}>
                Max {shares ? num(Number(formatUnits(limit, SHARE_DECIMALS))) : money(limit)}
              </button>
            )}
          </div>
          <div className="field-row">
            <input className="amount mono" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value.replace(",", "."))} />
            <span className="token-btn static">{shares ? `tw${ticker}` : "USDG"}</span>
          </div>
        </div>
        <p className="small muted">{blurb[tab]}</p>
        {address ? (
          <button className="cta" disabled={!amt || tx.busy || Boolean(blocked)} onClick={go}>
            {tx.busy ? tx.message : blocked ?? TABS.find(([t]) => t === tab)![1]}
          </button>
        ) : (
          <button className="cta" onClick={openWallet}>
            Connect wallet
          </button>
        )}
        <TxLine tx={tx} />
      </div>
    </div>
  );
}

