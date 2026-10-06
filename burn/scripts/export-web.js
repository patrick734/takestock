// Adds the burn contracts, the Wells and credit line (once added) and the token (once set) to
// web/src/generated/book.json, next to the order contracts that launch.sh writes there. The website and the book keeper
// read that file. Run by launch.sh, launch-wells.sh and set-token.sh.
const fs = require("fs");
const path = require("path");

const network = process.argv[2] || "robinhood";
const dep = path.join(__dirname, "..", "deployments", `${network}.json`);
const out = path.join(__dirname, "..", "..", "web", "src", "generated", "book.json");
if (!fs.existsSync(dep)) throw new Error(`No ${path.relative(process.cwd(), dep)}`);
const d = JSON.parse(fs.readFileSync(dep, "utf8"));
const book = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
Object.assign(book, {
  buyBurn: d.buyBurn,
  timelock: d.timelock,
  swapAdapter: d.swapAdapter,
  token: d.token || null,
  tokenSymbol: d.tokenSymbol || null,
  tokenName: d.tokenName || null,
});
if (d.liquidityVaults && Object.keys(d.liquidityVaults).length) {
  Object.assign(book, {
    usdg: d.usdg,
    oracle: d.oracle,
    feeRouter: d.feeRouter,
    registry: d.registry,
    wellsBlock: d.wellsBlock,
    wells: Object.fromEntries(
      Object.entries(d.liquidityVaults).map(([t, w]) => [t, { vault: w.vault, position: w.position, stock: w.stock, name: w.name, feed: d.markets[t] && d.markets[t].feed }]),
    ),
    creditLines: d.creditLines || {},
  });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(book, null, 2) + "\n");
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
