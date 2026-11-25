// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "./reactive/interfaces/IPayable.sol";
import { AbstractCallback } from "./reactive/base/AbstractCallback.sol";
import { OmniToken } from "./OmniToken.sol";
import { IOmniGuard, IOmniPricePool } from "./interfaces/IOmniGuard.sol";

/// @title OmniGuardVault
/// @notice Base Sepolia destination callback vault powered by Reactive Omni.
///         Users deposit WETH and arm keeper-less trailing stop-loss, take-profit,
///         and flash-crash shields entirely on Base Sepolia. When Reactive Lasna
///         detects a trigger condition, the Base Sepolia Callback Proxy invokes
///         executeGuardCallback() to atomically swap WETH -> USDC and deliver
///         protected USDC directly to the user's wallet.
contract OmniGuardVault is AbstractCallback, IOmniGuard {
    uint16 public constant MAX_BPS = 5_000; // max 50%

    IOmniPricePool public immutable pool;
    OmniToken public immutable weth;
    OmniToken public immutable usdc;

    uint256 public nextPositionId = 1;
    uint256 public totalArmedCount;
    uint256 public totalExecutedCount;
    uint256 public totalProtectedUsdc;

    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _userPositionIds;

    /// @notice Emitted instead of reverting if a callback arrives after manual disarm/execution.
    event GuardSkipped(uint256 indexed positionId, uint8 currentStatus);

    error InvalidAmount();
    error InvalidGuardConfig();
    error NotPositionOwner();
    error PositionNotArmed();

    /// @param callbackProxy_ Official Base Sepolia Callback Proxy (0x476F44b11F5C942c58f4c8E3d0300E5710743585)
    /// @param callbackSender_ Deployed OmniGuardReactive address on Reactive Lasna
    /// @param pool_ Deployed OmniPricePool address on Base Sepolia
    /// @param weth_ oWETH token address
    /// @param usdc_ oUSDC token address
    constructor(
        IPayable callbackProxy_,
        address callbackSender_,
        address pool_,
        address weth_,
        address usdc_
    ) payable AbstractCallback(callbackProxy_, callbackSender_) {
        pool = IOmniPricePool(pool_);
        weth = OmniToken(weth_);
        usdc = OmniToken(usdc_);
    }

    /// @notice Deposits WETH collateral and arms autonomous Reactive Omni protection.
    /// @param wethAmount_ Amount of oWETH (18 decimals) to protect.
    /// @param trailingBps_ Trailing stop drawdown in basis points (e.g., 500 = 5%). 0 disables.
    /// @param takeProfitPrice_ Hard take-profit target in 6-decimal USDC. 0 disables.
    /// @param crashDropBps_ Single-tick flash-crash circuit breaker in bps (e.g., 800 = 8%). 0 disables.
    function openAndArmPosition(
        uint256 wethAmount_,
        uint16 trailingBps_,
        uint256 takeProfitPrice_,
        uint16 crashDropBps_
    ) external returns (uint256 positionId) {
        if (wethAmount_ == 0) revert InvalidAmount();
        if (trailingBps_ > MAX_BPS || crashDropBps_ > MAX_BPS) revert InvalidGuardConfig();
        if (trailingBps_ == 0 && takeProfitPrice_ == 0 && crashDropBps_ == 0) {
            revert InvalidGuardConfig();
        }

        uint256 entryPrice = pool.getSpotPrice();
        if (takeProfitPrice_ != 0 && takeProfitPrice_ <= entryPrice) {
            revert InvalidGuardConfig();
        }

        weth.transferFrom(msg.sender, address(this), wethAmount_);

        positionId = nextPositionId++;
        _positions[positionId] = Position({
            owner: msg.sender,
            wethAmount: wethAmount_,
            entryPrice: entryPrice,
            takeProfitPrice: takeProfitPrice_,
            trailingBps: trailingBps_,
            crashDropBps: crashDropBps_,
            status: PositionStatus.Armed,
            executedReason: TriggerReason.None,
            triggerPrice: 0,
            highWaterMark: entryPrice,
            executionPrice: 0,
            usdcOut: 0,
            armedAt: block.timestamp,
            executedAt: 0
        });

        _userPositionIds[msg.sender].push(positionId);
        unchecked {
            totalArmedCount += 1;
        }

        emit PositionArmed(
            positionId,
            msg.sender,
            wethAmount_,
            entryPrice,
            trailingBps_,
            takeProfitPrice_,
            crashDropBps_
        );
    }

    /// @notice Allows position owner to manually cancel protection and reclaim WETH.
    function disarmAndWithdraw(uint256 positionId_) external {
        Position storage pos = _positions[positionId_];
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (pos.status != PositionStatus.Armed) revert PositionNotArmed();

        pos.status = PositionStatus.Disarmed;
        weth.transfer(msg.sender, pos.wethAmount);

        emit PositionDisarmed(positionId_, msg.sender);
    }

    /// @notice Destination callback invoked by Base Sepolia Callback Proxy when
    ///         OmniGuardReactive on Lasna triggers a stop-loss, take-profit, or crash exit.
    /// @dev First argument `reactive_` is overwritten by Reactive Network with the calling
    ///      reactive contract address and verified by `onlyCallbackSender`.
    function executeGuardCallback(
        address reactive_,
        uint256 positionId_,
        uint8 reason_,
        uint256 triggerPrice_,
        uint256 highWaterMark_
    ) external onlyServiceProvider onlyCallbackSender(reactive_) {
        Position storage pos = _positions[positionId_];

        // Graceful no-op instead of reverting if position was already settled/disarmed,
        // preventing wasted CallbackFailure gas charges on Reactive Omni.
        if (pos.status != PositionStatus.Armed) {
            emit GuardSkipped(positionId_, uint8(pos.status));
            return;
        }

        pos.status = PositionStatus.Executed;
        pos.executedReason = TriggerReason(reason_);
        pos.triggerPrice = triggerPrice_;
        pos.highWaterMark = highWaterMark_;
        pos.executedAt = block.timestamp;

        weth.approve(address(pool), pos.wethAmount);
        uint256 usdcOut = pool.swapExactWethForUsdc(pos.wethAmount, 0, pos.owner);
        uint256 execPrice = pool.getSpotPrice();

        pos.executionPrice = execPrice;
        pos.usdcOut = usdcOut;

        unchecked {
            totalExecutedCount += 1;
            totalProtectedUsdc += usdcOut;
        }

        emit GuardExecuted(
            positionId_,
            pos.owner,
            reason_,
            triggerPrice_,
            highWaterMark_,
            execPrice,
            usdcOut,
            block.timestamp
        );
    }

    /// @notice Publicly callable debt settlement helper per Reactive Omni best practices.
    function coverDebt() external {
        _coverDebt();
    }

    function getPosition(uint256 positionId_) external view returns (Position memory) {
        return _positions[positionId_];
    }

    function getUserPositionIds(address user_) external view returns (uint256[] memory) {
        return _userPositionIds[user_];
    }

    function getVaultStats()
        external
        view
        returns (
            uint256 armedCount,
            uint256 executedCount,
            uint256 protectedUsdc,
            uint256 proxyDebt,
            uint256 ethBalance
        )
    {
        return (
            totalArmedCount,
            totalExecutedCount,
            totalProtectedUsdc,
            _SERVICE_PROVIDER.debt(address(this)),
            address(this).balance
        );
    }
}
