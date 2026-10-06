// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookBase} from "./BookBase.t.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {RouterTakestock} from "../src/RouterTakestock.sol";
import {NATIVE, Hop, Leg} from "../src/RouteTypes.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// A maker-created token that tries to reenter the book / router on approve and transfer.
contract EvilToken is MockERC20 {
    BookTakestock public book;
    uint256 public victimId;
    bool public armed;
    bool public reenterOk;

    constructor() MockERC20("Evil", "EVIL", 18) {}

    function arm(BookTakestock b, uint256 id) external {
        book = b;
        victimId = id;
        armed = true;
    }

    function _attack() internal {
        if (!armed) return;
        armed = false;
        (bool ok,) = address(book).call(abi.encodeCall(BookTakestock.cancel, (victimId)));
        reenterOk = reenterOk || ok;
        Leg[] memory legs = new Leg[](0);
        (ok,) = address(book).call(abi.encodeCall(BookTakestock.fill, (victimId, 0, legs, block.timestamp)));
        reenterOk = reenterOk || ok;
        armed = true;
    }

    function approve(address s, uint256 a) public override returns (bool) {
        _attack();
        return super.approve(s, a);
    }

    function transfer(address to, uint256 a) public override returns (bool) {
        _attack();
        return super.transfer(to, a);
    }
}

contract ReviewBookTakestockTest is BookBase {
    address keeper = makeAddr("keeper");
    address other = makeAddr("other");

    function setUp() public override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, 1e24);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        book = new BookTakestock(IRouterTakestock(address(router)), 100, 0, address(0));
        vm.startPrank(user);
        usdg.approve(address(book), type(uint256).max);
        meme.approve(address(book), type(uint256).max);
        weth.approve(address(book), type(uint256).max);
        vm.stopPrank();
        vm.deal(other, 100 ether);
        usdg.mint(other, 1e30);
        vm.prank(other);
        usdg.approve(address(book), type(uint256).max);
    }

    /// Evil tokenIn reenters on approve/transfer during fill: must not touch the victim order.
    function test_evilTokenIn_cannotReenter() public {
        EvilToken evil = new EvilToken();
        evil.mint(address(this), 1e30);
        evil.approve(address(lp4), type(uint256).max);
        _v4Pool(address(evil), address(usdg), 3000, 60, address(0), PRICE_1_1, 1e21);

        vm.prank(other);
        uint256 victim = book.place(_lim(address(usdg), address(nvda), 1_000e6, 1, uint64(block.timestamp + 1 days)));

        evil.mint(user, 1e24);
        vm.prank(user);
        evil.approve(address(book), type(uint256).max);
        vm.prank(user);
        uint256 id = book.place(_lim(address(evil), address(usdg), 1e18, 1, uint64(block.timestamp + 1 days)));
        evil.arm(book, victim);

        vm.prank(keeper);
        _fillRaw(id, _legs(1e18, _path(_hopV4(address(usdg), 3000, 60, address(0)))));
        assertFalse(evil.reenterOk(), "reentered");
        assertEq(uint8(book.getOrder(victim).status), uint8(BookTakestock.Status.Open));
        assertEq(usdg.balanceOf(address(book)), 1_000e6, "victim deposit moved");
    }

    /// ETH-out fill while other orders hold ETH; ETH-in fill while others hold ETH.
    function test_nativeAccounting_withOtherNativeOrders() public {
        vm.prank(other);
        uint256 a = book.place{value: 5 ether}(_lim(NATIVE, address(meme), 5 ether, 1, uint64(block.timestamp + 1 days)));
        vm.prank(user);
        uint256 b = book.place(_lim(address(meme), NATIVE, 1 ether, 1, uint64(block.timestamp + 1 days)));
        vm.prank(user);
        uint256 c = book.place{value: 1 ether}(_lim(NATIVE, address(meme), 1 ether, 1, uint64(block.timestamp + 1 days)));

        uint256 before = user.balance;
        vm.prank(keeper);
        uint256 got = _fillRaw(b, _legs(1 ether, _path(_hopV4(NATIVE, 3000, 60, address(0)))));
        assertEq(user.balance - before, got);
        assertEq(address(book).balance, 6 ether);

        vm.prank(keeper);
        _fillRaw(c, _legs(1 ether, _path(_hopV4(address(meme), 3000, 60, address(0)))));
        assertEq(address(book).balance, 5 ether);

        uint256 ob = other.balance;
        vm.prank(other);
        book.cancel(a);
        assertEq(other.balance - ob, 5 ether);
        assertEq(address(book).balance, 0);
    }

    /// WETH -> ETH and ETH -> WETH via wrap/unwrap hops.
    function test_wrapUnwrapOrders() public {
        vm.prank(user);
        weth.deposit{value: 2 ether}();
        vm.prank(user);
        uint256 a = book.place(_lim(address(weth), NATIVE, 2 ether, 1.98 ether, uint64(block.timestamp + 1 days)));
        vm.prank(keeper);
        _fillRaw(a, _legs(2 ether, _path(_hopUnwrap())));
        vm.prank(user);
        uint256 b = book.place{value: 1 ether}(_lim(NATIVE, address(weth), 1 ether, 0.99 ether, uint64(block.timestamp + 1 days)));
        vm.prank(keeper);
        _fillRaw(b, _legs(1 ether, _path(_hopWrap(address(weth)))));
        assertEq(address(book).balance, 0);
        assertEq(weth.balanceOf(address(book)), 0);
    }

    /// amountIn above int128.max is accepted by place() but can never be filled (router AmountTooLarge).
    function test_amountAboveInt128_rejectedAtPlace() public {
        uint128 amt = uint128(type(int128).max) + 1;
        usdg.mint(user, amt);
        vm.prank(user);
        vm.expectRevert(BookTakestock.BadOrder.selector);
        book.place(_lim(address(usdg), address(nvda), amt, 1, uint64(block.timestamp + 1 days)));
    }
}
