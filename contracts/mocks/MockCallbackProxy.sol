// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "../reactive/interfaces/IPayable.sol";
import { IPayer } from "../reactive/interfaces/IPayer.sol";

/// @title MockCallbackProxy
/// @notice Faithful simulator of Reactive Omni Callback Proxy on destination chains:
///         overwrites the first 160-bit address argument in payload with reactiveSender_
///         and executes the target callback + fee settlement via pay().
contract MockCallbackProxy is IPayable {
    mapping(address => uint256) public debts;
    mapping(address => uint256) public reserves;

    event CallbackDelivered(address indexed recipient, address indexed reactiveSender, bool success);

    receive() external payable {
        uint256 d = debts[msg.sender];
        if (msg.value >= d) {
            debts[msg.sender] = 0;
            reserves[msg.sender] += (msg.value - d);
        } else {
            debts[msg.sender] = d - msg.value;
        }
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

    /// @notice Delivers a Reactive Omni callback by injecting reactiveSender_ into the first
    ///         ABI argument (bytes 4..36, lower 20 bytes) exactly as the live Omni proxy does.
    function deliverCallback(
        address recipient_,
        address reactiveSender_,
        uint64 gasLimit_,
        bytes memory payload_,
        uint256 mockFee_
    ) external returns (bool success) {
        require(payload_.length >= 36, "PayloadTooShort");
        require(debts[recipient_] == 0, "InDebt");

        // Inject reactiveSender_ into first 32-byte ABI slot after 4-byte selector
        bytes memory patched = new bytes(payload_.length);
        for (uint256 i = 0; i < payload_.length; i++) {
            patched[i] = payload_[i];
        }
        bytes32 senderWord = bytes32(uint256(uint160(reactiveSender_)));
        for (uint256 j = 0; j < 32; j++) {
            patched[4 + j] = senderWord[j];
        }

        (success, ) = recipient_.call{ gas: gasLimit_ }(patched);

        if (mockFee_ > 0) {
            if (reserves[recipient_] >= mockFee_) {
                reserves[recipient_] -= mockFee_;
            } else {
                uint256 owed = mockFee_ - reserves[recipient_];
                reserves[recipient_] = 0;
                IPayer(payable(recipient_)).pay(owed);
            }
        }

        emit CallbackDelivered(recipient_, reactiveSender_, success);
    }
}
