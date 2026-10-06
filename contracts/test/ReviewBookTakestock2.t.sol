// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookBase, MockFeed} from "./BookBase.t.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {RouterTakestock} from "../src/RouterTakestock.sol";
import {NATIVE, Hop, Leg} from "../src/RouteTypes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// A feed whose raw return data the test controls.
/// mode 0: well-formed; 1: roundId with bits above uint80 (dirty); 2: short (96 bytes);
/// 3: return-data bomb (150 KB); 4: revert.
contract RawFeed {
    uint256 public mode;
    int256 public answer;
    uint256 public at;

    constructor(int256 a) {
        answer = a;
        at = block.timestamp;
    }

    function setMode(uint256 m) external {
        mode = m;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        at = t;
    }

    fallback() external {
        uint256 m = mode;
        int256 a = answer;
        uint256 t = at;
        assembly {
            switch m
            case 0 {
                mstore(0, 1)
                mstore(32, a)
                mstore(64, t)
                mstore(96, t)
                mstore(128, 1)
                return(0, 160)
            }
            case 1 {
                mstore(0, shl(100, 1)) // does not fit in uint80
                mstore(32, a)
                mstore(64, t)
                mstore(96, t)
                mstore(128, 1)
                return(0, 160)
            }
            case 2 {
                mstore(0, 1)
                mstore(32, a)
                mstore(64, t)
                return(0, 96)
            }
            case 3 {
                mstore(0, 1)
                mstore(32, a)
                mstore(64, t)
                mstore(96, t)
                mstore(128, 1)
                return(0, 150000)
            }
            default { revert(0, 0) }
        }
    }
}

/// A legitimate but expensive feed (burns ~80k gas) to probe the 63/64 rule.
contract HeavyFeed {
    int256 public answer;
    uint256 public at;

    constructor(int256 a) {
        answer = a;
        at = block.timestamp;
    }

    function set(int256 a) external {
        answer = a;
        at = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 g = gasleft();
        while (g - gasleft() < 80_000) {}
        return (1, answer, at, at, 1);
    }
}

/// An intermediate token a filler routes through: on every transfer it tries to reenter the book and
/// router, and gifts tokenOut to the book.
contract EvilHop is MockERC20 {
    BookTakestock public book;
    RouterTakestock public router;
    MockERC20 public giftToken;
    uint256 public victim;
    bool public armed;
    bool public reenterOk;
    uint256 public attempts;

    constructor() MockERC20("EvilHop", "EVH", 18) {}

    function arm(BookTakestock b, RouterTakestock r, MockERC20 g, uint256 v) external {
        book = b;
        router = r;
        giftToken = g;
        victim = v;
        armed = true;
    }

    function _attack() internal {
        if (!armed) return;
        armed = false;
        attempts++;
        bool ok;
        (ok,) = address(book).call(abi.encodeCall(BookTakestock.cancel, (victim)));
        reenterOk = reenterOk || ok;
        (ok,) = address(book).call(abi.encodeCall(BookTakestock.poke, (victim)));
        reenterOk = reenterOk || ok;
        Leg[] memory legs = new Leg[](0);
        (ok,) = address(book).call(abi.encodeCall(BookTakestock.fill, (victim, 1, legs, block.timestamp)));
        reenterOk = reenterOk || ok;
        (ok,) = address(router).call(
            abi.encodeCall(RouterTakestock.swap, (address(this), address(giftToken), legs, 0, address(this), block.timestamp))
        );
        reenterOk = reenterOk || ok;
        // A gift of tokenOut to the book mid-swap only adds to what the maker is paid.
        giftToken.transfer(address(book), 7);
        armed = true;
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        _attack();
        return super.transfer(to, a);
    }
}

