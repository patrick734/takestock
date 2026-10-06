// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {RouterTakestock} from "../src/RouterTakestock.sol";
import {QuoterTakestock} from "../src/QuoterTakestock.sol";
import {IUniswapV3Factory, IERC20Min} from "../src/interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop, Leg} from "../src/RouteTypes.sol";

interface IERC20Approve {
    function approve(address, uint256) external returns (bool);
}

/// Runs against a copy of Robinhood Chain mainnet. Skipped unless RPC_URL is set:
///   RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key> forge test --mc ForkTest -vv
contract ForkTest is Test {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;

    RouterTakestock router;
    QuoterTakestock quoter;
    address user = makeAddr("forkUser");
    bool live;

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        router = new RouterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        quoter = new QuoterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        deal(USDG, user, 1_000_000e6);
        vm.deal(user, 100 ether);
        vm.prank(user);
        IERC20Approve(USDG).approve(address(router), type(uint256).max);
    }

    function test_fork_contractsExist() public view {
        if (!live) return;
        assertGt(V3_FACTORY.code.length, 0, "v3 factory");
        assertGt(POOL_MANAGER.code.length, 0, "v4 PoolManager: wrong address?");
        assertGt(WETH.code.length, 0, "WETH");
    }

    function test_fork_usdgToNvda_v3() public {
        if (!live) return;
        Hop[] memory p = new Hop[](1);
        p[0] = Hop(HopKind.V3, NVDA, 500, 0, address(0));
        _swapAndCheck(USDG, NVDA, p, 100e6);
    }

    function test_fork_usdgToCashcat_viaWeth() public {
        if (!live) return;
        Hop[] memory p = new Hop[](2);
        p[0] = Hop(HopKind.V3, WETH, 500, 0, address(0));
        p[1] = Hop(HopKind.V3, CASHCAT, 10000, 0, address(0));
        _swapAndCheck(USDG, CASHCAT, p, 20e6);
    }

    function test_fork_ethToUsdg_wrapThenV3() public {
        if (!live) return;
        Hop[] memory p = new Hop[](2);
        p[0] = Hop(HopKind.WRAP, WETH, 0, 0, address(0));
        p[1] = Hop(HopKind.V3, USDG, 500, 0, address(0));
        (uint256 q,) = quoter.quotePath(NATIVE, p, 0.01 ether);
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(0.01 ether, p);
        vm.prank(user);
        uint256 out = router.swap{value: 0.01 ether}(NATIVE, USDG, legs, q, user, block.timestamp);
        assertEq(out, q);
        console2.log("0.01 ETH ->", out, "USDG (raw)");
        _assertEmpty(USDG);
    }

    function test_fork_stockToStock_splitAcrossHubs() public {
        if (!live) return;
        // NVDA -> USDG -> TSLA, using whichever fee tier each stock's USDG pool is on.
        deal(NVDA, user, 10e18);
        vm.prank(user);
        IERC20Approve(NVDA).approve(address(router), type(uint256).max);
        Hop[] memory p = new Hop[](2);
        p[0] = Hop(HopKind.V3, USDG, _fee(NVDA, USDG), 0, address(0));
        p[1] = Hop(HopKind.V3, TSLA, _fee(USDG, TSLA), 0, address(0));
        _swapAndCheck(NVDA, TSLA, p, 0.1e18);
    }

    /// First fee tier with a pool, deepest-first by convention for stock tokens.
    function _fee(address a, address b) internal view returns (uint24) {
        uint24[4] memory fees = [uint24(500), 3000, 10000, 100];
        for (uint256 i; i < 4; ++i) {
            if (IUniswapV3Factory(V3_FACTORY).getPool(a, b, fees[i]) != address(0)) return fees[i];
        }
        revert("no v3 pool");
    }

    function _swapAndCheck(address tokenIn, address tokenOut, Hop[] memory p, uint256 amount) internal {
        (uint256 q,) = quoter.quotePath(tokenIn, p, amount);
        assertGt(q, 0, "quote");
        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg(amount, p);
        uint256 before = IERC20Min(tokenOut).balanceOf(user);
        vm.prank(user);
        uint256 out = router.swap(tokenIn, tokenOut, legs, q, user, block.timestamp);
        assertEq(out, q, "executed = quoted");
        assertEq(IERC20Min(tokenOut).balanceOf(user) - before, q, "user got it");
        console2.log("in", amount, "out", out);
        _assertEmpty(tokenIn);
        _assertEmpty(tokenOut);
    }

    function _assertEmpty(address token) internal view {
        assertEq(IERC20Min(token).balanceOf(address(router)), 0, "router kept tokens");
        assertEq(IERC20Min(WETH).balanceOf(address(router)), 0, "router kept WETH");
        assertEq(address(router).balance, 0, "router kept ETH");
    }
}
