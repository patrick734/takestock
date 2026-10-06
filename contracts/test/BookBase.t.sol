// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base} from "./Base.t.sol";
import {BookTakestock} from "../src/BookTakestock.sol";
import {Leg} from "../src/RouteTypes.sol";

/// A Chainlink-style feed whose answer and timestamp the test sets.
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setAt(int256 a, uint256 at) external {
        answer = a;
        updatedAt = at;
    }

    function breakIt(bool b) external {
        broken = b;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// A feed that burns all the gas it is given.
contract GasBombFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 x;
        while (gasleft() > 0) x++;
        return (1, int256(x), block.timestamp, block.timestamp, 1);
    }
}

abstract contract BookBase is Base {
    BookTakestock book;

    function _lim(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint64 expiry)
        internal
        pure
        returns (BookTakestock.Params memory p)
    {
        p = BookTakestock.Params(tokenIn, tokenOut, uint128(amountIn), uint128(minOut), expiry, false, address(0), 0, false, false, 0, 0);
    }

    function _withStop(BookTakestock.Params memory p, address feed, uint256 stopPrice, bool below, uint256 stopMinOut)
        internal
        pure
        returns (BookTakestock.Params memory)
    {
        p.feed = feed;
        p.stopPrice = uint128(stopPrice);
        p.stopBelow = below;
        p.feedPricesIn = below; // a sell-stop prices what is sold; a buy-stop prices what is bought
        p.stopMinOut = uint128(stopMinOut);
        p.maxAge = 1 hours;
        return p;
    }

    function _partial(BookTakestock.Params memory p) internal pure returns (BookTakestock.Params memory) {
        p.partialFill = true;
        return p;
    }

    function _sum(Leg[] memory legs) internal pure returns (uint256 t) {
        for (uint256 i; i < legs.length; ++i) t += legs[i].amountIn;
    }

    function _fillRaw(uint256 id, Leg[] memory legs) internal returns (uint256) {
        return book.fill(id, _sum(legs), legs, block.timestamp);
    }
}
