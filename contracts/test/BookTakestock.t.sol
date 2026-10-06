// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TaxToken} from "./Base.t.sol";
import {BookBase} from "./BookBase.t.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {NATIVE, Hop, Leg} from "../src/RouteTypes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

contract BookTakestockTest is BookBase {
    uint128 constant DEEP = 1e24;
    address keeper = makeAddr("keeper");
    address stranger = makeAddr("stranger");
    uint256 constant FEE_BPS = 10; // 0.10%

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        _v3Pool(address(usdg), address(nvda), 3000, PRICE_1_1, DEEP / 4);
        _v4Pool(address(usdg), address(nvda), 3000, 60, address(0), PRICE_1_1, int256(uint256(DEEP / 2)));
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        book = new BookTakestock(IRouterTakestock(address(router)), FEE_BPS, 0, address(0));
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        nvda.approve(address(book), type(uint256).max);
        meme.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _p500() internal view returns (Hop[] memory) {
        return _path(_hopV3(address(nvda), 500));
    }

    function _place(uint128 amountIn, uint128 minOut) internal returns (uint256 id) {
        vm.prank(user);
        id = book.place(_lim(address(usdg), address(nvda), amountIn, minOut, uint64(block.timestamp + 1 days)));
    }

    function _fill(uint256 id, Leg[] memory legs) internal returns (uint256) {
        vm.prank(keeper);
        return _fillRaw(id, legs);
    }

    // ------------------------------------------------------------------ place / cancel

    function test_place_escrowsExactly() public {
        uint256 before = usdg.balanceOf(user);
        uint256 id = _place(1_000e6, 900e6);
        assertEq(id, 0);
        assertEq(usdg.balanceOf(address(book)), 1_000e6);
        assertEq(before - usdg.balanceOf(user), 1_000e6);
        BookTakestock.Order memory o = book.getOrder(id);
        assertEq(o.maker, user);
        assertEq(uint8(o.status), uint8(BookTakestock.Status.Open));
        assertEq(book.orderIdsOf(user).length, 1);
        assertEq(book.orderCount(), 1);
    }

    function test_place_rejectsBadInput() public {
        vm.startPrank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(_lim(address(usdg), address(usdg), 1, 1, uint64(block.timestamp + 1)));
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(_lim(address(usdg), address(nvda), 0, 1, uint64(block.timestamp + 1)));
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(_lim(address(usdg), address(nvda), 1, 0, uint64(block.timestamp + 1)));
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(_lim(address(usdg), address(nvda), 1, 1, uint64(block.timestamp)));
        vm.expectRevert(BookTakestock.BadValue.selector);
        book.place{value: 1}(_lim(address(usdg), address(nvda), 1, 1, uint64(block.timestamp + 1)));
        vm.expectRevert(BookTakestock.BadValue.selector);
        book.place{value: 1}(_lim(NATIVE, address(meme), 2, 1, uint64(block.timestamp + 1)));
        vm.stopPrank();
    }

    function test_place_rejectsFeeOnTransfer() public {
        TaxToken tax = new TaxToken();
        tax.mint(user, 1e24);
        vm.startPrank(user);
        tax.approve(address(book), type(uint256).max);
        vm.expectRevert(BookTakestock.InputNotReceived.selector);
        book.place(_lim(address(tax), address(nvda), 1e18, 1, uint64(block.timestamp + 1)));
        vm.stopPrank();
    }

    function test_cancel_byMakerRefunds() public {
        uint256 id = _place(1_000e6, 900e6);
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        book.cancel(id);
        assertEq(usdg.balanceOf(user) - before, 1_000e6);
        assertEq(usdg.balanceOf(address(book)), 0);
        vm.prank(user);
        vm.expectRevert(BookTakestock.NotOpen.selector);
        book.cancel(id);
    }

    function test_cancel_strangerOnlyAfterExpiry_refundGoesToMaker() public {
        uint256 id = _place(1_000e6, 900e6);
        vm.prank(stranger);
        vm.expectRevert(BookTakestock.NotMaker.selector);
        book.cancel(id);
        vm.warp(block.timestamp + 1 days + 1);
        uint256 before = usdg.balanceOf(user);
        vm.prank(stranger);
        book.cancel(id);
        assertEq(usdg.balanceOf(user) - before, 1_000e6);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    // ------------------------------------------------------------------ fill

    function test_fill_paysMakerAtLeastLimit_andFillerFee() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        uint128 minOut = uint128((q * (10_000 - FEE_BPS)) / 10_000); // exactly reachable after fee
        uint256 id = _place(1_000e6, minOut);
        uint256 before = nvda.balanceOf(user);
        uint256 makerGets = _fill(id, _legs(1_000e6, p));
        uint256 fee = q - makerGets;
        assertGe(makerGets, minOut);
        assertEq(nvda.balanceOf(user) - before, makerGets);
        assertEq(nvda.balanceOf(keeper), fee);
        assertEq(fee, (q * FEE_BPS) / 10_000);
        assertEq(usdg.balanceOf(address(book)), 0, "book kept input");
        assertEq(nvda.balanceOf(address(book)), 0, "book kept output");
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Filled));
        _assertRouterEmpty();
    }

    function test_fill_splitAcrossVenues() public {
        uint256 id = _place(100_000e6, 1);
        Leg[] memory legs = new Leg[](3);
        legs[0] = Leg(60_000e6, _p500());
        legs[1] = Leg(20_000e6, _path(_hopV3(address(nvda), 3000)));
        legs[2] = Leg(20_000e6, _path(_hopV4(address(nvda), 3000, 60, address(0))));
        uint256 makerGets = _fill(id, legs);
        assertGt(makerGets, 0);
        assertEq(usdg.balanceOf(address(book)), 0);
        assertEq(nvda.balanceOf(address(book)), 0);
    }

    function test_fill_belowLimitReverts() public {
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, 1_000e6);
        // Limit reachable before the fee but not after it: must not fill.
        uint256 id = _place(1_000e6, uint128(q));
        vm.prank(keeper);
        vm.expectRevert();
        _fillRaw(id, _legs(1_000e6, p));
        // Limit above what the pools pay: the router itself refuses.
        uint256 id2 = _place(1_000e6, uint128(q * 2));
        vm.prank(keeper);
        vm.expectRevert();
        _fillRaw(id2, _legs(1_000e6, p));
        // Both deposits still there and still open.
        assertEq(usdg.balanceOf(address(book)), 2_000e6);
        assertEq(uint8(book.getOrder(id).status), uint8(BookTakestock.Status.Open));
    }

    function test_fill_legsMustSumToAmount() public {
        uint256 id = _place(1_000e6, 1);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        book.fill(id, 1_000e6, _legs(999e6, _p500()), block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.BadAmount.selector);
        _fillRaw(id, _legs(1_001e6, _p500()));
    }

    function test_fill_onlyOnce_andNotAfterCancelOrExpiry() public {
        uint256 id = _place(1_000e6, 1);
        _fill(id, _legs(1_000e6, _p500()));
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotOpen.selector);
        _fillRaw(id, _legs(1_000e6, _p500()));
        vm.prank(user);
        vm.expectRevert(BookTakestock.NotOpen.selector);
        book.cancel(id);

        uint256 id2 = _place(1_000e6, 1);
        vm.prank(user);
        book.cancel(id2);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.NotOpen.selector);
        _fillRaw(id2, _legs(1_000e6, _p500()));

        uint256 id3 = _place(1_000e6, 1);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(keeper);
        vm.expectRevert(BookTakestock.Expired.selector);
        _fillRaw(id3, _legs(1_000e6, _p500()));
    }

    function test_fill_doesNotTouchOtherOrders() public {
        uint256 a = _place(1_000e6, 1);
        uint256 b = _place(2_500e6, 1);
        _fill(a, _legs(1_000e6, _p500()));
        assertEq(usdg.balanceOf(address(book)), 2_500e6, "other deposit moved");
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        book.cancel(b);
        assertEq(usdg.balanceOf(user) - before, 2_500e6);
        assertEq(usdg.balanceOf(address(book)), 0);
    }

    function test_fill_sellDirection() public {
        // Sell NVDA for USDG ("sell at my price").
        vm.prank(user);
        uint256 id = book.place(_lim(address(nvda), address(usdg), 1_000e6, 1, uint64(block.timestamp + 1 days)));
        uint256 before = usdg.balanceOf(user);
        uint256 makerGets = _fill(id, _legs(1_000e6, _path(_hopV3(address(usdg), 500))));
        assertEq(usdg.balanceOf(user) - before, makerGets);
        assertEq(nvda.balanceOf(address(book)), 0);
    }

    function test_nativeETH_in_and_out() public {
        // ETH in
        vm.prank(user);
        uint256 id = book.place{value: 1 ether}(_lim(NATIVE, address(meme), 1 ether, 1, uint64(block.timestamp + 1 days)));
        assertEq(address(book).balance, 1 ether);
        uint256 got = _fill(id, _legs(1 ether, _path(_hopV4(address(meme), 3000, 60, address(0)))));
        assertGt(got, 0);
        assertEq(address(book).balance, 0);
        // ETH out
        vm.prank(user);
        uint256 id2 = book.place(_lim(address(meme), NATIVE, 1 ether, 1, uint64(block.timestamp + 1 days)));
        uint256 before = user.balance;
        uint256 got2 = _fill(id2, _legs(1 ether, _path(_hopV4(NATIVE, 3000, 60, address(0)))));
        assertEq(user.balance - before, got2);
        assertEq(address(book).balance, 0);
        assertGt(keeper.balance, 0); // fee paid in ETH
    }

    function test_cancel_nativeRefund() public {
        vm.prank(user);
        uint256 id = book.place{value: 2 ether}(_lim(NATIVE, address(meme), 2 ether, 1, uint64(block.timestamp + 1 days)));
        uint256 before = user.balance;
        vm.prank(user);
        book.cancel(id);
        assertEq(user.balance - before, 2 ether);
    }

    function test_rejectsStrayETH() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(book).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_feeCap() public {
        vm.expectRevert(BookTakestock.FeeTooHigh.selector);
        new BookTakestock(IRouterTakestock(address(router)), 101, 0, address(0));
        BookTakestock zero = new BookTakestock(IRouterTakestock(address(router)), 0, 0, address(0));
        assertEq(zero.fillerFeeBps(), 0);
    }

    function test_views_getOrders() public {
        _place(1e6, 1);
        _place(2e6, 1);
        _place(3e6, 1);
        BookTakestock.Order[] memory all = book.getOrders(0, 10);
        assertEq(all.length, 3);
        assertEq(all[2].amountIn, 3e6);
        assertEq(book.getOrders(1, 2).length, 1);
        assertEq(book.getOrders(5, 9).length, 0);
    }

    function testFuzz_makerNeverBelowLimit(uint96 amount, uint16 slackBps) public {
        uint256 amt = bound(uint256(amount), 1e6, 50_000e6);
        Hop[] memory p = _p500();
        uint256 q = _quote(address(usdg), p, amt);
        uint256 minOut = (q * (10_000 - FEE_BPS - bound(uint256(slackBps), 0, 500))) / 10_000;
        if (minOut == 0) return;
        uint256 id = _place(uint128(amt), uint128(minOut));
        uint256 before = nvda.balanceOf(user);
        _fill(id, _legs(amt, p));
        assertGe(nvda.balanceOf(user) - before, minOut);
        assertEq(usdg.balanceOf(address(book)), 0);
    }
}
