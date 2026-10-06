"use client";

import { useEffect, useState } from "react";
import { probeV4Pools, NATIVE, readOrders, limitBookAbi, OrderStatus, type V4PoolKey, type LimitOrder } from "@splitroute/engine";
import { usePublicClient, useReadContract } from "wagmi";
import type { PublicClient } from "viem";
import { BRAND } from "@/lib/brand";
import { CHAIN_ID, ENGINE, LIMIT_BOOK } from "@/lib/config";
import { BASE_TOKENS, loadTokens, type Token } from "@/lib/tokens";
import { useMarkets } from "@/lib/useMarkets";
import { usd } from "@/lib/format";
import { Header } from "@/components/Header";
import { Ticker } from "@/components/Ticker";
import { LimitCard, type Preset } from "@/components/LimitCard";
import { GainCard } from "@/components/GainCard";
import { TargetChart } from "@/components/TargetChart";
import { MyOrders, describe } from "@/components/MyOrders";
import { CopyCA } from "@/components/CopyCA";
import { MarketsTable } from "@/components/MarketsTable";
import { WellsTeaser } from "@/components/Wells";
import { Contracts, FAQ, Footer, HowItWorks, TokenSection, type Fees } from "@/components/Sections";

export default function Home() {
  const [tokens, setTokens] = useState<Token[]>(BASE_TOKENS);
  const [listReady, setListReady] = useState(false);
  const [v4Pools, setV4Pools] = useState<V4PoolKey[]>([]);
  const [preset, setPreset] = useState<Preset | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [book, setBook] = useState<LimitOrder[]>([]);
  const markets = useMarkets(tokens, v4Pools);
  const client = usePublicClient({ chainId: CHAIN_ID }) as PublicClient | undefined;

  const [mode, setMode] = useState<"gain" | "advanced">("gain");
  const filler = useReadContract({ address: LIMIT_BOOK, abi: limitBookAbi, functionName: "fillerFeeBps", chainId: CHAIN_ID, query: { enabled: !!LIMIT_BOOK } });
  const protocol = useReadContract({ address: LIMIT_BOOK, abi: limitBookAbi, functionName: "protocolFeeBps", chainId: CHAIN_ID, query: { enabled: !!LIMIT_BOOK } });
  // The deployed fees, or the defaults DeployTakestock uses until there is a deployment to read.
  const fees: Fees = { filler: filler.data !== undefined ? Number(filler.data) : 5, protocol: protocol.data !== undefined ? Number(protocol.data) : 25 };
  const feeBps = fees.filler + fees.protocol;

  useEffect(() => {
    loadTokens().then(async (d) => {
      setTokens(d.tokens);
      setV4Pools(d.v4Pools);
      setListReady(true);
      if (d.v4Pools.length === 0 && client) {
        try {
          const stocks = d.tokens.filter((t) => t.kind === "stock").map((t) => t.address);
          const found = await probeV4Pools(client, ENGINE, stocks, [ENGINE.hubs[0], NATIVE, ENGINE.weth]);
          if (found.length) setV4Pools(found);
        } catch {
          /* v3 prices still work */
        }
      }
    });
  }, [client]);

  // The whole book, for the live "waiting" figures.
  useEffect(() => {
    if (!client || !LIMIT_BOOK) return;
    let dead = false;
    const run = () => readOrders(client, LIMIT_BOOK!).then((o) => !dead && setBook(o)).catch(() => {});
    run();
    const t = setInterval(() => document.visibilityState === "visible" && run(), 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [client, refreshKey]);

  const pick = (t: Token) => {
    setMode("advanced");
    setPreset((p) => ({ stock: t, nonce: (p?.nonce ?? 0) + 1 }));
    document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const open = book.filter((o) => o.status === OrderStatus.Open && o.expiry >= now);
  const filled = book.filter((o) => o.status === OrderStatus.Filled).length;
  const waitingUsd = open.reduce((s, o) => {
    const d = describe(o, tokens);
    const t = d.tin;
    const px = t ? (t.symbol === "USDG" ? 1 : markets.usd(t.address)) : undefined;
    return px && t ? s + px * (Number(o.remaining) / 10 ** t.decimals) : s;
  }, 0);
  const stocks = tokens.filter((t) => t.kind === "stock").length;
  // Live order figures when there are any; otherwise facts about the product. Nothing ever reads zero.
  const live = [
    { label: "Open orders", value: open.length, show: open.length > 0 },
    { label: "Waiting to fill", value: usd(waitingUsd).replace(/\.\d\d$/, ""), show: waitingUsd >= 1 },
    { label: "Orders filled", value: filled, show: filled > 0 },
  ].filter((f) => f.show);
  const facts = [
    { label: "Stock Tokens", value: listReady && stocks > 0 ? stocks : "—" },
    { label: "Fee, only on fills", value: `${(feeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%` },
    { label: "Admin keys on the order book", value: "None" },
  ];
  const figures = [...live, ...facts].slice(0, 3);

  return (
    <>
      <Ticker tokens={tokens} markets={markets} onPick={pick} />
      <Header />
      <main>
        <section className="hero wrap">
          <div className="hero-copy">
            <div className="pills">
              <span className="pill">
                <i className="live-dot" /> Robinhood Chain
              </span>
              <span className="pill">Take profit · Stop-loss · Ladders</span>
            </div>
            <h1>Set your gain. Get paid when it hits.</h1>
            <p className="lede">
              Pick a Stock Token, choose your target (+10%, +25%, your own price) and add a stop-loss if you want one. {BRAND.name}{" "}
              watches every Uniswap pool and Chainlink’s price, and sells the moment your target pays, split across the pools that pay
              most. Your tokens stay in a contract with no admin keys until then.
            </p>
            <TargetChart />
            <div className="figures">
              {figures.map((f) => (
                <div key={f.label}>
                  <b>{f.value}</b>
                  <span>{f.label}</span>
                </div>
              ))}
            </div>
            <CopyCA />
          </div>
          <div className="order-shell">
            <div className="panel-modes" role="tablist" aria-label="Order type">
              <button role="tab" aria-selected={mode === "gain"} className={mode === "gain" ? "on" : ""} onClick={() => setMode("gain")}>
                Take profit
              </button>
              <button role="tab" aria-selected={mode === "advanced"} className={mode === "advanced" ? "on" : ""} onClick={() => setMode("advanced")}>
                Advanced
              </button>
            </div>
            <div className="order-panel">
              {mode === "gain" ? (
                <GainCard tokens={tokens} markets={markets} feeBps={feeBps} onPlaced={() => setRefreshKey((k) => k + 1)} />
              ) : (
                <LimitCard tokens={tokens} markets={markets} preset={preset} feeBps={feeBps} onPlaced={() => setRefreshKey((k) => k + 1)} />
              )}
            </div>
          </div>
        </section>
        <MyOrders tokens={tokens} markets={markets} refreshKey={refreshKey} />
        <MarketsTable tokens={tokens} markets={markets} onTrade={pick} />
        <WellsTeaser />
        <HowItWorks fees={fees} />
        <Contracts fees={fees} />
        <TokenSection />
        <FAQ fees={fees} />
      </main>
      <Footer />
    </>
  );
}
