import deployed from "@/generated/book.json";

const gen = deployed as Partial<Record<"token" | "tokenSymbol", string | null>>;
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Everything brand-specific lives here, so renaming the product is a one-file change. */
export const BRAND = {
  name: "Takestock",
  /** Short line under the name (footer, meta). */
  tagline: "Take-profit and stop-loss orders for tokenized stocks on Robinhood Chain.",
  domain: (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
  x: process.env.NEXT_PUBLIC_X_URL || "",
  /** $TSTK, launched on Pons from the dev wallet; set-token.sh records it in src/generated/book.json.
   *  Until then the site says it has not launched. */
  token: {
    symbol: gen.tokenSymbol || "TSTK",
    address: (isAddr(gen.token) ? gen.token : "") as `0x${string}` | "",
  },
};
