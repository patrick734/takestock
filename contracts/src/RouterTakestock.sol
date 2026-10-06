// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {IERC20Min, IWETH9, IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop, Leg} from "./RouteTypes.sol";

/// @title RouterTakestock
/// @notice Executes a swap that has been split across up to 10 paths ("legs") through Uniswap v3
///         and v4 pools on Robinhood Chain. The route is computed off-chain; this contract only
///         executes it, all-or-nothing:
///         - it pulls exactly the input, runs every hop of every leg, and checks the total output
///           against `minAmountOut`;
///         - every hop must fill in full, so no input is ever left behind;
///         - if any hop fails, the whole transaction reverts.
/// @dev    No owner, no fee, no pause, no upgrade path, no storage. It holds nothing between calls.
///         v3 pools are looked up in the canonical factory (never taken from calldata), and the v3
///         callback only pays the one pool the router is currently swapping with.
contract RouterTakestock is IUnlockCallback {
    uint256 public constant MAX_LEGS = 10;
    uint256 public constant MAX_HOPS = 4;

    IUniswapV3Factory public immutable v3Factory;
    IPoolManager public immutable poolManager;
    address public immutable weth;

    // Transient storage slots (EIP-1153). Cleared at the end of every use.
    bytes32 private constant LOCK_SLOT = keccak256("splitrouter.lock");
    bytes32 private constant V3_POOL_SLOT = keccak256("splitrouter.v3.pool");
    bytes32 private constant V3_TOKEN_SLOT = keccak256("splitrouter.v3.token");
    bytes32 private constant V3_AMOUNT_SLOT = keccak256("splitrouter.v3.amount");

    event Swapped(
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 legs
    );

    error Expired();
    error Reentered();
    error BadRoute();
    error BadHop(uint256 leg, uint256 hop);
    error BadValue();
    error ZeroRecipient();
    error AmountTooLarge();
    error InputNotReceived();
    error OutputNotReceived();
    error NoPool(address tokenA, address tokenB, uint24 fee);
    error PartialFill();
    error UnauthorizedCallback();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    error TransferFailed();
    error UnexpectedETH();

    constructor(IUniswapV3Factory _v3Factory, IPoolManager _poolManager, address _weth) {
        v3Factory = _v3Factory;
        poolManager = _poolManager;
        weth = _weth;
    }

    /// @notice Swap `tokenIn` for `tokenOut` along `legs`. Use address(0) for native ETH.
    /// @param legs          Each leg's `amountIn` is taken from the total; the total is pulled from
    ///                      the caller (or must equal msg.value for ETH).
    /// @param minAmountOut  The whole transaction reverts if the summed output is lower.
    /// @return amountOut    What `recipient` received.
    function swap(
        address tokenIn,
        address tokenOut,
        Leg[] calldata legs,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        if (_tload(LOCK_SLOT) != 0) revert Reentered();
        _tstore(LOCK_SLOT, 1);

        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0)) revert ZeroRecipient();
        if (tokenIn == tokenOut || legs.length == 0 || legs.length > MAX_LEGS) revert BadRoute();

        uint256 totalIn;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].amountIn == 0) revert BadRoute();
            totalIn += legs[i].amountIn;
        }
        if (totalIn > uint256(uint128(type(int128).max))) revert AmountTooLarge();

        uint256 outBefore = tokenOut == NATIVE ? address(this).balance - msg.value : _balance(tokenOut);

        // Pull the input. Exactly `totalIn` must arrive (fee-on-transfer tokens are not supported).
        if (tokenIn == NATIVE) {
            if (msg.value != totalIn) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            uint256 before = _balance(tokenIn);
            _safeTransferFrom(tokenIn, msg.sender, address(this), totalIn);
            if (_balance(tokenIn) - before != totalIn) revert InputNotReceived();
        }

        for (uint256 i; i < legs.length; ++i) {
            amountOut += _runLeg(i, tokenIn, tokenOut, legs[i]);
        }
        if (amountOut < minAmountOut) revert TooLittleReceived(amountOut, minAmountOut);

        // What the pools reported must actually be here (guards against tokens that tax transfers).
        uint256 outNow = tokenOut == NATIVE ? address(this).balance : _balance(tokenOut);
        if (outNow < outBefore + amountOut) revert OutputNotReceived();

        _send(tokenOut, recipient, amountOut);
        emit Swapped(msg.sender, recipient, tokenIn, tokenOut, totalIn, amountOut, legs.length);

        _tstore(LOCK_SLOT, 0);
    }

    // ------------------------------------------------------------------ legs and hops

    function _runLeg(uint256 legIndex, address tokenIn, address tokenOut, Leg calldata leg)
        internal
        returns (uint256 amount)
    {
        uint256 n = leg.hops.length;
        if (n == 0 || n > MAX_HOPS) revert BadRoute();
        amount = leg.amountIn;
        address current = tokenIn;
        for (uint256 h; h < n; ++h) {
            Hop calldata hop = leg.hops[h];
            if (hop.tokenOut == current) revert BadHop(legIndex, h);
            amount = _hop(legIndex, h, current, hop, amount);
            if (amount == 0) revert PartialFill();
            current = hop.tokenOut;
        }
        if (current != tokenOut) revert BadRoute();
    }

    function _hop(uint256 legIndex, uint256 h, address tokenIn, Hop calldata hop, uint256 amountIn)
        internal
        returns (uint256)
    {
        if (hop.kind == HopKind.WRAP) {
            if (tokenIn != NATIVE || hop.tokenOut != weth) revert BadHop(legIndex, h);
            IWETH9(weth).deposit{value: amountIn}();
            return amountIn;
        }
        if (hop.kind == HopKind.UNWRAP) {
            if (tokenIn != weth || hop.tokenOut != NATIVE) revert BadHop(legIndex, h);
            IWETH9(weth).withdraw(amountIn);
            return amountIn;
        }
        if (hop.kind == HopKind.V3) {
            if (tokenIn == NATIVE || hop.tokenOut == NATIVE) revert BadHop(legIndex, h);
            return _swapV3(tokenIn, hop.tokenOut, hop.fee, amountIn);
        }
        return _swapV4(tokenIn, hop, amountIn);
    }

    // ------------------------------------------------------------------ Uniswap v3

    function _swapV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        address pool = v3Factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool(tokenIn, tokenOut, fee);
        bool zeroForOne = tokenIn < tokenOut;

        _tstore(V3_POOL_SLOT, uint256(uint160(pool)));
        _tstore(V3_TOKEN_SLOT, uint256(uint160(tokenIn)));
        _tstore(V3_AMOUNT_SLOT, amountIn);

        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );

        // The callback clears the pool slot once it has paid; if it never ran, fail.
        if (_tload(V3_POOL_SLOT) != 0) revert PartialFill();
        _tstore(V3_TOKEN_SLOT, 0);
        _tstore(V3_AMOUNT_SLOT, 0);

        (int256 paid, int256 received) = zeroForOne ? (amount0, -amount1) : (amount1, -amount0);
        if (paid != int256(amountIn) || received <= 0) revert PartialFill();
        return uint256(received);
    }

    /// @dev Only the pool this router is swapping with right now can collect, and only the exact
    ///      amount the hop was sized for (anything less means the swap ran out of liquidity).
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        address pool = address(uint160(_tload(V3_POOL_SLOT)));
        if (pool == address(0) || msg.sender != pool) revert UnauthorizedCallback();
        _tstore(V3_POOL_SLOT, 0);

        uint256 owed = uint256(amount0Delta > 0 ? amount0Delta : amount1Delta);
        if (owed != _tload(V3_AMOUNT_SLOT)) revert PartialFill();
        _safeTransfer(address(uint160(_tload(V3_TOKEN_SLOT))), pool, owed);
    }

    // ------------------------------------------------------------------ Uniswap v4

    struct V4Swap {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address tokenIn;
        address tokenOut;
    }

    function _swapV4(address tokenIn, Hop calldata hop, uint256 amountIn) internal returns (uint256) {
        (address c0, address c1) = tokenIn < hop.tokenOut ? (tokenIn, hop.tokenOut) : (hop.tokenOut, tokenIn);
        V4Swap memory s = V4Swap({
            key: PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: hop.fee,
                tickSpacing: hop.tickSpacing,
                hooks: IHooks(hop.hooks)
            }),
            zeroForOne: tokenIn == c0,
            amountIn: amountIn,
            tokenIn: tokenIn,
            tokenOut: hop.tokenOut
        });
        return abi.decode(poolManager.unlock(abi.encode(s)), (uint256));
    }

    /// @dev Runs inside PoolManager.unlock: swap, pay the input, take the output. Deltas net to zero.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _tload(LOCK_SLOT) == 0) revert UnauthorizedCallback();
        V4Swap memory s = abi.decode(data, (V4Swap));

        BalanceDelta delta = poolManager.swap(
            s.key,
            SwapParams({
                zeroForOne: s.zeroForOne,
                amountSpecified: -int256(s.amountIn),
                sqrtPriceLimitX96: s.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) =
            s.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (int256(inDelta) != -int256(s.amountIn) || outDelta <= 0) revert PartialFill();

        if (s.tokenIn == NATIVE) {
            poolManager.settle{value: s.amountIn}();
        } else {
            poolManager.sync(Currency.wrap(s.tokenIn));
            _safeTransfer(s.tokenIn, address(poolManager), s.amountIn);
            poolManager.settle();
        }
        uint256 out = uint256(uint128(outDelta));
        poolManager.take(Currency.wrap(s.tokenOut), address(this), out);
        return abi.encode(out);
    }

    // ------------------------------------------------------------------ ETH

    /// @dev ETH only arrives from WETH (unwrap) or the PoolManager (take), mid-swap.
    receive() external payable {
        if (msg.sender != weth && msg.sender != address(poolManager)) revert UnexpectedETH();
    }

    // ------------------------------------------------------------------ helpers

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    function _balance(address token) private view returns (uint256) {
        return IERC20Min(token).balanceOf(address(this));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        _checkTransfer(token, ok, ret);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transferFrom, (from, to, amount)));
        _checkTransfer(token, ok, ret);
    }

    /// @dev Bubbles the token's own revert reason when there is one, so wallets show the real error.
    function _checkTransfer(address token, bool ok, bytes memory ret) private view {
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert TransferFailed();
        }
        if ((ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }

    function _tstore(bytes32 slot, uint256 value) private {
        assembly {
            tstore(slot, value)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 value) {
        assembly {
            value := tload(slot)
        }
    }
}
