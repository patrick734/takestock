// Offline unit tests for the keeper's pure logic: buy-and-burn routes and revert decoding.
// Run with `npm test`. Needs no node or RPC, only burn/artifacts for the ABIs.
const assert = require("assert/strict");
const { ethers } = require("ethers");
const { buildRoute } = require("../src/routes");
const { reason } = require("../src/chain");
const abis = require("../src/abis");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("routes");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35";
const TOKEN = "0x1111111111111111111111111111111111111111";
const ctx = { dep: { usdg: USDG, token: TOKEN, stocks: { META: { token: META } } } };
const decode = (r) => ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], r)[0].map(String);
test("default route for USDG collapses IN/USDG: USDG -> ETH -> TOKEN", () => {
  const { route, path } = buildRoute(ctx, ["IN", "USDG", "ETH", "TOKEN"], USDG, TOKEN);
  assert.deepEqual(path, [ethers.getAddress(USDG), ethers.ZeroAddress, TOKEN]);
  assert.deepEqual(decode(route), path);
});
test("default route for a Stock Token: META -> USDG -> ETH -> TOKEN", () => {
  const { path } = buildRoute(ctx, ["IN", "USDG", "ETH", "TOKEN"], META, TOKEN);
  assert.deepEqual(path, [ethers.getAddress(META), ethers.getAddress(USDG), ethers.ZeroAddress, TOKEN]);
});
test('"default" and [] mean the adapter default path (0x)', () => {
  assert.equal(buildRoute(ctx, "default", USDG, TOKEN).route, "0x");
  assert.equal(buildRoute(ctx, [], USDG, TOKEN).route, "0x");
});
test("a route that does not end at the token is rejected", () => {
  assert.throws(() => buildRoute(ctx, ["IN", "ETH"], USDG, TOKEN));
  assert.throws(() => buildRoute(ctx, ["IN", "NOPE", "TOKEN"], USDG, TOKEN));
  assert.throws(() => buildRoute({ dep: { usdg: USDG, token: null } }, ["IN", "TOKEN"], USDG, TOKEN));
});

console.log("revert decoding");
test("custom errors decode by name, including nested ones", () => {
  const bb = new ethers.Interface(abis.BuyBurn);
  assert.equal(reason({ data: bb.encodeErrorResult("TooSoon", []) }), "TooSoon()");
  const ad = new ethers.Interface(abis.SwapAdapter);
  assert.equal(reason({ error: { data: ad.encodeErrorResult("InvalidRoute", []) } }), "InvalidRoute()");
});

console.log(process.exitCode ? "\nunit tests FAILED" : `\nall ${passed} unit tests passed`);
