// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Native ETH is written as address(0) everywhere (the same convention Uniswap v4 uses).
address constant NATIVE = address(0);

/// @notice What a single hop does.
/// V3     : swap through the canonical Uniswap v3 pool for (tokenIn, tokenOut, fee).
/// V4     : swap through the Uniswap v4 pool keyed by (tokenIn, tokenOut, fee, tickSpacing, hooks).
/// WRAP   : ETH -> WETH, 1:1.
/// UNWRAP : WETH -> ETH, 1:1.
enum HopKind {
    V3,
    V4,
    WRAP,
    UNWRAP
}

struct Hop {
    HopKind kind;
    address tokenOut;
    uint24 fee; // v3 fee tier or v4 LP fee
    int24 tickSpacing; // v4 only
    address hooks; // v4 only (address(0) = no hooks)
}

/// @notice One path of the order. A swap is split across up to MAX_LEGS legs.
struct Leg {
    uint256 amountIn;
    Hop[] hops;
}
