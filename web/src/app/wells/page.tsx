"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { BRAND } from "@/lib/brand";
import { useReadContract } from "wagmi";
import { oracleAbi } from "@/generated/wellsAbi";
import { BURN, CHAIN_ID, CREDIT_LINES, WELLS, WELL_CONTRACTS, addressUrl } from "@/lib/config";
import { usd } from "@/lib/format";
import { useWells } from "@/lib/wells";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Sections";
import { CreditLines, WellList, WellTicket } from "@/components/Wells";

export default function WellsPage() {
  const { data: wells } = useWells();
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.slice(1).toUpperCase() : "";
    if (WELLS.some((w) => w.ticker === hash)) setSelected(hash);
  }, []);
  const ticker = selected ?? WELLS.find((w) => w.ticker === "NVDA")?.ticker ?? WELLS[0]?.ticker;
  const current = wells?.find((w) => w.ticker === ticker);

  const deposited = (wells ?? []).reduce((s, w) => s + (w.value ?? 0n), 0n);
  const fees = (wells ?? []).reduce((s, w) => s + w.feesUsdg, 0n);
  const share = wells?.[0] ? 10_000 - wells[0].protocolShareBps : 7_000;
  const figures = [
    { label: "Deposited", value: usd(Number(formatUnits(deposited, 6))).replace(/\.\d\d$/, ""), show: deposited >= 1_000_000n },
    { label: "Fees earned", value: fees >= 100_000_000n ? usd(Number(formatUnits(fees, 6))).replace(/\.\d\d$/, "") : usd(Number(formatUnits(fees, 6))), show: fees >= 10_000n },
    { label: "Wells", value: WELLS.length, show: true },
    { label: "Of every swap fee to depositors", value: `${share / 100}%`, show: true },
    { label: "Credit line", value: CREDIT_LINES.map((c) => c.ticker).join(", "), show: CREDIT_LINES.length > 0 },
  ]
    .filter((f) => f.show)
    .slice(0, 3);

  const pick = (t: string) => {
    setSelected(t);
    history.replaceState(null, "", `#${t.toLowerCase()}`);
    if (window.matchMedia("(max-width: 980px)").matches) document.getElementById("well-ticket")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <Header />
      <main>
        <section className="hero wrap wells-hero">
          <div className="hero-copy">
            <div className="pills">
              <span className="pill">
                <i className="live-dot" /> Robinhood Chain
              </span>
              <span className="pill">Uniswap v4 · Chainlink</span>
            </div>
            <h1>Earn what the stock’s traders pay.</h1>
            <p className="lede">
              Deposit USDG in a Well. {BRAND.name} keeps it in that Stock Token’s Uniswap v4 pool, in a range centred on Chainlink’s
              price, and every trade through it pays you a fee that compounds into your share. Take it out in USDG any time, or as stock and
              USDG with no price needed.
            </p>
            <div className="figures">
              {figures.map((f) => (
                <div key={f.label}>
                  <b>{f.value}</b>
                  <span>{f.label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="order-shell" id="well-ticket">
            {WELLS.length ? <WellTicket key={ticker} w={current} /> : <p className="muted small" style={{ padding: 16 }}>The Wells open shortly.</p>}
          </div>
        </section>

        {WELLS.length > 0 && (
          <section id="wells" className="section wrap">
            <div className="section-head">
              <h2>Pick a Well.</h2>
              <p>One Well per Stock Token. Each holds a single range in that stock’s USDG pool and moves it when the price does.</p>
            </div>
            {wells ? <WellList wells={wells} selected={ticker} onPick={pick} /> : <div className="wells skeleton" style={{ height: 180 }} />}
          </section>
        )}

        <CreditLines />
        <WellsHow />
      </main>
      <Footer />
    </>
  );
}

function WellsHow() {
  const owner = useReadContract({
    address: WELL_CONTRACTS.oracle,
    abi: oracleAbi,
    functionName: "owner",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(WELL_CONTRACTS.oracle) },
  });
  const handedOver = Boolean(owner.data && BURN.timelock && String(owner.data).toLowerCase() === BURN.timelock.toLowerCase());
  const steps = [
    {
      n: "1",
      t: "Deposit USDG",
      d: "You get Well shares, priced at Chainlink’s price for the stock, never at the pool’s. A deposit is refused while the pool sits more than 2% away from Chainlink, so nobody can move the pool to take value from you.",
    },
    {
      n: "2",
      t: "The keeper places it",
      d: "It swaps about half into the stock and puts both into one concentrated range around Chainlink’s price. When the price walks toward the edge, it moves the range back. Every swap is checked against Chainlink and refused past a 1% loss.",
    },
    {
      n: "3",
      t: "Fees compound",
      d: `Every trade through the range pays the pool fee. 70% of it stays in the Well and raises your share’s value. 30% goes to the fee router, which sends it to BuyBurnTakestock to buy $${BRAND.token.symbol} and burn it.`,
    },
  ];
  const rows: [string, string | undefined][] = [
    ["OracleTakestock", WELL_CONTRACTS.oracle],
    ["FeeRouterTakestock", WELL_CONTRACTS.feeRouter],
    ["RegistryTakestock", WELL_CONTRACTS.registry],
    ...WELLS.map((w) => [`WellTakestock ${w.ticker}`, w.vault] as [string, string]),
    ...CREDIT_LINES.map((c) => [`CreditDeskTakestock ${c.ticker}`, c.desk] as [string, string]),
  ];
  return (
    <>
      <section id="how-wells" className="section wrap">
        <div className="section-head">
          <h2>How a Well works.</h2>
          <p>A Well is a vault that does the liquidity-providing for you, inside limits written into the contract.</p>
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
      {WELLS.length > 0 && (
        <section id="well-contracts" className="section wrap">
          <div className="section-head">
            <h2>Read the code.</h2>
            <p>Every Well contract carries the Takestock name and is verified on the Robinhood Chain explorer.</p>
          </div>
          <div className="twocol">
            <div className="panel">
              <dl className="kv">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className="mono">
                      {v && (
                        <a href={addressUrl(v)} target="_blank" rel="noopener">
                          {v.slice(0, 8)}…{v.slice(-6)}
                        </a>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="panel">
              <dl className="kv">
                <div>
                  <dt>Settings</dt>
                  <dd>
                    {handedOver
                      ? "Every change (caps, fee share, risk limits, price feeds) waits 48 hours in public in TimelockTakestock before it can run."
                      : "Every change to caps, fee share and risk limits waits 48 hours in public in TimelockTakestock. The price feeds and the registry join the same timelock when its 48-hour handoff completes, shortly after launch."}
                  </dd>
                </div>
                <div>
                  <dt>Guardian</dt>
                  <dd>Can pause deposits and borrowing and lower caps, never raise them. Exits and repayments always stay open.</dd>
                </div>
                <div>
                  <dt>Keeper</dt>
                  <dd>Can only move a Well’s range, through registered pools, within the Chainlink checks. It can never take funds out.</dd>
                </div>
                <div>
                  <dt>Exit</dt>
                  <dd>Withdrawing in kind needs no price and no swap, and works even while a Well is paused.</dd>
                </div>
              </dl>
            </div>
          </div>
          <p className="disclose">
            The Well and credit-line contracts have not been independently audited. They are tested against the real Uniswap v4
            PoolManager and PositionManager. A concentrated range earns more fees than a wide one but also sells into a falling stock and
            buys into a rising one, so a Well can be worth less than it would be holding USDG. Chainlink’s stock prices pause outside US
            market hours, and then deposits, USDG withdrawals and borrowing wait; withdrawing in kind does not. Prices can gap at the
            open, and a loan that falls below its cover can be liquidated. Nothing here is investment advice.
          </p>
        </section>
      )}
    </>
  );
}
