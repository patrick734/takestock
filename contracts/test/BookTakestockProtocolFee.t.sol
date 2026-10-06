// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookBase, MockFeed} from "./BookBase.t.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {NATIVE, Hop, Leg} from "../src/RouteTypes.sol";

/// Has no receive function, so it rejects ETH, like BuyBurnTakestock.
contract RefusingSink {}

/// The protocol fee: a fixed share of every fill's output goes to the immutable fee sink (BuyBurnTakestock).
contract BookTakestockProtocolFeeTest is BookBase {
    uint128 constant DEEP = 1e24;
    uint256 constant FILLER_BPS = 5; // 0.05%
    uint256 constant PROTOCOL_BPS = 25; // 0.25%
    address keeper = makeAddr("keeper");
    address sink = makeAddr("buyBurn");

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        book = new BookTakestock(IRouterTakestock(address(router)), FILLER_BPS, PROTOCOL_BPS, sink);
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        nvda.approve(address(book), type(uint256).max);
        meme.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _p500() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(nvda), 500));
    }

    function _fill(uint256 id, Leg[] memory legs) internal returns (uint256) {
        vm.prank(keeper);
        return _fillRaw(id, legs);
    }

    function test_constructor_wiresFees() public view {
        assertEq(book.fillerFeeBps(), FILLER_BPS);
        assertEq(book.protocolFeeBps(), PROTOCOL_BPS);
        assertEq(book.feeSink(), sink);
        assertEq(book.feeBpsFor(address(nvda)), FILLER_BPS + PROTOCOL_BPS);
        assertEq(book.feeBpsFor(NATIVE), FILLER_BPS);
    }

    function test_constructor_capsTheSum() public {
        vm.expectRevert(BookTakestock.FeeTooHigh.selector);
        new BookTakestock(IRouterTakestock(address(router)), 50, 51, sink);
        new BookTakestock(IRouterTakestock(address(router)), 50, 50, sink);
    }

    function test_constructor_needsASinkForAProtocolFee() public {
        vm.expectRevert(BookTakestock.BadOrder.selector);
        new BookTakestock(IRouterTakestock(address(router)), 5, 25, address(0));
        BookTakestock none = new BookTakestock(IRouterTakestock(address(router)), 5, 0, address(0));
        assertEq(none.protocolFeeBps(), 0);
    }

    function test_fill_splitsOutputBetweenMakerFillerAndSink() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint128 minOut = uint128((q * (10_000 - FILLER_BPS - PROTOCOL_BPS)) / 10_000);
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), 1_000e6, minOut, uint64(block.timestamp + 1 days)));

        uint256 userBefore = nvda.balanceOf(user);
        vm.expectEmit(true, true, false, true, address(book));
        emit BookTakestock.ProtocolFee(id, address(nvda), (q * PROTOCOL_BPS) / 10_000);
        uint256 makerGets = _fill(id, _legs(1_000e6, p));

        uint256 fillerFee = (q * FILLER_BPS) / 10_000;
        uint256 protocolFee = (q * PROTOCOL_BPS) / 10_000;
        assertEq(nvda.balanceOf(keeper), fillerFee);
        assertEq(nvda.balanceOf(sink), protocolFee);
        assertEq(makerGets, q - fillerFee - protocolFee);
        assertEq(nvda.balanceOf(user) - userBefore, makerGets);
        assertGe(makerGets, minOut);
        assertEq(nvda.balanceOf(address(book)), 0, "book kept output");
        _assertRouterEmpty();
    }

    function test_fill_limitIsNetOfBothFees() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        // One unit above what is reachable after both fees: the fill must revert.
        uint128 minOut = uint128((q * (10_000 - FILLER_BPS - PROTOCOL_BPS)) / 10_000 + 2);
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), 1_000e6, minOut, uint64(block.timestamp + 1 days)));
        Leg[] memory legs = _legs(1_000e6, p);
        vm.prank(keeper);
        vm.expectRevert();
        book.fill(id, 1_000e6, legs, block.timestamp);
        assertEq(nvda.balanceOf(sink), 0);
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Open));
    }

    function test_fill_stopLeg_paysTheSink() public {
        MockFeed feed = new MockFeed(100e8);
        Hop[] memory back = _path(_hopV3(address(usdg), 500));
        vm.prank(user);
        uint256 id = book.place(
            _withStop(_lim(address(nvda), address(usdg), 10e18, 0, uint64(block.timestamp + 1 days)), address(feed), 90e8, true, 1)
        );
        feed.set(89e8);
        uint256 q = _quote(address(nvda), back, 10e18);
        _fill(id, _legs(10e18, back));
        assertEq(usdg.balanceOf(sink), (q * PROTOCOL_BPS) / 10_000);
    }

    function test_partialFills_eachPayTheirShare() public {
        Hop[] memory p = _p500();
        vm.prank(user);
        uint256 id = book.place(_partial(_lim(address(usdg), address(nvda), 1_000e6, 1, uint64(block.timestamp + 1 days))));
        uint256 q1 = _quote(address(usdg), p, 400e6);
        _fill(id, _legs(400e6, p));
        uint256 afterFirst = nvda.balanceOf(sink);
        assertEq(afterFirst, (q1 * PROTOCOL_BPS) / 10_000);
        uint256 q2 = _quote(address(usdg), p, 600e6);
        _fill(id, _legs(600e6, p));
        assertEq(nvda.balanceOf(sink) - afterFirst, (q2 * PROTOCOL_BPS) / 10_000);
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Filled));
    }

    function test_tokenRefusingTheSink_feeGoesToMaker_fillStillWorks() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), 1_000e6, 1, uint64(block.timestamp + 1 days)));
        // Any transfer of NVDA to the sink reverts (a blocklisted or restricted recipient).
        vm.mockCallRevert(address(nvda), abi.encodeWithSelector(0xa9059cbb, sink), "blocked");
        uint256 before = nvda.balanceOf(user);
        uint256 makerGets = _fill(id, _legs(1_000e6, p));
        uint256 fillerFee = (q * FILLER_BPS) / 10_000;
        assertEq(makerGets, q - fillerFee, "maker gets the protocol share too");
        assertEq(nvda.balanceOf(user) - before, makerGets);
        assertEq(nvda.balanceOf(sink), 0);
        assertEq(nvda.balanceOf(address(book)), 0, "nothing left in the book");
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Filled));
    }

    function test_tokenReturningFalseToTheSink_feeGoesToMaker() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), 1_000e6, 1, uint64(block.timestamp + 1 days)));
        vm.mockCall(address(nvda), abi.encodeWithSelector(0xa9059cbb, sink), abi.encode(false));
        uint256 makerGets = _fill(id, _legs(1_000e6, p));
        assertEq(makerGets, q - (q * FILLER_BPS) / 10_000);
        assertEq(nvda.balanceOf(address(book)), 0);
    }

    function test_nativeOutput_paysNoProtocolFee() public {
        vm.prank(user);
        uint256 id = book.place(_lim(address(meme), NATIVE, 1 ether, 1, uint64(block.timestamp + 1 days)));
        uint256 sinkBefore = sink.balance;
        uint256 keeperBefore = keeper.balance;
        uint256 userBefore = user.balance;
        uint256 got = _fill(id, _legs(1 ether, _path(_hopV4(NATIVE, 3000, 60, address(0)))));
        assertEq(sink.balance, sinkBefore, "no ETH to the sink");
        uint256 fillerFee = keeper.balance - keeperBefore;
        assertEq(user.balance - userBefore, got);
        // Only the filler's share was taken.
        assertEq(fillerFee, ((got + fillerFee) * FILLER_BPS) / 10_000);
    }

    function test_cancelAndExpiryRefund_payNoFee() public {
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), 1_000e6, 1, uint64(block.timestamp + 1 days)));
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        book.cancel(id);
        assertEq(usdg.balanceOf(user) - before, 1_000e6);
        assertEq(usdg.balanceOf(sink), 0);
        assertEq(nvda.balanceOf(sink), 0);
    }

    function test_nativeOutput_neverTouchesASinkThatRejectsETH() public {
        RefusingSink bad = new RefusingSink();
        book = new BookTakestock(IRouterTakestock(address(router)), FILLER_BPS, PROTOCOL_BPS, address(bad));
        vm.startPrank(user);
        meme.approve(address(book), type(uint256).max);
        uint256 id = book.place(_lim(address(meme), NATIVE, 1 ether, 1, uint64(block.timestamp + 1 days)));
        vm.stopPrank();
        // Native output skips the sink entirely, so even a sink that refuses everything cannot block it.
        _fill(id, _legs(1 ether, _path(_hopV4(NATIVE, 3000, 60, address(0)))));
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Filled));
    }

    function testFuzz_feesNeverExceedTheirShare(uint96 amount) public {
        amount = uint96(bound(amount, 1e6, 100_000e6));
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, amount);
        vm.assume(q > 0);
        vm.prank(user);
        uint256 id = book.place(_lim(address(usdg), address(nvda), amount, 1, uint64(block.timestamp + 1 days)));
        uint256 makerGets = _fill(id, _legs(amount, p));
        uint256 toSink = nvda.balanceOf(sink);
        uint256 toKeeper = nvda.balanceOf(keeper);
        assertEq(makerGets + toSink + toKeeper, q, "every unit accounted for");
        assertLe(toSink * 10_000, q * PROTOCOL_BPS);
        assertLe(toKeeper * 10_000, q * FILLER_BPS);
    }
}

