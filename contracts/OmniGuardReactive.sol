// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "./reactive/interfaces/ISystemContract.sol";
import { IReactive } from "./reactive/interfaces/IReactive.sol";
import { AbstractReactive } from "./reactive/base/AbstractReactive.sol";
import { IOmniGuard } from "./interfaces/IOmniGuard.sol";

/// @title OmniGuardReactive
/// @notice Autonomous stateful Reactive Smart Contract deployed on Reactive Lasna (Omni).
///         Subscribes to Base Sepolia price feeds and vault lifecycle events, maintains
///         per-position high-water marks (HWM), rolling EWMA price state, and anti-duplicate
///         callback locks, and dispatches V_1_0 cross-chain callbacks to OmniGuardVault
///         the instant a trailing stop-loss, take-profit, or flash-crash condition triggers.
contract OmniGuardReactive is AbstractReactive {
    uint64 public constant CALLBACK_GAS_LIMIT = 500_000;
    uint256 public constant BPS_DENOM = 10_000;
    uint256 public constant EWMA_ALPHA_BPS = 2_500; // 25% weight on latest tick
    uint256 public constant MAX_POSITIONS_SCAN = 25;

    uint256 public constant PRICE_SYNC_TOPIC0 =
        uint256(keccak256("PriceSync(uint256,uint256,uint256,uint256,uint256)"));
    uint256 public constant POSITION_ARMED_TOPIC0 =
        uint256(keccak256("PositionArmed(uint256,address,uint256,uint256,uint16,uint256,uint16)"));
    uint256 public constant POSITION_DISARMED_TOPIC0 =
        uint256(keccak256("PositionDisarmed(uint256,address)"));
    uint256 public constant GUARD_EXECUTED_TOPIC0 =
        uint256(keccak256("GuardExecuted(uint256,address,uint8,uint256,uint256,uint256,uint256,uint256)"));

    struct GuardState {
        address owner;
        uint256 entryPrice;
        uint256 highWaterMark;
        uint256 takeProfitPrice;
        uint16 trailingBps;
        uint16 crashDropBps;
        bool active;
        bool pendingCallback;
        uint256 activeIndex;
    }

    address public immutable owner;
    uint256 public immutable originChainId;
    address public immutable pricePool;

    address public vault;
    bool public vaultConfigured;

    uint256 public lastSpotPrice;
    uint256 public ewmaPrice;
    uint256 public lastEpoch;
    uint256 public priceTicksProcessed;
    uint256 public callbacksRequested;
    uint256 public callbacksConfirmed;

    mapping(uint256 => GuardState) public guards;
    uint256[] public activePositionIds;

    event VaultConfigured(address indexed vault);
    event GuardRegistered(
        uint256 indexed positionId,
        address indexed owner,
        uint256 entryPrice,
        uint16 trailingBps,
        uint256 takeProfitPrice,
        uint16 crashDropBps
    );
    event GuardRemoved(uint256 indexed positionId, bool settledByCallback);
    event HighWaterMarkRatcheted(
        uint256 indexed positionId,
        uint256 newHighWaterMark,
        uint256 newTrailingStopPrice
    );
    event GuardCallbackRequested(
        uint256 indexed positionId,
        uint8 indexed reason,
        uint256 triggerPrice,
        uint256 highWaterMark,
        uint256 epoch
    );

    error OnlyOwner();
    error InvalidAddress();
    error VaultAlreadyConfigured();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @param originChainId_ Origin & destination chain ID (84532 for Base Sepolia)
    /// @param pricePool_ OmniPricePool address on Base Sepolia
    constructor(uint256 originChainId_, address pricePool_) payable {
        if (pricePool_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        originChainId = originChainId_;
        pricePool = pricePool_;

        // Subscribe immediately to AMM PriceSync events on Base Sepolia
        SYSTEM.subscribe(
            originChainId_,
            pricePool_,
            PRICE_SYNC_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
    }

    /// @notice Wires the deployed OmniGuardVault (after two-step Omni deployment order)
    ///         and dynamically subscribes to its lifecycle events on Base Sepolia.
    function configureVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert InvalidAddress();
        if (vaultConfigured) revert VaultAlreadyConfigured();

        vault = vault_;
        vaultConfigured = true;

        SYSTEM.subscribe(
            originChainId,
            vault_,
            POSITION_ARMED_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        SYSTEM.subscribe(
            originChainId,
            vault_,
            POSITION_DISARMED_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        SYSTEM.subscribe(
            originChainId,
            vault_,
            GUARD_EXECUTED_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );

        emit VaultConfigured(vault_);
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != originChainId) {
            return;
        }

        if (log_.contractAddress == vault && vaultConfigured) {
            if (log_.topic0 == POSITION_ARMED_TOPIC0 && log_.opCode == 3) {
                _handlePositionArmed(log_);
            } else if (log_.topic0 == POSITION_DISARMED_TOPIC0 && log_.opCode == 3) {
                _removeActiveGuard(log_.topic1, false);
            } else if (log_.topic0 == GUARD_EXECUTED_TOPIC0 && log_.opCode == 3) {
                unchecked {
                    callbacksConfirmed += 1;
                }
                _removeActiveGuard(log_.topic1, true);
            }
            return;
        }

        if (log_.contractAddress == pricePool && log_.topic0 == PRICE_SYNC_TOPIC0 && log_.opCode == 2) {
            _handlePriceSync(log_);
        }
    }

    /// @notice Settles any outstanding debt to the Reactive System Contract.
    function coverDebt() external {
        _coverDebt();
    }

    function getActivePositionIds() external view returns (uint256[] memory) {
        return activePositionIds;
    }

    function getGuardState(uint256 positionId_) external view returns (GuardState memory) {
        return guards[positionId_];
    }

    function getReactiveStats()
        external
        view
        returns (
            uint256 activeCount,
            uint256 ticksProcessed,
            uint256 requestedCount,
            uint256 confirmedCount,
            uint256 spot,
            uint256 ewma,
            uint256 systemDebt,
            uint256 reactBalance
        )
    {
        return (
            activePositionIds.length,
            priceTicksProcessed,
            callbacksRequested,
            callbacksConfirmed,
            lastSpotPrice,
            ewmaPrice,
            SYSTEM.debt(address(this)),
            address(this).balance
        );
    }

    function _handlePositionArmed(LogRecord calldata log_) internal {
        uint256 positionId = log_.topic1;
        address posOwner = address(uint160(log_.topic2));

        (
            , // wethAmount
            uint256 entryPrice,
            uint16 trailingBps,
            uint256 takeProfitPrice,
            uint16 crashDropBps
        ) = abi.decode(log_.data, (uint256, uint256, uint16, uint256, uint16));

        GuardState storage g = guards[positionId];
        if (g.active) {
            return;
        }

        uint256 initialHwm = entryPrice;
        if (lastSpotPrice > initialHwm) {
            initialHwm = lastSpotPrice;
        }

        g.owner = posOwner;
        g.entryPrice = entryPrice;
        g.highWaterMark = initialHwm;
        g.takeProfitPrice = takeProfitPrice;
        g.trailingBps = trailingBps;
        g.crashDropBps = crashDropBps;
        g.active = true;
        g.pendingCallback = false;
        g.activeIndex = activePositionIds.length;

        activePositionIds.push(positionId);

        emit GuardRegistered(
            positionId,
            posOwner,
            entryPrice,
            trailingBps,
            takeProfitPrice,
            crashDropBps
        );
    }

    function _handlePriceSync(LogRecord calldata log_) internal {
        uint256 epoch = log_.topic1;
        (uint256 spotPrice, , , ) = abi.decode(log_.data, (uint256, uint256, uint256, uint256));

        uint256 prevPrice = lastSpotPrice;
        uint256 singleTickDropBps = 0;
        if (prevPrice > 0 && spotPrice < prevPrice) {
            singleTickDropBps = ((prevPrice - spotPrice) * BPS_DENOM) / prevPrice;
        }

        if (ewmaPrice == 0) {
            ewmaPrice = spotPrice;
        } else {
            ewmaPrice =
                ((spotPrice * EWMA_ALPHA_BPS) + (ewmaPrice * (BPS_DENOM - EWMA_ALPHA_BPS))) /
                BPS_DENOM;
        }

        lastSpotPrice = spotPrice;
        lastEpoch = epoch;
        unchecked {
            priceTicksProcessed += 1;
        }

        if (!vaultConfigured) {
            return;
        }

        uint256 len = activePositionIds.length;
        uint256 limit = len > MAX_POSITIONS_SCAN ? MAX_POSITIONS_SCAN : len;

        for (uint256 i = 0; i < limit; ) {
            uint256 posId = activePositionIds[i];
            GuardState storage g = guards[posId];

            if (g.active && !g.pendingCallback) {
                // 1. Ratchet high-water mark upward during rallies
                if (spotPrice > g.highWaterMark) {
                    g.highWaterMark = spotPrice;
                    uint256 newStop = g.trailingBps > 0
                        ? (spotPrice * (BPS_DENOM - g.trailingBps)) / BPS_DENOM
                        : 0;
                    emit HighWaterMarkRatcheted(posId, spotPrice, newStop);
                }

                // 2. Evaluate trigger conditions in strict risk-priority order
                uint8 reason = 0;
                if (g.crashDropBps > 0 && singleTickDropBps >= g.crashDropBps) {
                    reason = uint8(IOmniGuard.TriggerReason.FlashCrashBreaker);
                } else if (g.trailingBps > 0) {
                    uint256 trailingStopPrice = (g.highWaterMark * (BPS_DENOM - g.trailingBps)) /
                        BPS_DENOM;
                    if (spotPrice <= trailingStopPrice) {
                        reason = uint8(IOmniGuard.TriggerReason.TrailingStopLoss);
                    }
                }
                if (reason == 0 && g.takeProfitPrice > 0 && spotPrice >= g.takeProfitPrice) {
                    reason = uint8(IOmniGuard.TriggerReason.TakeProfit);
                }

                // 3. Dispatch Reactive Omni V_1_0 callback with anti-duplicate lock
                if (reason != 0) {
                    g.pendingCallback = true;
                    unchecked {
                        callbacksRequested += 1;
                    }

                    bytes memory payload = abi.encodeWithSignature(
                        "executeGuardCallback(address,uint256,uint8,uint256,uint256)",
                        address(0), // overwritten by Reactive Network with address(this)
                        posId,
                        reason,
                        spotPrice,
                        g.highWaterMark
                    );

                    SYSTEM.requestCallbackV_1_0(
                        ISystemContract.CallbackConfiguration_V_1_0({
                            chainId: originChainId,
                            recipient: vault,
                            gasLimit: CALLBACK_GAS_LIMIT,
                            payload: payload
                        })
                    );

                    emit GuardCallbackRequested(posId, reason, spotPrice, g.highWaterMark, epoch);
                }
            }

            unchecked {
                i += 1;
            }
        }
    }

    function _removeActiveGuard(uint256 positionId_, bool settledByCallback_) internal {
        GuardState storage g = guards[positionId_];
        if (!g.active) {
            return;
        }

        uint256 idx = g.activeIndex;
        uint256 lastIdx = activePositionIds.length - 1;
        if (idx != lastIdx) {
            uint256 movedId = activePositionIds[lastIdx];
            activePositionIds[idx] = movedId;
            guards[movedId].activeIndex = idx;
        }
        activePositionIds.pop();

        g.active = false;
        g.pendingCallback = false;
        g.activeIndex = 0;

        emit GuardRemoved(positionId_, settledByCallback_);
    }
}
