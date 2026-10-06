// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookBase, MockFeed, GasBombFeed} from "./BookBase.t.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {Hop, Leg} from "../src/RouteTypes.sol";

/// Stop-loss, stop-buy, take-profit + stop (bracket) and partial fills.
contract BookTakestockAdvancedTest is BookBase {
    uint128 constant DEEP = 1e24;
    uint256 constant FEE_BPS = 10;
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    MockFeed feed;

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        book = new BookTakestock(IRouterTakestock(address(router)), FEE_BPS, 0, address(0));
        feed = new MockFeed(100e8); // NVDA at $100
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        nvda.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _toUsdg() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(usdg), 500));
    }

    function _toNvda() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(nvda), 500));
    }

    function _exp() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    /// What the maker would get for selling `amt` NVDA right now, after the filler fee.
    function _netSell(uint256 amt) internal returns (uint256) {
        return (_quote(address(nvda), _toUsdg(), amt) * (10_000 - FEE_BPS)) / 10_000;
    }

    function _placeAs(BookTakestock.Params memory p) internal returns (uint256 id) {
        vm.prank(user);
        id = book.place(p);
    }

    function _fillAmt(uint256 id, uint256 amt, Hop[] memory p) internal returns (uint256) {
        vm.prank(keeper);
        return book.fill(id, amt, _legs(amt, p), block.timestamp);
    }

    // ------------------------------------------------------------------ placing stops

    function test_place_stopValidation() public {
        BookTakestock.Params memory p = _lim(address(nvda), address(usdg), 1_000e6, 0, _exp());
        vm.startPrank(user);
        // No leg at all.
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(p);
        // Stop without price / floor / sane max age.
        BookTakestock.Params memory s = _withStop(p, address(feed), 0, true, 1);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        s = _withStop(p, address(feed), 90e8, true, 0);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        s = _withStop(p, address(feed), 90e8, true, 1);
        s.maxAge = 59;
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        s.maxAge = 7 days + 1;
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        // Feed that is not a contract, or is down.
        s = _withStop(p, address(0xBEEF), 90e8, true, 1);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        vm.stopPrank();
        feed.breakIt(true);
        s = _withStop(p, address(feed), 90e8, true, 1);
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(s);
        feed.breakIt(false);
        // Stop fields set without a feed.
        BookTakestock.Params memory q = _lim(address(nvda), address(usdg), 1_000e6, 1, _exp());
        q.stopMinOut = 1;
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(q);
    }

    // ------------------------------------------------------------------ stop-loss

    function test_stopLoss_waitsForTrigger_thenSellsAboveFloor() public {
        uint256 floor = (_netSell(1_000e6) * 99) / 100; // 1% slippage floor
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, floor));

        // Price above the stop: nothing can fill it.
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotTriggered.selector);
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        (bool usable,,,) = book.stopState(id);
        assertFalse(usable);
        assertEq(book.requiredOut(id, 1_000e6), type(uint256).max);

        // Price falls through the stop.
        feed.set(89e8);
        (usable,,,) = book.stopState(id);
        assertTrue(usable);
        uint256 before = usdg.balanceOf(user);
        uint256 got = _fillAmt(id, 1_000e6, _toUsdg());
        assertGe(got, floor);
        assertEq(usdg.balanceOf(user) - before, got);
        BookTakestock.Order memory o = book.getOrder(id);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Filled));
        assertTrue(o.triggered);
        assertEq(o.received, got);
        assertEq(nvda.balanceOf(address(book)), 0);
        _assertRouterEmpty();
    }

    function test_stopLoss_exactlyAtStopPriceTriggers() public {
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, 1));
        feed.set(90e8);
        assertGt(_fillAmt(id, 1_000e6, _toUsdg()), 0);
    }

    function test_stopLoss_floorStillEnforced() public {
        // Triggered, but the pools pay less than the maker's floor: no fill.
        uint256 floor = (_netSell(1_000e6) * 1001) / 1000;
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, floor));
        feed.set(90e8); // at the stop price the floor is exactly stopMinOut
        vm.prank(keeper);
        vm.expectRevert();
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        assertEq(nvda.balanceOf(address(book)), 1_000e6);
    }

    function test_stop_staleOrFutureAnswerDoesNotTrigger() public {
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, 1));
        vm.warp(block.timestamp + 3 hours);
        feed.setAt(50e8, block.timestamp - 2 hours); // maxAge is 1 hour
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotTriggered.selector);
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        feed.setAt(50e8, block.timestamp + 1); // timestamp from the future
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotTriggered.selector);
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        feed.setAt(0, block.timestamp); // non-positive answer
        assertFalse(book.poke(id));
        feed.set(50e8);
        assertTrue(book.poke(id));
    }

    function test_stop_latchesOnPoke_evenIfPriceRecovers() public {
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, 1));
        assertFalse(book.poke(id));
        feed.set(85e8);
        vm.expectEmit(true, false, false, true);
        emit BookTakestock.Triggered(id, 85e8, block.timestamp);
        assertTrue(book.poke(id));
        feed.set(120e8); // bounced back
        (bool usable, bool latched,,) = book.stopState(id);
        assertTrue(usable);
        assertTrue(latched);
        assertGt(_fillAmt(id, 1_000e6, _toUsdg()), 0);
    }

    function test_stop_brokenFeedOnlyBlocksStopLeg() public {
        // Bracket: limit leg reachable, stop leg's feed goes down. The limit leg still fills.
        uint256 tp = _netSell(1_000e6);
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()), address(feed), 90e8, true, 1));
        feed.breakIt(true);
        (bool usable,,,) = book.stopState(id);
        assertFalse(usable);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), tp);
    }

    function test_stop_gasBombFeedCannotBlockFillsOrRefunds() public {
        uint256 tp = _netSell(1_000e6);
        uint256 id = _placeAs(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()));
        // A maker could only point a bad feed at their own order; prove the book survives it anyway.
        GasBombFeed bomb = new GasBombFeed();
        BookTakestock.Params memory p = _withStop(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()), address(feed), 90e8, true, 1);
        uint256 id2 = _placeAs(p);
        vm.etch(address(feed), address(bomb).code);
        assertGe(_fillAmt(id2, 1_000e6, _toUsdg()), tp);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), tp);
    }

    // ------------------------------------------------------------------ stop-buy

    function test_stopBuy_triggersOnRise() public {
        uint256 id = _placeAs(_withStop(_lim(address(usdg), address(nvda), 1_000e6, 0, _exp()), address(feed), 110e8, false, 1));
        feed.set(105e8);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotTriggered.selector);
        book.fill(id, 1_000e6, _legs(1_000e6, _toNvda()), block.timestamp);
        feed.set(111e8);
        uint256 before = nvda.balanceOf(user);
        uint256 got = _fillAmt(id, 1_000e6, _toNvda());
        assertEq(nvda.balanceOf(user) - before, got);
    }

    // ------------------------------------------------------------------ bracket

    function test_bracket_takeProfitFillsWithoutTrigger() public {
        uint256 tp = _netSell(1_000e6);
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()), address(feed), 90e8, true, 1));
        assertEq(book.requiredOut(id, 1_000e6), tp);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), tp);
        assertFalse(book.getOrder(id).triggered);
    }

    function test_bracket_unreachableTP_fillsOnStop() public {
        uint256 net = _netSell(1_000e6);
        uint256 tp = net * 2; // far above the market
        uint256 floor = (net * 98) / 100;
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()), address(feed), 90e8, true, floor));
        vm.prank(keeper);
        vm.expectRevert(); // only the limit leg holds and the pools cannot pay it
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        feed.set(80e8);
        // The stop floor follows Chainlink: 80/90 of the floor set at the stop price.
        uint256 scaled = (floor * 80e8 + 90e8 - 1) / 90e8;
        assertEq(book.requiredOut(id, 1_000e6), scaled);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), scaled);
    }

    // ------------------------------------------------------------------ partial fills

    function test_partial_onlyWhenAllowed() public {
        uint256 id = _placeAs(_lim(address(usdg), address(nvda), 1_000e6, 1, _exp()));
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 400e6, _legs(400e6, _toNvda()), block.timestamp);
    }

    function test_partial_proRataFloor_andRemainder() public {
        uint256 net = (_quote(address(usdg), _toNvda(), 1_000e6) * (10_000 - FEE_BPS)) / 10_000;
        uint256 minOut = (net * 99) / 100;
        uint256 id = _placeAs(_partial(_lim(address(usdg), address(nvda), 1_000e6, minOut, _exp())));

        // Too small a part, or one that leaves dust, is refused.
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 40e6, _legs(40e6, _toNvda()), block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 970e6, _legs(970e6, _toNvda()), block.timestamp);
        assertEq(book.requiredOut(id, 400e6), (minOut * 400e6 + 1_000e6 - 1) / 1_000e6);

        uint256 a = _fillAmt(id, 400e6, _toNvda());
        BookTakestock.Order memory o = book.getOrder(id);
        assertEq(o.remaining, 600e6);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Open));
        assertGe(a * 1_000e6, minOut * 400e6);

        uint256 b = _fillAmt(id, 600e6, _toNvda());
        o = book.getOrder(id);
        assertEq(o.remaining, 0);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Filled));
        assertEq(o.received, a + b);
        assertGe(a + b, minOut);
        assertEq(usdg.balanceOf(address(book)), 0);
    }

    function test_partial_cancelRefundsOnlyTheRest() public {
        uint256 id = _placeAs(_partial(_lim(address(usdg), address(nvda), 1_000e6, 1, _exp())));
        _fillAmt(id, 250e6, _toNvda());
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        book.cancel(id);
        assertEq(usdg.balanceOf(user) - before, 750e6);
        assertEq(usdg.balanceOf(address(book)), 0);
        BookTakestock.Order memory o = book.getOrder(id);
        assertEq(o.remaining, 0);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Cancelled));
    }

    function test_partial_afterExpiry_strangerRefundsRestToMaker() public {
        uint256 id = _placeAs(_partial(_lim(address(usdg), address(nvda), 1_000e6, 1, _exp())));
        _fillAmt(id, 500e6, _toNvda());
        vm.warp(block.timestamp + 1 days + 1);
        uint256 before = usdg.balanceOf(user);
        vm.prank(stranger);
        book.cancel(id);
        assertEq(usdg.balanceOf(user) - before, 500e6);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    function test_partial_stopLossInParts() public {
        uint256 id = _placeAs(_partial(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, 1)));
        feed.set(85e8);
        _fillAmt(id, 500e6, _toUsdg());
        feed.set(120e8); // recovered, but the stop latched on the first fill
        _fillAmt(id, 500e6, _toUsdg());
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Filled));
    }

    function testFuzz_partialFillsNeverBelowProRata(uint96 a, uint16 split, uint16 slack) public {
        uint256 amt = bound(uint256(a), 100e6, 50_000e6);
        uint256 net = (_quote(address(usdg), _toNvda(), amt) * (10_000 - FEE_BPS)) / 10_000;
        uint256 minOut = (net * (10_000 - bound(uint256(slack), 50, 500))) / 10_000;
        if (minOut == 0) return;
        uint256 id = _placeAs(_partial(_lim(address(usdg), address(nvda), amt, minOut, _exp())));
        uint256 first = (amt * bound(uint256(split), 600, 9_400)) / 10_000;
        uint256 before = nvda.balanceOf(user);
        _fillAmt(id, first, _toNvda());
        _fillAmt(id, amt - first, _toNvda());
        assertGe(nvda.balanceOf(user) - before, minOut);
        assertEq(usdg.balanceOf(address(book)), 0);
    }

    // ------------------------------------------------------------------ misc

    function test_constructor_rejectsNonContractRouter() public {
        vm.expectRevert(BookTakestock.BadOrder.selector);
        new BookTakestock(IRouterTakestock(address(0xdead)), 10, 0, address(0));
    }

    function test_fill_zeroOrTooMuch() public {
        uint256 id = _placeAs(_partial(_lim(address(usdg), address(nvda), 1_000e6, 1, _exp())));
        Leg[] memory none = new Leg[](0);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 0, none, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 1_001e6, _legs(1_001e6, _toNvda()), block.timestamp);
    }

    // ------------------------------------------------------------------ stop floor follows Chainlink

    function test_stopFloor_risesWhenPriceRecovers_noStaleFloorFill() public {
        // Floor set at the stop price ($90) with 2% slippage, as the app does: value of 1,000 at $90, less 2%.
        uint256 atStop = (_netSell(1_000e6) * 90) / 100; // pools pay ~$100 now; a $90 fill would be ~90% of that
        uint256 floor = (atStop * 98) / 100;
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, floor));
        feed.set(85e8);
        assertTrue(book.poke(id)); // latched on a dip
        feed.set(150e8); // recovered far above the pools' price
        // The floor is now 150/90 of the original, above what the pools pay: no filler can sell at the old floor.
        assertEq(book.requiredOut(id, 1_000e6), (floor * 150e8 + 90e8 - 1) / 90e8);
        vm.prank(keeper);
        vm.expectRevert();
        book.fill(id, 1_000e6, _legs(1_000e6, _toUsdg()), block.timestamp);
        // Back at the market ($100): fillable, and the maker gets the market less at most the slippage.
        feed.set(100e8);
        uint256 got = _fillAmt(id, 1_000e6, _toUsdg());
        assertGe(got, (floor * 100e8) / 90e8);
    }

    function test_stopFloor_staleAtFillUsesFloorAtStop() public {
        uint256 floor = (_netSell(1_000e6) * 90) / 100;
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, 0, _exp()), address(feed), 90e8, true, floor));
        feed.set(80e8);
        assertTrue(book.poke(id));
        vm.warp(block.timestamp + 2 hours); // answer now older than maxAge (1h)
        assertEq(book.requiredOut(id, 1_000e6), floor);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), floor);
    }

    function test_stopBuy_floorScalesInversely() public {
        uint256 id = _placeAs(_withStop(_lim(address(usdg), address(nvda), 1_000e6, 0, _exp()), address(feed), 110e8, false, 1_000));
        feed.set(220e8); // twice the stop price: the stock costs double, so the floor halves
        assertEq(book.requiredOut(id, 1_000e6), (uint256(1_000) * 110e8 + 220e8 - 1) / 220e8);
    }

    function test_feed_hugeAnswerIsNoPrice() public {
        uint256 tp = _netSell(1_000e6);
        uint256 id = _placeAs(_withStop(_lim(address(nvda), address(usdg), 1_000e6, tp, _exp()), address(feed), 90e8, true, 1));
        feed.set(int256(uint256(type(uint128).max) + 1));
        (bool usable,,,) = book.stopState(id);
        assertFalse(usable);
        assertGe(_fillAmt(id, 1_000e6, _toUsdg()), tp); // the limit leg still works
    }
}