/// placeMany: a ladder of exits in one transaction.
contract BookTakestockLadderTest is BookBase {
    uint128 constant DEEP = 1e24;
    address keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        book = new BookTakestock(IRouterTakestock(address(router)), 5, 25, makeAddr("sink"));
        vm.startPrank(user);
        nvda.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _ladder() internal view returns (BookTakestock.Params[] memory ps) {
        uint64 exp = uint64(block.timestamp + 7 days);
        ps = new BookTakestock.Params[](3);
        ps[0] = _lim(address(nvda), address(usdg), 3e18, 3.3e18, exp); // +10%
        ps[1] = _lim(address(nvda), address(usdg), 3e18, 3.6e18, exp); // +20%
        ps[2] = _lim(address(nvda), address(usdg), 4e18, 4.8e18, exp); // +20% on the rest
    }

    function test_placeMany_escrowsEachAndReturnsIds() public {
        uint256 before = nvda.balanceOf(user);
        vm.prank(user);
        uint256[] memory ids = book.placeMany(_ladder());
        assertEq(ids.length, 3);
        assertEq(ids[0], 0);
        assertEq(ids[2], 2);
        assertEq(before - nvda.balanceOf(user), 10e18);
        assertEq(nvda.balanceOf(address(book)), 10e18);
        assertEq(book.getOrder(1).minAmountOut, 3.6e18);
        assertEq(book.orderIdsOf(user).length, 3);
    }

    function test_placeMany_ordersAreIndependent() public {
        vm.prank(user);
        uint256[] memory ids = book.placeMany(_ladder());
        vm.prank(user);
        book.cancel(ids[1]);
        assertEq(uint8(book.getOrder(ids[0]).status), uint8(BookTakestock.Status.Open));
        assertEq(uint8(book.getOrder(ids[2]).status), uint8(BookTakestock.Status.Open));
        assertEq(nvda.balanceOf(address(book)), 7e18);
    }

    function test_placeMany_rejectsEmptyAndTooMany() public {
        BookTakestock.Params[] memory none = new BookTakestock.Params[](0);
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.placeMany(none);
        BookTakestock.Params[] memory many = new BookTakestock.Params[](11);
        for (uint256 i; i < 11; ++i) many[i] = _lim(address(nvda), address(usdg), 1e18, 1, uint64(block.timestamp + 1 days));
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.placeMany(many);
    }

    function test_placeMany_oneBadOrderRevertsAll() public {
        BookTakestock.Params[] memory ps = _ladder();
        ps[2].minAmountOut = 0; // no exit condition at all
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.placeMany(ps);
        assertEq(book.orderCount(), 0);
        assertEq(nvda.balanceOf(address(book)), 0);
    }

    function test_placeMany_nativeValueMustMatchExactly() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        BookTakestock.Params[] memory ps = new BookTakestock.Params[](2);
        ps[0] = _lim(NATIVE, address(meme), 1 ether, 1, exp);
        ps[1] = _lim(NATIVE, address(meme), 2 ether, 1, exp);
        vm.deal(user, 10 ether);
        vm.startPrank(user);
        vm.expectRevert(BookTakestock.BadValue.selector);
        book.placeMany{value: 2 ether}(ps);
        vm.expectRevert(BookTakestock.BadValue.selector);
        book.placeMany{value: 4 ether}(ps);
        book.placeMany{value: 3 ether}(ps);
        vm.stopPrank();
        assertEq(address(book).balance, 3 ether);
    }

    function test_placeMany_mixedNativeAndToken() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        BookTakestock.Params[] memory ps = new BookTakestock.Params[](2);
        ps[0] = _lim(NATIVE, address(meme), 1 ether, 1, exp);
        ps[1] = _lim(address(nvda), address(usdg), 1e18, 1, exp);
        vm.deal(user, 1 ether);
        vm.prank(user);
        book.placeMany{value: 1 ether}(ps);
        assertEq(address(book).balance, 1 ether);
        assertEq(nvda.balanceOf(address(book)), 1e18);
    }

    function test_placeMany_ladderFillsStepByStep() public {
        vm.prank(user);
        uint256[] memory ids = book.placeMany(_ladder());
        Hop[] memory p = _path(_hopV3(address(usdg), 500));
        // The pool trades 1:1, so 3 NVDA yields under 3 USDG: below the +10% target, not fillable.
        vm.prank(keeper);
        vm.expectRevert();
        book.fill(ids[0], 3e18, _legs(3e18, p), block.timestamp);
        assertEq(uint8(book.getOrder(ids[0]).status), uint8(BookTakestock.Status.Open));
    }
}
