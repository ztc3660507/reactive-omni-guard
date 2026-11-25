// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { OmniToken } from "./OmniToken.sol";
import { IOmniGuard, IOmniPricePool } from "./interfaces/IOmniGuard.sol";

/// @title OmniPricePool
/// @notice Constant-product WETH/USDC AMM pool on Base Sepolia that emits PriceSync
///         on every trade or market move so Reactive Omni monitors price in real time.
contract OmniPricePool is IOmniGuard, IOmniPricePool {
    uint256 private constant FEE_BPS = 30; // 0.30% swap fee
    uint256 private constant BPS_DENOM = 10_000;

    address public immutable owner;
    OmniToken public immutable weth;
    OmniToken public immutable usdc;

    uint256 public reserveWeth; // 18 decimals
    uint256 public reserveUsdc; // 6 decimals
    uint256 public epoch;

    event Swap(
        address indexed sender,
        address indexed recipient,
        bool wethToUsdc,
        uint256 amountIn,
        uint256 amountOut,
        uint256 spotPriceAfter
    );

    event LiquiditySeeded(uint256 wethAdded, uint256 usdcAdded, uint256 spotPrice);

    error OnlyOwner();
    error InvalidAmount();
    error PoolNotInitialized();
    error SlippageExceeded();
    error InvalidTargetPrice();

    constructor(address weth_, address usdc_) {
        owner = msg.sender;
        weth = OmniToken(weth_);
        usdc = OmniToken(usdc_);
    }

    /// @notice Seeds or adds liquidity to the pool and emits a fresh PriceSync.
    function seedLiquidity(uint256 wethAmount_, uint256 usdcAmount_) external {
        if (wethAmount_ == 0 || usdcAmount_ == 0) revert InvalidAmount();
        weth.transferFrom(msg.sender, address(this), wethAmount_);
        usdc.transferFrom(msg.sender, address(this), usdcAmount_);

        reserveWeth += wethAmount_;
        reserveUsdc += usdcAmount_;

        uint256 spot = getSpotPrice();
        emit LiquiditySeeded(wethAmount_, usdcAmount_, spot);
        _emitPriceSync(spot);
    }

    /// @notice Returns current spot price of 1 WETH in 6-decimal USDC (e.g., 3000_000000 = $3,000.00).
    function getSpotPrice() public view returns (uint256) {
        if (reserveWeth == 0) revert PoolNotInitialized();
        return (reserveUsdc * 1e18) / reserveWeth;
    }

    /// @notice Quote USDC output for a WETH input using constant-product formula.
    function quoteWethToUsdc(uint256 wethIn_) public view returns (uint256) {
        if (reserveWeth == 0 || reserveUsdc == 0) revert PoolNotInitialized();
        uint256 amountInWithFee = wethIn_ * (BPS_DENOM - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveUsdc;
        uint256 denominator = (reserveWeth * BPS_DENOM) + amountInWithFee;
        return numerator / denominator;
    }

    /// @notice Quote WETH output for a USDC input using constant-product formula.
    function quoteUsdcToWeth(uint256 usdcIn_) public view returns (uint256) {
        if (reserveWeth == 0 || reserveUsdc == 0) revert PoolNotInitialized();
        uint256 amountInWithFee = usdcIn_ * (BPS_DENOM - FEE_BPS);
        uint256 numerator = amountInWithFee * reserveWeth;
        uint256 denominator = (reserveUsdc * BPS_DENOM) + amountInWithFee;
        return numerator / denominator;
    }

    /// @notice Swaps exact WETH for USDC and emits PriceSync for Reactive Omni.
    function swapExactWethForUsdc(
        uint256 wethIn_,
        uint256 minUsdcOut_,
        address recipient_
    ) external returns (uint256 usdcOut) {
        if (wethIn_ == 0) revert InvalidAmount();
        usdcOut = quoteWethToUsdc(wethIn_);
        if (usdcOut < minUsdcOut_) revert SlippageExceeded();

        weth.transferFrom(msg.sender, address(this), wethIn_);
        reserveWeth += wethIn_;
        reserveUsdc -= usdcOut;
        usdc.transfer(recipient_, usdcOut);

        uint256 spot = getSpotPrice();
        emit Swap(msg.sender, recipient_, true, wethIn_, usdcOut, spot);
        _emitPriceSync(spot);
    }

    /// @notice Swaps exact USDC for WETH and emits PriceSync for Reactive Omni.
    function swapExactUsdcForWeth(
        uint256 usdcIn_,
        uint256 minWethOut_,
        address recipient_
    ) external returns (uint256 wethOut) {
        if (usdcIn_ == 0) revert InvalidAmount();
        wethOut = quoteUsdcToWeth(usdcIn_);
        if (wethOut < minWethOut_) revert SlippageExceeded();

        usdc.transferFrom(msg.sender, address(this), usdcIn_);
        reserveUsdc += usdcIn_;
        reserveWeth -= wethOut;
        weth.transfer(recipient_, wethOut);

        uint256 spot = getSpotPrice();
        emit Swap(msg.sender, recipient_, false, usdcIn_, wethOut, spot);
        _emitPriceSync(spot);
    }

    /// @notice Testnet market-simulator helper: adjusts virtual reserve ratio to a target
    ///         USDC/WETH price (keeping actual USDC balance >= reserveUsdc) and emits PriceSync.
    ///         Allows live demoing of rallies (+12%), pullbacks (-6%), and flash crashes (-10%)
    ///         in a single transaction on Base Sepolia!
    function simulateMarketPrice(uint256 targetSpotPrice_) external {
        if (reserveWeth == 0) revert PoolNotInitialized();
        if (targetSpotPrice_ < 100e6 || targetSpotPrice_ > 50_000e6) revert InvalidTargetPrice();

        uint256 neededUsdc = (reserveWeth * targetSpotPrice_) / 1e18;
        uint256 actualUsdc = usdc.balanceOf(address(this));
        if (neededUsdc > actualUsdc) {
            // Scale WETH reserve down to stay backed by actual USDC liquidity on hand
            reserveUsdc = actualUsdc;
            reserveWeth = (actualUsdc * 1e18) / targetSpotPrice_;
        } else {
            reserveUsdc = neededUsdc;
        }

        uint256 spot = getSpotPrice();
        _emitPriceSync(spot);
    }

    function _emitPriceSync(uint256 spotPrice_) internal {
        unchecked {
            epoch += 1;
        }
        emit PriceSync(epoch, spotPrice_, reserveWeth, reserveUsdc, block.timestamp);
    }
}
