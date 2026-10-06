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

import {IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop} from "./RouteTypes.sol";

/// @title QuoterTakestock
/// @notice Quotes paths by running the real swap against the real pool and then reverting, so a
///         quote is exactly what the pool would do right now: no price model, no estimate.
///         Call it with eth_call (it is not a view, but it never changes state and holds nothing).
/// @dev    Each hop of a path is quoted against current state. Paths that share a pool must not be
///         quoted independently and then added up; the routing engine only splits across paths
///         that share no pool.
contract QuoterTakestock is IUnlockCallback {
    IUniswapV3Factory public immutable v3Factory;
    IPoolManager public immutable poolManager;
    address public immutable weth;

    error V3Result(int256 amount0, int256 amount1);
    error V4Result(int128 amount0, int128 amount1);
    error NoPool();
    error BadHop(uint256 hop);
    error PartialFill(uint256 hop);
    error NotPoolManager();

    constructor(IUniswapV3Factory _v3Factory, IPoolManager _poolManager, address _weth) {
        v3Factory = _v3Factory;
        poolManager = _poolManager;
        weth = _weth;
    }

    /// @notice Output of swapping `amountIn` of `tokenIn` along `hops`. Reverts if any hop cannot
    ///         fill in full (e.g. not enough liquidity), exactly like the router would.
    function quotePath(address tokenIn, Hop[] calldata hops, uint256 amountIn)
        public
        returns (uint256 amountOut, uint256[] memory hopOut)
    {
        hopOut = new uint256[](hops.length);
        amountOut = amountIn;
        address current = tokenIn;
        for (uint256 h; h < hops.length; ++h) {
            Hop calldata hop = hops[h];
            if (hop.kind == HopKind.WRAP) {
                if (current != NATIVE || hop.tokenOut != weth) revert BadHop(h);
            } else if (hop.kind == HopKind.UNWRAP) {
                if (current != weth || hop.tokenOut != NATIVE) revert BadHop(h);
            } else if (hop.kind == HopKind.V3) {
                if (current == NATIVE || hop.tokenOut == NATIVE) revert BadHop(h);
                amountOut = _quoteV3(h, current, hop.tokenOut, hop.fee, amountOut);
            } else {
                amountOut = _quoteV4(h, current, hop, amountOut);
            }
            hopOut[h] = amountOut;
            current = hop.tokenOut;
        }
    }

    /// @notice Batch: quote many (path, amount) pairs in one eth_call. A failing quote returns 0.
    function quoteMany(address tokenIn, Hop[][] calldata paths, uint256[][] calldata amounts)
        external
        returns (uint256[][] memory outs)
    {
        outs = new uint256[][](paths.length);
        for (uint256 p; p < paths.length; ++p) {
            outs[p] = new uint256[](amounts[p].length);
            for (uint256 a; a < amounts[p].length; ++a) {
                try this.quotePath(tokenIn, paths[p], amounts[p][a]) returns (uint256 out, uint256[] memory) {
                    outs[p][a] = out;
                } catch {
                    outs[p][a] = 0;
                }
            }
        }
    }

    // ------------------------------------------------------------------ v3

    function _quoteV3(uint256 h, address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (uint256)
    {
        address pool = v3Factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool();
        bool zeroForOne = tokenIn < tokenOut;
        try IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        ) {
            revert PartialFill(h); // unreachable: the callback always reverts
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != V3Result.selector) _bubble(reason);
            (int256 a0, int256 a1) = abi.decode(_args(reason), (int256, int256));
            (int256 paid, int256 received) = zeroForOne ? (a0, -a1) : (a1, -a0);
            if (paid != int256(amountIn) || received <= 0) revert PartialFill(h);
            return uint256(received);
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external pure {
        revert V3Result(amount0Delta, amount1Delta);
    }

    // ------------------------------------------------------------------ v4

    struct V4Quote {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    function _quoteV4(uint256 h, address tokenIn, Hop calldata hop, uint256 amountIn) internal returns (uint256) {
        (address c0, address c1) = tokenIn < hop.tokenOut ? (tokenIn, hop.tokenOut) : (hop.tokenOut, tokenIn);
        V4Quote memory q = V4Quote({
            key: PoolKey({
                currency0: Currency.wrap(c0),
                currency1: Currency.wrap(c1),
                fee: hop.fee,
                tickSpacing: hop.tickSpacing,
                hooks: IHooks(hop.hooks)
            }),
            zeroForOne: tokenIn == c0,
            amountIn: amountIn
        });
        try poolManager.unlock(abi.encode(q)) {
            revert PartialFill(h); // unreachable
        } catch (bytes memory reason) {
            if (reason.length != 68 || bytes4(reason) != V4Result.selector) _bubble(reason);
            (int128 d0, int128 d1) = abi.decode(_args(reason), (int128, int128));
            (int128 inDelta, int128 outDelta) = q.zeroForOne ? (d0, d1) : (d1, d0);
            if (int256(inDelta) != -int256(amountIn) || outDelta <= 0) revert PartialFill(h);
            return uint256(uint128(outDelta));
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        V4Quote memory q = abi.decode(data, (V4Quote));
        BalanceDelta delta = poolManager.swap(
            q.key,
            SwapParams({
                zeroForOne: q.zeroForOne,
                amountSpecified: -int256(q.amountIn),
                sqrtPriceLimitX96: q.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        revert V4Result(delta.amount0(), delta.amount1());
    }

    // ------------------------------------------------------------------ helpers

    function _args(bytes memory reason) private pure returns (bytes memory args) {
        args = new bytes(reason.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = reason[i + 4];
        }
    }

    function _bubble(bytes memory reason) private pure {
        assembly {
            revert(add(reason, 32), mload(reason))
        }
    }
}
