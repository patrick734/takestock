import type { Metadata, Viewport } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { BRAND } from "@/lib/brand";
import { Providers } from "./providers";
import "./globals.css";

// Absolute base for link previews (X cards etc.): the site's domain. NEXT_PUBLIC_SITE_URL overrides it.
const SITE = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
const TITLE = `${BRAND.name}: take-profit and stop-loss orders for Robinhood Stock Tokens`;
const DESCRIPTION =
  "Set a target gain on any Robinhood Stock Token, add a stop-loss, or sell in steps. The moment your target pays, the order fills across every Uniswap pool. No admin keys; cancel anytime.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: "/icon.svg" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: BRAND.name, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef0f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e12" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="backdrop" aria-hidden="true">
          <i className="b1" />
          <i className="b2" />
          <i className="b3" />
        </div>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
