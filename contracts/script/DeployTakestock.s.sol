// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {RouterTakestock} from "../src/RouterTakestock.sol";
import {QuoterTakestock} from "../src/QuoterTakestock.sol";
import {BookTakestock, IRouterTakestock} from "../src/BookTakestock.sol";
import {IUniswapV3Factory} from "../src/interfaces/IExternal.sol";

/// Deploys RouterTakestock, QuoterTakestock and BookTakestock from one wallet. Signs with an encrypted
/// Foundry keystore, never a raw key (launch.sh runs this):
///   forge script script/DeployTakestock.s.sol --rpc-url robinhood --broadcast --account <keystore> --password-file <file>
/// FILLER_FEE_BPS (default 5 = 0.05%, paid to whoever fills) and PROTOCOL_FEE_BPS (default 25 = 0.25%, paid to
/// FEE_SINK, the BuyBurnTakestock that launch.sh deploys first) are fixed forever at deployment; together at most 1%.
contract DeployTakestock is Script {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external {
        uint256 fee = vm.envOr("FILLER_FEE_BPS", uint256(5));
        uint256 protocolFee = vm.envOr("PROTOCOL_FEE_BPS", uint256(25));
        address sink = vm.envAddress("FEE_SINK");
        require(fee + protocolFee <= 100, "fees above 100 bps (1%)");
        require(sink.code.length > 0, "FEE_SINK is not a deployed contract");
        require(V3_FACTORY.code.length > 0, "v3 factory missing");
        require(POOL_MANAGER.code.length > 0, "v4 PoolManager missing");
        require(WETH.code.length > 0, "WETH missing");

        vm.startBroadcast();
        RouterTakestock router = new RouterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        QuoterTakestock quoter = new QuoterTakestock(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        BookTakestock book = new BookTakestock(IRouterTakestock(address(router)), fee, protocolFee, sink);
        vm.stopBroadcast();

        console2.log("ROUTER=", address(router));
        console2.log("QUOTER=", address(quoter));
        console2.log("BOOK=", address(book));
        console2.log("fillerFeeBps=", fee);
        console2.log("protocolFeeBps=", protocolFee);
        console2.log("FEE_SINK=", sink);
    }
}
