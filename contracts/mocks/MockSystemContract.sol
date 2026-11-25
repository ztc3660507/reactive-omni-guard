// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "../reactive/interfaces/ISystemContract.sol";
import { IReactive } from "../reactive/interfaces/IReactive.sol";

/// @title MockSystemContract
/// @notice Faithful local Hardhat simulator for Reactive Omni System Contract (0x8888...8888).
contract MockSystemContract is ISystemContract {
    struct Subscription {
        address subscriber;
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bool active;
    }

    struct QueuedCallback {
        address reactiveSender;
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Subscription[] public subscriptions;
    QueuedCallback[] public callbacks;
    mapping(address => uint256) public debts;
    mapping(address => uint256) public reserves;

    event Subscribed(address indexed subscriber, uint256 chainId, address contractAddress, uint256 topic0);
    event CallbackRequest(
        uint256 indexed chainId,
        address indexed sender,
        address indexed recipient,
        CallbackVersion version,
        bytes configuration
    );

    receive() external payable {
        uint256 d = debts[msg.sender];
        if (msg.value >= d) {
            debts[msg.sender] = 0;
            reserves[msg.sender] += (msg.value - d);
        } else {
            debts[msg.sender] = d - msg.value;
        }
    }

    function clearState() external {
        delete subscriptions;
        delete callbacks;
    }

    function depositTo(address target_) external payable {
        uint256 d = debts[target_];
        if (msg.value >= d) {
            debts[target_] = 0;
            reserves[target_] += (msg.value - d);
        } else {
            debts[target_] = d - msg.value;
        }
    }

    function setDebt(address target_, uint256 amount_) external {
        debts[target_] = amount_;
    }

    function debt(address contract_) external view returns (uint256) {
        return debts[contract_];
    }

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external {
        subscriptions.push(
            Subscription({
                subscriber: msg.sender,
                chainId: chainId_,
                contractAddress: contract_,
                topic0: topic0_,
                topic1: topic1_,
                topic2: topic2_,
                topic3: topic3_,
                active: true
            })
        );
        emit Subscribed(msg.sender, chainId_, contract_, topic0_);
    }

    function unsubscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external {
        for (uint256 i = 0; i < subscriptions.length; i++) {
            Subscription storage s = subscriptions[i];
            if (
                s.active &&
                s.subscriber == msg.sender &&
                s.chainId == chainId_ &&
                s.contractAddress == contract_ &&
                s.topic0 == topic0_ &&
                s.topic1 == topic1_ &&
                s.topic2 == topic2_ &&
                s.topic3 == topic3_
            ) {
                s.active = false;
            }
        }
    }

    function requestCallback(CallbackVersion version_, bytes memory config_) external {
        require(version_ == CallbackVersion.V_1_0, "InvalidCallbackVersion");
        CallbackConfiguration_V_1_0 memory cfg = abi.decode(config_, (CallbackConfiguration_V_1_0));
        _enqueue(cfg);
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external {
        _enqueue(config_);
    }

    function _enqueue(CallbackConfiguration_V_1_0 memory cfg) internal {
        require(cfg.gasLimit >= 100_000, "GasLimitTooLow");
        callbacks.push(
            QueuedCallback({
                reactiveSender: msg.sender,
                chainId: cfg.chainId,
                recipient: cfg.recipient,
                gasLimit: cfg.gasLimit,
                payload: cfg.payload
            })
        );
        emit CallbackRequest(
            cfg.chainId,
            msg.sender,
            cfg.recipient,
            CallbackVersion.V_1_0,
            abi.encode(cfg)
        );
    }

    /// @notice Test helper to deliver a LogRecord into a reactive contract as SYSTEM.
    function triggerReact(address reactiveContract_, IReactive.LogRecord calldata log_) external {
        IReactive(payable(reactiveContract_)).react(log_);
    }

    function getSubscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function getCallbackCount() external view returns (uint256) {
        return callbacks.length;
    }

    function getCallback(uint256 idx_) external view returns (QueuedCallback memory) {
        return callbacks[idx_];
    }
}
