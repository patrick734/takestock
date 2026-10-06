import { parseAbi } from "viem";

export const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);

export const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

export const poolManagerAbi = parseAbi([
  "function extsload(bytes32[] slots) view returns (bytes32[])",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const hopTuple = "(uint8 kind, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)";

export const quoterAbi = parseAbi([
  `function quotePath(address tokenIn, ${hopTuple}[] hops, uint256 amountIn) returns (uint256 amountOut, uint256[] hopOut)`,
  `function quoteMany(address tokenIn, ${hopTuple}[][] paths, uint256[][] amounts) returns (uint256[][] outs)`,
]);

export const routerAbi = parseAbi([
  `function swap(address tokenIn, address tokenOut, (uint256 amountIn, ${hopTuple}[] hops)[] legs, uint256 minAmountOut, address recipient, uint256 deadline) payable returns (uint256 amountOut)`,
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 legs)",
  "error Expired()",
  "error Reentered()",
  "error BadRoute()",
  "error BadHop(uint256 leg, uint256 hop)",
  "error BadValue()",
  "error ZeroRecipient()",
  "error AmountTooLarge()",
  "error InputNotReceived()",
  "error OutputNotReceived()",
  "error NoPool(address tokenA, address tokenB, uint24 fee)",
  "error PartialFill()",
  "error UnauthorizedCallback()",
  "error TooLittleReceived(uint256 amountOut, uint256 minAmountOut)",
  "error TransferFailed()",
  "error UnexpectedETH()",
]);
