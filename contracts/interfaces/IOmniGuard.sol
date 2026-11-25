// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Shared types and interfaces for OmniGuard (Reactive Omni x Base Sepolia)
interface IOmniGuard {
    enum TriggerReason {
        None,
        TrailingStopLoss,
        TakeProfit,
        FlashCrashBreaker
    }

    enum PositionStatus {
        None,
        Armed,
        Executed,
        Disarmed
    }

    struct Position {
        address owner;
        uint256 wethAmount;
        uint256 entryPrice;       // 6-decimal USDC per 1 WETH
        uint256 takeProfitPrice;  // 6-decimal USDC per 1 WETH (0 = disabled)
        uint16 trailingBps;       // e.g. 500 = 5.00% trailing stop (0 = disabled)
        uint16 crashDropBps;      // e.g. 800 = 8.00% single-tick flash-crash shield (0 = disabled)
        PositionStatus status;
        TriggerReason executedReason;
        uint256 triggerPrice;
        uint256 highWaterMark;
        uint256 executionPrice;
        uint256 usdcOut;
        uint256 armedAt;
        uint256 executedAt;
    }

    /// @notice Emitted by OmniPricePool on every swap or market tick.
    event PriceSync(
        uint256 indexed epoch,
        uint256 spotPrice,
        uint256 reserveWeth,
        uint256 reserveUsdc,
        uint256 timestamp
    );

    /// @notice Emitted by OmniGuardVault when a user arms automated protection.
    event PositionArmed(
        uint256 indexed positionId,
        address indexed owner,
        uint256 wethAmount,
        uint256 entryPrice,
        uint16 trailingBps,
        uint256 takeProfitPrice,
        uint16 crashDropBps
    );

    /// @notice Emitted by OmniGuardVault when a user disarms and withdraws manually.
    event PositionDisarmed(
        uint256 indexed positionId,
        address indexed owner
    );

    /// @notice Emitted by OmniGuardVault when a Reactive Omni callback settles protection.
    event GuardExecuted(
        uint256 indexed positionId,
        address indexed owner,
        uint8 reason,
        uint256 triggerPrice,
        uint256 highWaterMark,
        uint256 executionPrice,
        uint256 usdcOut,
        uint256 timestamp
    );
}

interface IOmniPricePool {
    function getSpotPrice() external view returns (uint256);
    function swapExactWethForUsdc(uint256 wethIn, uint256 minUsdcOut, address recipient) external returns (uint256 usdcOut);
}
