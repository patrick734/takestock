// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NATIVE, Leg} from "./RouteTypes.sol";

interface IRouterTakestock {
    function swap(
        address tokenIn,
        address tokenOut,
        Leg[] calldata legs,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256 amountOut);
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}

interface IPriceFeedLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title BookTakestock
/// @notice The Takestock order book for Robinhood Chain: limit, take-profit, stop-loss and bracket orders,
///         filled through RouterTakestock across the Uniswap v3 and v4 pools that pay most.
///
///         A maker deposits `amountIn` of `tokenIn` for `tokenOut` and sets up to two exit conditions.
///         The order (or a part of it, if the maker allows partial fills) can be filled when EITHER holds:
///
///         - Limit leg (limit / take-profit): the maker receives at least `minAmountOut`, pro rata to the
///           part being filled. `minAmountOut == 0` means no limit leg.
///         - Stop leg (stop-loss / stop-buy): the Chainlink price at `feed` has crossed `stopPrice`
///           (at or below it if `stopBelow`, at or above it otherwise), with an answer no older than
///           `maxAge`. Once the stop has triggered it stays triggered. `feed == address(0)` means no stop leg.
///           The floor of a stop fill follows Chainlink's price at the time of the fill: `stopMinOut` is the
///           floor at exactly `stopPrice`, scaled by the current price (up when the price is better, down when it
///           has moved on), so the maker gets the market less at most their slippage, and a stop that triggered
///           earlier cannot be filled at a stale floor after the price recovers. If the feed has no fresh answer
///           at fill time, the floor stays at `stopMinOut`. `feedPricesIn` says which side the feed prices:
///           true when it prices tokenIn (selling a stock), false when it prices tokenOut (buying one).
///
///         Both legs together make a bracket order: take profit at one price, cut the loss at another.
///
///         Guarantees:
///         - Every fill pays the maker at least the floor of a leg that holds, after the fees.
///         - Only the maker can cancel; after expiry anyone can send what is left back to the maker.
///         - Funds only ever leave to the maker (output or refund) or, for the fees, to the filler and to
///           `feeSink` (BuyBurnTakestock, which can only buy $TSTK and burn it). If the output token refuses the
///           transfer to `feeSink`, that share goes to the maker instead. Native ETH output pays no protocol fee.
///         - A broken or stale price feed can only stop the stop leg; the limit leg and refunds never read it.
///         - No owner, no admin, no pause, no upgrade path. Both fees and the fee sink are fixed at deployment
///           (together at most 1%).
contract BookTakestock {
    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        address maker;
        uint64 expiry;
        Status status;
        bool partialFill;
        bool stopBelow;
        bool feedPricesIn;
        bool triggered;
        address tokenIn;
        uint32 maxAge;
        address tokenOut;
        uint128 amountIn;
        uint128 remaining;
        uint128 minAmountOut;
        uint128 stopMinOut;
        address feed;
        uint128 stopPrice;
        uint128 received;
    }

    struct Params {
        address tokenIn;
        address tokenOut;
        uint128 amountIn;
        uint128 minAmountOut;
        uint64 expiry;
        bool partialFill;
        address feed;
        uint128 stopPrice;
        bool stopBelow;
        bool feedPricesIn;
        uint128 stopMinOut;
        uint32 maxAge;
    }

    uint256 public constant MAX_FEE_BPS = 100;
    /// @notice Most orders `placeMany` takes at once.
    uint256 public constant MAX_BATCH = 10;
    /// @notice A partial fill must move at least 1/MIN_PART_DIV of the order and leave at least as much (or nothing).
    uint256 public constant MIN_PART_DIV = 20;
    uint32 public constant MIN_MAX_AGE = 60;
    uint32 public constant MAX_MAX_AGE = 7 days;
    uint256 private constant FEED_GAS = 100_000;

    IRouterTakestock public immutable router;
    /// @notice Paid to whoever fills an order, in basis points of the output.
    uint256 public immutable fillerFeeBps;
    /// @notice Paid to `feeSink` on every fill, in basis points of the output.
    uint256 public immutable protocolFeeBps;
    /// @notice Where the protocol fee goes: BuyBurnTakestock, which buys $TSTK with it and burns it.
    address public immutable feeSink;

    Order[] private _orders;
    mapping(address => uint256[]) private _byMaker;
    uint256 private _lock = 1;

    event Placed(
        uint256 indexed id,
        address indexed maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        bool partialFill,
        address feed,
        uint256 stopPrice,
        bool stopBelow,
        uint256 stopMinOut
    );
    event Triggered(uint256 indexed id, uint256 price, uint256 updatedAt);
    event ProtocolFee(uint256 indexed id, address indexed token, uint256 amount);
    event Cancelled(uint256 indexed id, address indexed maker, address indexed by, uint256 refunded);
    event Filled(
        uint256 indexed id,
        address indexed maker,
        address indexed filler,
        uint256 amountIn,
        uint256 makerGets,
        uint256 fee,
        uint256 remaining
    );

    error BadOrder();
    error BadValue();
    error BadAmount();
    error NotOpen();
    error Expired();
    error NotMaker();
    error NotTriggered();
    error Reentered();
    error InputNotReceived();
    error BelowLimit(uint256 makerGets, uint256 required);
    error TransferFailed();
    error FeeTooHigh();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IRouterTakestock _router, uint256 _fillerFeeBps, uint256 _protocolFeeBps, address _feeSink) {
        if (_fillerFeeBps + _protocolFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (address(_router).code.length == 0) revert BadOrder();
        if (_protocolFeeBps != 0 && _feeSink == address(0)) revert BadOrder();
        router = _router;
        fillerFeeBps = _fillerFeeBps;
        protocolFeeBps = _protocolFeeBps;
        feeSink = _feeSink;
    }

    // ------------------------------------------------------------------ maker

    /// @notice Deposit `p.amountIn` of `p.tokenIn` and set the exit conditions. Use address(0) for native ETH
    ///         (send it as msg.value).
    function place(Params calldata p) external payable nonReentrant returns (uint256 id) {
        id = _place(p, msg.value);
    }

    /// @notice Place up to MAX_BATCH orders in one transaction, e.g. a ladder of take-profit targets that each sell
    ///         part of a position, plus a stop. Each order is independent once placed. For native ETH orders,
    ///         msg.value must equal the sum of their amounts.
    function placeMany(Params[] calldata ps) external payable nonReentrant returns (uint256[] memory ids) {
        uint256 n = ps.length;
        if (n == 0 || n > MAX_BATCH) revert BadOrder();
        ids = new uint256[](n);
        uint256 value = msg.value;
        for (uint256 i; i < n; ++i) {
            uint256 part = ps[i].tokenIn == NATIVE ? ps[i].amountIn : 0;
            if (part > value) revert BadValue();
            value -= part;
            ids[i] = _place(ps[i], part);
        }
        if (value != 0) revert BadValue();
    }

    function _place(Params calldata p, uint256 value) private returns (uint256 id) {
        if (p.tokenIn == p.tokenOut || p.amountIn == 0 || p.expiry <= block.timestamp) revert BadOrder();
        // The router caps a swap at int128; a larger order could never fill.
        if (p.amountIn > uint128(type(int128).max)) revert BadOrder();
        bool hasStop = p.feed != address(0);
        if (p.minAmountOut == 0 && !hasStop) revert BadOrder();
        if (hasStop) {
            if (p.stopPrice == 0 || p.stopMinOut == 0) revert BadOrder();
            if (p.maxAge < MIN_MAX_AGE || p.maxAge > MAX_MAX_AGE) revert BadOrder();
            (bool ok, uint256 price,) = _readFeed(p.feed);
            if (!ok || price == 0) revert BadOrder();
        } else if (p.stopPrice != 0 || p.stopMinOut != 0 || p.stopBelow || p.feedPricesIn || p.maxAge != 0) {
            revert BadOrder();
        }

        if (p.tokenIn == NATIVE) {
            if (value != p.amountIn) revert BadValue();
        } else {
            if (value != 0) revert BadValue();
            uint256 before = IERC20Like(p.tokenIn).balanceOf(address(this));
            _call(p.tokenIn, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), uint256(p.amountIn)));
            // Exactly amountIn must arrive (fee-on-transfer tokens are not supported).
            if (IERC20Like(p.tokenIn).balanceOf(address(this)) - before != p.amountIn) revert InputNotReceived();
        }

        id = _orders.length;
        _orders.push(
            Order({
                maker: msg.sender,
                expiry: p.expiry,
                status: Status.Open,
                partialFill: p.partialFill,
                stopBelow: p.stopBelow,
                feedPricesIn: p.feedPricesIn,
                triggered: false,
                tokenIn: p.tokenIn,
                maxAge: p.maxAge,
                tokenOut: p.tokenOut,
                amountIn: p.amountIn,
                remaining: p.amountIn,
                minAmountOut: p.minAmountOut,
                stopMinOut: p.stopMinOut,
                feed: p.feed,
                stopPrice: p.stopPrice,
                received: 0
            })
        );
        _byMaker[msg.sender].push(id);
        emit Placed(
            id,
            msg.sender,
            p.tokenIn,
            p.tokenOut,
            p.amountIn,
            p.minAmountOut,
            p.expiry,
            p.partialFill,
            p.feed,
            p.stopPrice,
            p.stopBelow,
            p.stopMinOut
        );
    }

    /// @notice Cancel an open order and get back what is left of the deposit. Only the maker, at any time;
    ///         after expiry anyone may call it (the deposit still goes only to the maker).
    function cancel(uint256 id) external nonReentrant {
        Order storage o = _order(id);
        if (o.status != Status.Open) revert NotOpen();
        if (msg.sender != o.maker && block.timestamp <= o.expiry) revert NotMaker();
        uint256 left = o.remaining;
        o.status = Status.Cancelled;
        o.remaining = 0;
        _send(o.tokenIn, o.maker, left);
        emit Cancelled(id, o.maker, msg.sender, left);
    }

    // ------------------------------------------------------------------ stop trigger

    /// @notice Record that an order's stop has triggered (anyone may call). Once triggered, the stop leg
    ///         stays usable even if the price moves back, like a stop order on an exchange.
    function poke(uint256 id) external nonReentrant returns (bool triggered) {
        Order storage o = _order(id);
        if (o.status != Status.Open) revert NotOpen();
        if (block.timestamp > o.expiry) revert Expired();
        return _latch(id, o);
    }

    // ------------------------------------------------------------------ filler

    /// @notice Fill `amount` of an open order along `legs` (a route whose leg amounts sum to `amount`).
    ///         Without partial fills `amount` must be the whole order.
    /// @return makerGets  What the maker received for this fill.
    function fill(uint256 id, uint256 amount, Leg[] calldata legs, uint256 deadline)
        external
        nonReentrant
        returns (uint256 makerGets)
    {
        Order storage o = _order(id);
        if (o.status != Status.Open) revert NotOpen();
        if (block.timestamp > o.expiry) revert Expired();

        uint256 remaining = o.remaining;
        if (amount == 0 || amount > remaining) revert BadAmount();
        if (amount != remaining) {
            uint256 whole = o.amountIn;
            if (!o.partialFill) revert BadAmount();
            if (amount * MIN_PART_DIV < whole || (remaining - amount) * MIN_PART_DIV < whole) revert BadAmount();
        }
        uint256 total;
        for (uint256 i; i < legs.length; ++i) total += legs[i].amountIn;
        if (total != amount) revert BadAmount();

        // The least the maker may receive for this part: the lower floor of the legs that hold.
        uint256 need = type(uint256).max;
        if (o.minAmountOut != 0) need = _proRata(o.minAmountOut, amount, o.amountIn);
        if (o.feed != address(0) && _latch(id, o)) {
            uint256 stopNeed = _proRata(_stopFloor(o), amount, o.amountIn);
            if (stopNeed < need) need = stopNeed;
        }
        if (need == type(uint256).max) revert NotTriggered();

        // Effects first: the same deposit can never be filled or refunded twice.
        o.remaining = uint128(remaining - amount);
        if (remaining == amount) o.status = Status.Filled;
        address tokenIn = o.tokenIn;
        address tokenOut = o.tokenOut;

        // The router's own minimum, grossed up for the fee, so a swap that cannot pay the floor fails early.
        // Native ETH output pays no protocol fee: BuyBurnTakestock only takes tokens.
        uint256 protocolBps = tokenOut == NATIVE ? 0 : protocolFeeBps;
        uint256 keep = 10_000 - fillerFeeBps - protocolBps;
        uint256 routerMin = (need * 10_000 + keep - 1) / keep;
        uint256 outBefore = _balance(tokenOut);
        if (tokenIn == NATIVE) {
            router.swap{value: amount}(tokenIn, tokenOut, legs, routerMin, address(this), deadline);
        } else {
            _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(router), 0));
            _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(router), amount));
            router.swap(tokenIn, tokenOut, legs, routerMin, address(this), deadline);
            _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(router), 0));
        }
        // Measure what actually arrived rather than trusting a return value.
        uint256 out = _balance(tokenOut) - outBefore;

        uint256 fee = (out * fillerFeeBps) / 10_000;
        uint256 protocolFee = (out * protocolBps) / 10_000;
        makerGets = out - fee - protocolFee;
        if (makerGets < need) revert BelowLimit(makerGets, need);
        // The protocol fee goes first. A token that refuses a transfer to the fee sink hands the fee to the maker
        // instead, so it can never block a fill.
        if (protocolFee > 0) {
            if (_trySend(tokenOut, feeSink, protocolFee)) emit ProtocolFee(id, tokenOut, protocolFee);
            else makerGets += protocolFee;
        }
        uint256 got = uint256(o.received) + makerGets;
        o.received = got > type(uint128).max ? type(uint128).max : uint128(got);

        _send(tokenOut, o.maker, makerGets);
        if (fee > 0) _send(tokenOut, msg.sender, fee);
        emit Filled(id, o.maker, msg.sender, amount, makerGets, fee, remaining - amount);
    }

    // ------------------------------------------------------------------ views

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function getOrder(uint256 id) external view returns (Order memory) {
        return _order(id);
    }

    /// @notice Orders [from, to) for keepers and the app, clamped to what exists.
    function getOrders(uint256 from, uint256 to) external view returns (Order[] memory list) {
        if (to > _orders.length) to = _orders.length;
        if (from >= to) return list;
        list = new Order[](to - from);
        for (uint256 i = from; i < to; ++i) list[i - from] = _orders[i];
    }

    function orderIdsOf(address maker) external view returns (uint256[] memory) {
        return _byMaker[maker];
    }

    /// @notice Stop state of an order: whether the stop leg can be used now, whether it already latched,
    ///         and the feed's current answer. All false/zero for orders without a stop.
    function stopState(uint256 id) external view returns (bool usable, bool latched, uint256 price, uint256 updatedAt) {
        Order storage o = _order(id);
        if (o.feed == address(0)) return (false, false, 0, 0);
        bool ok;
        (ok, price, updatedAt) = _readFeed(o.feed);
        latched = o.triggered;
        usable = latched || (ok && _crossed(o, price, updatedAt));
    }

    /// @notice Total fee in basis points taken from a fill's output in `tokenOut` (filler plus protocol).
    function feeBpsFor(address tokenOut) external view returns (uint256) {
        return fillerFeeBps + (tokenOut == NATIVE ? 0 : protocolFeeBps);
    }

    /// @notice The least the maker must receive for filling `amount` now (after the fees), or
    ///         type(uint256).max if no leg can be used.
    function requiredOut(uint256 id, uint256 amount) external view returns (uint256 need) {
        Order storage o = _order(id);
        need = type(uint256).max;
        if (amount == 0) return need;
        if (o.minAmountOut != 0) need = _proRata(o.minAmountOut, amount, o.amountIn);
        if (o.feed != address(0)) {
            (bool ok, uint256 price, uint256 at) = _readFeed(o.feed);
            if (o.triggered || (ok && _crossed(o, price, at))) {
                uint256 s = _proRata(_stopFloor(o), amount, o.amountIn);
                if (s < need) need = s;
            }
        }
    }

    // ------------------------------------------------------------------ internals

    function _order(uint256 id) private view returns (Order storage) {
        if (id >= _orders.length) revert BadOrder();
        return _orders[id];
    }

    /// Latches the stop if it has crossed; returns whether the stop leg is usable.
    function _latch(uint256 id, Order storage o) private returns (bool) {
        if (o.feed == address(0)) return false;
        if (o.triggered) return true;
        (bool ok, uint256 price, uint256 updatedAt) = _readFeed(o.feed);
        if (!ok || !_crossed(o, price, updatedAt)) return false;
        o.triggered = true;
        emit Triggered(id, price, updatedAt);
        return true;
    }

    /// The stop floor for the whole order now: `stopMinOut` scaled by Chainlink's fresh price against `stopPrice`
    /// (output worth more when the price of what is sold is higher, or of what is bought is lower). Without a
    /// fresh answer it is `stopMinOut`, the floor at the stop price.
    function _stopFloor(Order storage o) private view returns (uint256) {
        (bool ok, uint256 price, uint256 at) = _readFeed(o.feed);
        if (!ok || at > block.timestamp || block.timestamp - at > o.maxAge) return o.stopMinOut;
        uint256 stop = o.stopPrice;
        return o.feedPricesIn
            ? (uint256(o.stopMinOut) * price + stop - 1) / stop
            : (uint256(o.stopMinOut) * stop + price - 1) / price;
    }

    function _crossed(Order storage o, uint256 price, uint256 updatedAt) private view returns (bool) {
        if (price == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > o.maxAge) return false;
        return o.stopBelow ? price <= o.stopPrice : price >= o.stopPrice;
    }

    /// Reads a Chainlink-style feed without trusting it: a revert, bad return data or a non-positive answer
    /// reads as "no price".
    function _readFeed(address feed) private view returns (bool ok, uint256 price, uint256 updatedAt) {
        if (feed.code.length == 0) return (false, 0, 0);
        (bool success, bytes memory ret) =
            feed.staticcall{gas: FEED_GAS}(abi.encodeWithSelector(IPriceFeedLike.latestRoundData.selector));
        if (!success || ret.length < 160) return (false, 0, 0);
        // Read the two words we need without width checks: odd values in the other fields must not revert here.
        int256 answer;
        uint256 at;
        assembly ("memory-safe") {
            answer := mload(add(ret, 64))
            at := mload(add(ret, 128))
        }
        // A price above uint128 is treated as no price, so the floor arithmetic can never overflow.
        if (answer <= 0 || uint256(answer) > type(uint128).max) return (false, 0, 0);
        return (true, uint256(answer), at);
    }

    /// ceil(x * part / whole): rounding up keeps the sum of partial floors at or above the whole floor.
    function _proRata(uint256 x, uint256 part, uint256 whole) private pure returns (uint256) {
        if (part == whole) return x;
        return (x * part + whole - 1) / whole;
    }

    function _balance(address token) private view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20Like(token).balanceOf(address(this));
    }

    function _send(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
    }

    /// Calls a token and accepts both standard (returns true) and non-standard (returns nothing) ERC20s.
    /// @dev An ERC20 transfer that reports failure instead of reverting (only used for the protocol fee).
    function _trySend(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (uint256)) == 1));
    }

    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// Native ETH arrives from the router when an order pays out in ETH.
    receive() external payable {
        if (msg.sender != address(router)) revert BadValue();
    }
}
