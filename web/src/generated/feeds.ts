// Chainlink USD feeds on Robinhood Chain, from burn/config/robinhood.json. Stop orders read these.

/** Chainlink USD price feed per Stock Token address (lower case). */
export const FEEDS: Record<string, { symbol: string; feed: `0x${string}` }> = {
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": {
    "symbol": "AAPL",
    "feed": "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0"
  },
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": {
    "symbol": "AMD",
    "feed": "0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72"
  },
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54": {
    "symbol": "AMZN",
    "feed": "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C"
  },
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": {
    "symbol": "CRCL",
    "feed": "0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a"
  },
  "0x1b0e319c6a659f002271b69db8a7df2f911c153e": {
    "symbol": "GME",
    "feed": "0x27C71df6A64fB476468EdF256CF72c038baB5B67"
  },
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": {
    "symbol": "GOOGL",
    "feed": "0xF6f373a037c30F0e5010d854385cA89185AE638b"
  },
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": {
    "symbol": "INTC",
    "feed": "0x3f390C5C24628Ac7C489515402235FeAD71D1913"
  },
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": {
    "symbol": "META",
    "feed": "0x7C38C00C30BEe9378381E7B6135d7283356D71b1"
  },
  "0xe93237c50d904957cf27e7b1133b510c669c2e74": {
    "symbol": "MSFT",
    "feed": "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E"
  },
  "0xec262a75e413fafd0df80480274532c79d42da09": {
    "symbol": "MSTR",
    "feed": "0x396118bdFB181e6240E74D243F266B061c0edc3D"
  },
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": {
    "symbol": "MU",
    "feed": "0x425EEFdCf05ed6526C3cE61Af99429A228a6d596"
  },
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": {
    "symbol": "NVDA",
    "feed": "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15"
  },
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": {
    "symbol": "PLTR",
    "feed": "0x820ABedFF239034956B7A9d2F0a331f9F075eB4c"
  },
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": {
    "symbol": "QQQ",
    "feed": "0x80901d846d5D7B030F26B480776EE3b29374C2ae"
  },
  "0xb90a19ff0af67f7779aff50a882a9cff42446400": {
    "symbol": "SNDK",
    "feed": "0xfb133Fa4B7b385802B693a293606682Df47109A3"
  },
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": {
    "symbol": "SPCX",
    "feed": "0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb"
  },
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": {
    "symbol": "SPY",
    "feed": "0x319724394D3A0e3669269846abE664Cd621f9f6A"
  },
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d": {
    "symbol": "TSLA",
    "feed": "0x4A1166a659A55625345e9515b32adECea5547C38"
  }
};
/** Longest accepted age of a feed answer for stop orders: the feeds' 24h heartbeat plus 2h. */
export const STOP_MAX_AGE = 93600;
