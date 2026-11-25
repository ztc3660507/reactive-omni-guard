// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Minimal ERC-20 testnet token with public faucet for OmniGuard demos
contract OmniToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    address public immutable owner;
    uint256 public immutable faucetAmount;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error OnlyOwner();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 faucetAmount_
    ) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = msg.sender;
        faucetAmount = faucetAmount_;
    }

    function mint(address to_, uint256 amount_) external {
        if (msg.sender != owner) revert OnlyOwner();
        _mint(to_, amount_);
    }

    /// @notice Testnet faucet so any judge or user can test OmniGuard with 0 capital.
    function faucet() external {
        _mint(msg.sender, faucetAmount);
    }

    function approve(address spender_, uint256 amount_) external returns (bool) {
        allowance[msg.sender][spender_] = amount_;
        emit Approval(msg.sender, spender_, amount_);
        return true;
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        _transfer(msg.sender, to_, amount_);
        return true;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external returns (bool) {
        uint256 allowed = allowance[from_][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount_) revert InsufficientAllowance();
            allowance[from_][msg.sender] = allowed - amount_;
        }
        _transfer(from_, to_, amount_);
        return true;
    }

    function _mint(address to_, uint256 amount_) internal {
        totalSupply += amount_;
        balanceOf[to_] += amount_;
        emit Transfer(address(0), to_, amount_);
    }

    function _transfer(address from_, address to_, uint256 amount_) internal {
        uint256 bal = balanceOf[from_];
        if (bal < amount_) revert InsufficientBalance();
        unchecked {
            balanceOf[from_] = bal - amount_;
        }
        balanceOf[to_] += amount_;
        emit Transfer(from_, to_, amount_);
    }
}
