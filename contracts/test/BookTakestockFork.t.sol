// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {QuoterTakestock} from "../src/QuoterTakestock.sol";
import {RouterTakestock} from "../src/RouterTakestock.sol";
import {IUniswapV3Factory, IERC20Min} from "../src/interfaces/IExternal.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {HopKind, Hop, Leg} from "../src/RouteTypes.sol";

interface IERC20A {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// BookTakestock with a fresh RouterTakestock against the real pools on a copy of mainnet.
///   RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> forge test --mc BookTakestockForkTest -vv
contract BookTakestockForkTest is Test {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    BookTakestock book;
    QuoterTakestock quoter;
    address maker = makeAddr("maker");
    address keeper = makeAddr("keeper");
    bool live;

    function _lim(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint64 expiry)
        internal
        pure
        returns (BookTakestock.Params memory p)
    {
        p = BookTakestock.Params(tokenIn, tokenOut, uint128(amountIn), uint128(minOut), expiry, false, address(0), 0, false, false, 0, 0);
    }

    function _fillRaw(uint256 id, Leg[] memory legs) internal returns (uint256) {
        uint256 t;
        for (uint256 i; i < legs.length; ++i) t += legs[i].amountIn;
        return book.fill(id, t, legs, block.timestamp);
    }

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        RouterTakestock router = new RouterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        book = new BookTakestock(IRouterTakestock(address(router)), 10, 0, address(0));
        quoter = new QuoterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        deal(USDG, maker, 10_000e6);
        vm.prank(maker);
        IERC20A(USDG).approve(address(book), type(uint256).max);
    }

    function test_fork_limitBuyNvda_fillsThroughLiveRouter() public {
        if (!live) return;
        Hop[] memory p = new Hop[](1);
        p[0] = Hop(HopKind.V3, NVDA, 500, 0, address(0));
        (uint256 q,) = quoter.quotePath(USDG, p, 100e6);
        uint128 minOut = uint128((q * 9_980) / 10_000); // 0.2% under the market: fillable after the 0.1% fee
        vm.prank(maker);
        uint256 id = book.place(_lim(USDG, NVDA, 100e6, minOut, uint64(block.timestamp + 1 hours)));
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(100e6, p);
        uint256 before = IERC20A(NVDA).balanceOf(maker);
        vm.prank(keeper);
        uint256 got = _fillRaw(id, legs);
        assertGe(got, minOut);
        assertEq(IERC20A(NVDA).balanceOf(maker) - before, got);
        assertEq(IERC20A(USDG).balanceOf(address(book)), 0);
        assertEq(IERC20A(NVDA).balanceOf(address(book)), 0);
        console2.log("100 USDG limit buy -> NVDA (raw):", got, "fee:", IERC20A(NVDA).balanceOf(keeper));
    }

    function test_fork_limitAboveMarket_doesNotFill() public {
        if (!live) return;
        Hop[] memory p = new Hop[](1);
        p[0] = Hop(HopKind.V3, NVDA, 500, 0, address(0));
        (uint256 q,) = quoter.quotePath(USDG, p, 100e6);
        vm.prank(maker);
        uint256 id = book.place(_lim(USDG, NVDA, 100e6, uint128((q * 11) / 10), uint64(block.timestamp + 1 hours)));
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(100e6, p);
        vm.prank(keeper);
        vm.expectRevert();
        _fillRaw(id, legs);
        assertEq(IERC20A(USDG).balanceOf(address(book)), 100e6);
    }
}
