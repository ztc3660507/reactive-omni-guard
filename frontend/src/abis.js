export const POOL_ABI = [
  "function getSpotPrice() view returns (uint256)",
  "function epoch() view returns (uint256)",
  "function reserveWeth() view returns (uint256)",
  "function reserveUsdc() view returns (uint256)",
  "function simulateMarketPrice(uint256 targetSpotPrice) external",
];

export const VAULT_ABI = [
  "function nextPositionId() view returns (uint256)",
  "function getPosition(uint256 positionId) view returns (tuple(address owner, uint256 wethAmount, uint256 entryPrice, uint256 takeProfitPrice, uint16 trailingBps, uint16 crashDropBps, uint8 status, uint8 executedReason, uint256 triggerPrice, uint256 highWaterMark, uint256 executionPrice, uint256 usdcOut, uint256 armedAt, uint256 executedAt))",
  "function getVaultStats() view returns (uint256 armedCount, uint256 executedCount, uint256 protectedUsdc, uint256 proxyDebt, uint256 ethBalance)",
  "function openAndArmPosition(uint256 wethAmount, uint16 trailingBps, uint256 takeProfitPrice, uint16 crashDropBps) external returns (uint256)",
  "function disarmAndWithdraw(uint256 positionId) external",
];

export const REACTIVE_ABI = [
  "function getActivePositionIds() view returns (uint256[])",
  "function getGuardState(uint256 positionId) view returns (tuple(address owner, uint256 entryPrice, uint256 highWaterMark, uint256 takeProfitPrice, uint16 trailingBps, uint16 crashDropBps, bool active, bool pendingCallback, uint256 activeIndex))",
  "function getReactiveStats() view returns (uint256 activeCount, uint256 ticksProcessed, uint256 requestedCount, uint256 confirmedCount, uint256 spot, uint256 ewma, uint256 systemDebt, uint256 reactBalance)",
];

export const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function faucet() external",
  "function approve(address spender, uint256 amount) external returns (bool)",
];