contract ReviewBookTakestock2Test is BookBase {
    using FixedPointMathLib for uint256;

    uint128 constant DEEP = 1e24;
    uint256 constant FEE_BPS = 100; // max fee, to stress fee rounding
    address keeper = makeAddr("keeper");
    address other = makeAddr("other");
    address stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        book = new BookTakestock(IRouterTakestock(address(router)), FEE_BPS, 0, address(0));
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        nvda.approve(address(book), type(uint256).max);
        meme.approve(address(book), type(uint256).max);
        vm.stopPrank();
        vm.deal(other, 100 ether);
        usdg.mint(other, 1e30);
        vm.prank(other);
        usdg.approve(address(book), type(uint256).max);
    }

    function _exp() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _toUsdg() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(usdg), 500));
    }

    function _toNvda() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(nvda), 500));
    }

    function _placeAs(address who, BookTakestock.Params memory p) internal returns (uint256 id) {
        vm.prank(who);
        id = book.place(p);
    }

    function _fillAmt(uint256 id, uint256 amt, Hop[] memory p) internal returns (uint256) {
        vm.prank(keeper);
        return book.fill(id, amt, _legs(amt, p), block.timestamp);
    }

    // ================================================================== (fixed) dirty feed fields

    /// A feed whose uint80 fields carry high bits used to make abi.decode revert inside _readFeed and block
    /// the limit leg. The book now reads only the answer and timestamp words, so nothing reverts.
    function test_dirtyUint80Feed_doesNotBlockLimitLeg() public {
        RawFeed f = new RawFeed(100e8);
        BookTakestock.Params memory p = _lim(address(usdg), address(nvda), 1_000e6, 900e6, _exp());
        p = _withStop(p, address(f), 50e8, true, 1);
        uint256 id = _placeAs(user, p);
        f.setMode(1);
        assertFalse(book.poke(id)); // price 100 is above the 50 stop: not crossed, and no revert
        assertEq(book.requiredOut(id, 1_000e6), 900e6);
        assertGt(_fillAmt(id, 1_000e6, _toNvda()), 900e6);
    }

    /// Short return data, reverts and negative answers only disable the stop leg.
    function test_shortRevertingNegativeFeed_onlyDisableStop() public {
        RawFeed f = new RawFeed(100e8);
        BookTakestock.Params memory p = _withStop(_lim(address(usdg), address(nvda), 1_000e6, 900e6, _exp()), address(f), 200e8, true, 1);
        uint256[3] memory ids;
        for (uint256 i; i < 3; ++i) ids[i] = _placeAs(user, p);

        f.setMode(2); // short
        assertFalse(book.poke(ids[0]));
        assertGt(_fillAmt(ids[0], 1_000e6, _toNvda()), 900e6);

        f.setMode(4); // revert
        assertFalse(book.poke(ids[1]));
        assertGt(_fillAmt(ids[1], 1_000e6, _toNvda()), 900e6);

        f.setMode(0);
        f.set(-1, block.timestamp); // negative
        assertFalse(book.poke(ids[2]));
        assertFalse(book.getOrder(ids[2]).triggered);
        assertGt(_fillAmt(ids[2], 1_000e6, _toNvda()), 900e6);
    }

    /// Return-data bomb: costs the filler extra gas but cannot block the fill.
    function test_returnDataBombFeed_onlyCostsGas() public {
        RawFeed f = new RawFeed(100e8);
        BookTakestock.Params memory p = _withStop(_lim(address(usdg), address(nvda), 1_000e6, 900e6, _exp()), address(f), 200e8, true, 1);
        uint256 id = _placeAs(user, p);
        f.setMode(3);
        uint256 g = gasleft();
        assertGt(_fillAmt(id, 1_000e6, _toNvda()), 900e6);
        emit log_named_uint("fill gas with 150KB return-data feed", g - gasleft());
    }

    /// Future timestamp / stale answer / zero updatedAt never latch, even when the price is crossed.
    function test_pokeCannotLatchOnBadTimestamps() public {
        vm.warp(1_000_000);
        RawFeed f = new RawFeed(100e8);
        uint256 id = _placeAs(user, _withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(f), 90e8, true, 1));
        f.set(1e8, block.timestamp + 1);
        assertFalse(book.poke(id));
        f.set(1e8, block.timestamp - 1 hours - 1);
        assertFalse(book.poke(id));
        f.set(1e8, 0);
        assertFalse(book.poke(id));
        f.set(1e8, block.timestamp - 1 hours); // exactly maxAge: usable
        assertTrue(book.poke(id));
    }

    /// 63/64 rule: a caller cannot starve the feed read and still have poke/fill return normally
    /// (so the stop leg cannot be selectively hidden, and a false latch is impossible anyway).
    function test_gasStarvedFeed_neverReturnsNormally() public {
        HeavyFeed f = new HeavyFeed(100e8);
        uint256 id = _placeAs(user, _withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(f), 90e8, true, 1));
        f.set(80e8);
        // When the feed is starved, only 1/64 of its cost is left to the caller, which is not enough to
        // finish poke (let alone a fill with a swap). So every gas limit either reverts or latches correctly.
        uint256 reverted;
        for (uint256 g = 60_000; g < 140_000; g += 50) {
            uint256 snap = vm.snapshotState();
            (bool ok, bytes memory ret) = address(book).call{gas: g}(abi.encodeCall(BookTakestock.poke, (id)));
            if (ok) {
                assertTrue(abi.decode(ret, (bool)), "starved read returned normally");
                assertTrue(book.getOrder(id).triggered);
            } else {
                reverted++;
            }
            vm.revertToState(snap);
        }
        assertGt(reverted, 0);
        assertTrue(book.poke(id));
    }

    // ================================================================== (fixed) stale stop floor after a recovery

    /// Before the fix, a latched stop could be filled at its old floor after the price recovered, through a
    /// filler-owned pool. The stop floor now follows Chainlink's fresh price, so that fill is refused.
    function test_latchedStopCannotBeFilledAtOldFloorAfterRecovery() public {
        uint256 amt = 1_000e6;
        uint256 marketNet = (_quote(address(nvda), _toUsdg(), amt) * (10_000 - FEE_BPS)) / 10_000;
        uint256 floor = (marketNet * 95) / 100; // floor at the $90 stop, 5% slippage
        MockFeed feed = new MockFeed(100e8);
        uint256 id = _placeAs(user, _withStop(_lim(address(nvda), address(usdg), amt, 0, _exp()), address(feed), 90e8, true, floor));
        feed.set(89e8);
        assertTrue(book.poke(id));
        feed.set(150e8); // price recovers far above the stop

        (uint256 num, uint256 den) = address(nvda) < address(usdg) ? (956, 1000) : (1000, 956);
        uint160 sqrtP = uint160(FixedPointMathLib.sqrt((num << 192) / den));
        _v4Pool(address(usdg), address(nvda), 100, 1, address(0), sqrtP, 1e15);

        vm.prank(keeper);
        vm.expectRevert();
        book.fill(id, amt, _legs(amt, _path(_hopV4(address(usdg), 100, 1, address(0)))), block.timestamp);
        assertEq(nvda.balanceOf(address(book)), amt, "deposit still escrowed");
    }

    // ================================================================== reentrancy through the route

    function test_evilIntermediateToken_cannotReenter_giftOnlyHelpsMaker() public {
        EvilHop evil = new EvilHop();
        evil.mint(address(this), 1e30);
        evil.approve(address(lp4), type(uint256).max);
        _v4Pool(address(usdg), address(evil), 3000, 60, address(0), PRICE_1_1, 1e21);
        _v4Pool(address(evil), address(nvda), 3000, 60, address(0), PRICE_1_1, 1e21);
        nvda.mint(address(evil), 1e18);

        uint256 victim = _placeAs(other, _lim(address(usdg), address(nvda), 1_000e6, 1, _exp()));
        uint256 id = _placeAs(user, _lim(address(usdg), address(nvda), 1_000e6, 1, _exp()));
        evil.arm(book, router, nvda, victim);

        Hop[] memory route = _path(_hopV4(address(evil), 3000, 60, address(0)), _hopV4(address(nvda), 3000, 60, address(0)));
        uint256 nb = nvda.balanceOf(user);
        uint256 kb = nvda.balanceOf(keeper);
        uint256 got = _fillAmt(id, 1_000e6, route);
        assertGt(evil.attempts(), 0, "hook ran");
        assertFalse(evil.reenterOk(), "reentered");
        assertEq(uint8(book.getOrder(victim).status), uint8(BookTakestock.Status.Open));
        assertEq(usdg.balanceOf(address(book)), 1_000e6, "victim deposit intact");
        assertEq(nvda.balanceOf(address(book)), 0, "no tokenOut left behind");
        assertEq(nvda.balanceOf(user) - nb, got);
        uint256 fee = nvda.balanceOf(keeper) - kb;
        assertEq(fee, ((got + fee) * FEE_BPS) / 10_000, "fee is exactly bps of the measured output");
        assertEq(usdg.allowance(address(book), address(router)), 0, "no lingering approval");
        _assertRouterEmpty();
    }

    // ================================================================== partial fills: invariants

    function testFuzz_partialFillSequence(uint64 a, uint16[8] calldata seeds) public {
        uint256 amountIn = bound(uint256(a), 1e6, 1e15);
        uint256 minOut = (amountIn * 98) / 100;
        uint256 otherDeposit = 777e6;
        _placeAs(other, _lim(address(usdg), address(nvda), otherDeposit, 1, _exp()));
        uint256 id = _placeAs(user, _partial(_lim(address(usdg), address(nvda), amountIn, minOut, _exp())));

        uint256 totalGot;
        uint256 fills;
        for (uint256 i; i < seeds.length; ++i) {
            uint256 rem = book.getOrder(id).remaining;
            if (rem == 0) break;
            uint256 amt = (rem * seeds[i]) / type(uint16).max;
            if (amt == 0) amt = 1;
            bool valid = amt == rem || (amt * 20 >= amountIn && (rem - amt) * 20 >= amountIn);
            if (!valid) {
                vm.prank(keeper);
                vm.expectRevert(BookTakestock.BadAmount.selector);
                book.fill(id, amt, _legs(amt, _toNvda()), block.timestamp);
                continue;
            }
            uint256 need = book.requiredOut(id, amt);
            assertGe(need * amountIn, minOut * amt, "pro-rata floor rounds up");
            uint256 got = _fillAmt(id, amt, _toNvda());
            assertGe(got, need);
            totalGot += got;
            fills++;
            uint256 left = book.getOrder(id).remaining;
            assertTrue(left == 0 || left * 20 >= amountIn, "dust left behind");
        }
        uint256 rem2 = book.getOrder(id).remaining;
        if (rem2 > 0) {
            totalGot += _fillAmt(id, rem2, _toNvda());
            fills++;
        }
        BookTakestock.Order memory o = book.getOrder(id);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Filled));
        assertEq(o.remaining, 0);
        assertEq(o.received, totalGot);
        assertGe(totalGot, minOut, "whole floor");
        assertLe(fills, 20);
        assertEq(usdg.balanceOf(address(book)), otherDeposit, "solvency");
        assertEq(nvda.balanceOf(address(book)), 0);
    }

    /// ETH-out partial fills while other orders escrow ETH: only the swap output is paid out.
    function test_partialEthOut_withOtherEthEscrow() public {
        vm.prank(other);
        uint256 e1 = book.place{value: 3 ether}(_lim(NATIVE, address(meme), 3 ether, 1, _exp()));
        vm.prank(other);
        uint256 e2 = book.place{value: 2 ether}(_lim(NATIVE, address(meme), 2 ether, 1, _exp()));
        uint256 id = _placeAs(user, _partial(_lim(address(meme), NATIVE, 1 ether, 0.9 ether, _exp())));

        uint256 ub = user.balance;
        uint256 g1 = _fillAmt(id, 0.4 ether, _path(_hopV4(NATIVE, 3000, 60, address(0))));
        assertEq(address(book).balance, 5 ether);
        uint256 g2 = _fillAmt(id, 0.6 ether, _path(_hopV4(NATIVE, 3000, 60, address(0))));
        assertEq(address(book).balance, 5 ether);
        assertEq(user.balance - ub, g1 + g2);
        assertGe(g1 + g2, 0.9 ether);

        // ETH-in partial while the other ETH order remains.
        vm.prank(keeper);
        book.fill(e1, 3 ether, _legs(3 ether, _path(_hopV4(address(meme), 3000, 60, address(0)))), block.timestamp);
        assertEq(address(book).balance, 2 ether);
        vm.prank(other);
        book.cancel(e2);
        assertEq(address(book).balance, 0);
    }

    // ================================================================== expiry edge

    function test_expiryEdge_exactTimestamp() public {
        uint64 t = uint64(block.timestamp + 100);
        uint256 a = _placeAs(user, _lim(address(usdg), address(nvda), 1_000e6, 1, t));
        uint256 b = _placeAs(user, _lim(address(usdg), address(nvda), 1_000e6, 1, t));

        vm.warp(t); // still live: fill works, strangers cannot cancel
        vm.prank(stranger);
        vm.expectRevert(BookTakestock.NotMaker.selector);
        book.cancel(a);
        _fillAmt(a, 1_000e6, _toNvda());

        vm.warp(t + 1); // expired: no fill/poke, anyone refunds to maker
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.Expired.selector);
        book.fill(b, 1_000e6, _legs(1_000e6, _toNvda()), block.timestamp);
        vm.expectRevert(BookTakestock.Expired.selector);
        book.poke(b);
        uint256 ub = usdg.balanceOf(user);
        vm.prank(stranger);
        book.cancel(b);
        assertEq(usdg.balanceOf(user) - ub, 1_000e6);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    // ================================================================== misc

    /// ETH pushed to the book through the router (the only sender receive() accepts) is a gift that is
    /// stuck forever; it does not disturb any order's accounting.
    function test_routerCanGiftEthToBook_stuck() public {
        vm.prank(other);
        uint256 e = book.place{value: 1 ether}(_lim(NATIVE, address(meme), 1 ether, 1, _exp()));
        meme.mint(stranger, 1e18);
        vm.startPrank(stranger);
        meme.approve(address(router), type(uint256).max);
        router.swap(address(meme), NATIVE, _legs(0.1 ether, _path(_hopV4(NATIVE, 3000, 60, address(0)))), 0, address(book), block.timestamp);
        vm.stopPrank();
        assertGt(address(book).balance, 1 ether);
        vm.prank(other);
        book.cancel(e);
        assertGt(address(book).balance, 0, "gift has no way out");
        // Direct sends are still rejected.
        vm.prank(stranger);
        vm.deal(stranger, 1 ether);
        (bool ok,) = address(book).call{value: 1}("");
        assertFalse(ok);
    }

    /// tokenOut is never validated: an order to a non-contract can never fill, only be cancelled.
    function test_tokenOutNotContract_unfillableButRefundable() public {
        uint256 id = _placeAs(user, _lim(address(usdg), address(0xdead), 1_000e6, 1, _exp()));
        vm.prank(keeper);
        vm.expectRevert();
        book.fill(id, 1_000e6, _legs(1_000e6, _toNvda()), block.timestamp);
        vm.prank(user);
        book.cancel(id);
        assertEq(usdg.balanceOf(address(book)), 0);
    }

    /// The router's minimum is the maker's floor grossed up for the fee, so a swap that cannot pay the floor after
    /// the fee fails inside the router.
    function test_routerMinIsPreFee_bookCheckBinds() public {
        uint256 q = _quote(address(usdg), _toNvda(), 1_000e6);
        // Floor between q*(1-fee) and q: router would accept, book must reject.
        uint256 floor = (q * (10_000 - FEE_BPS / 2)) / 10_000;
        uint256 id = _placeAs(user, _lim(address(usdg), address(nvda), 1_000e6, floor, _exp()));
        vm.prank(keeper);
        vm.expectRevert(); // the router's grossed-up minimum refuses it before the book has to
        book.fill(id, 1_000e6, _legs(1_000e6, _toNvda()), block.timestamp);
    }
}
