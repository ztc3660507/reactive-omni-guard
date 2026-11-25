/**
 * Live End-to-End Cross-Chain Verification Script for Reactive Omni Buildathon.
 * Runs the REAL on-chain lifecycle across Base Sepolia (84532) <-> Reactive Lasna (5318007)
 * and records every origin tx, reactive tx, callback tx, and exact end-to-end latency!
 *
 * Output saved to live-proof.json and synced to frontend/src/live-proof.json.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

function loadArtifact(contractRelPath, contractName) {
  const full = path.join(__dirname, "..", "artifacts", "contracts", contractRelPath, `${contractName}.json`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

async function pollUntil(fn, label, timeoutMs = 90000, intervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fn();
    if (res) return { res, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function findRecentLogs(provider, address, iface, eventName, fromBlock) {
  const topic0 = iface.getEvent(eventName).topicHash;
  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address,
    topics: [topic0],
    fromBlock: Math.max(0, fromBlock),
    toBlock: latest,
  });
  return logs;
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.json"), "utf8"));
  const baseProvider = new ethers.JsonRpcProvider(manifest.networks.baseSepolia.rpcUrl);
  const lasnaProvider = new ethers.JsonRpcProvider(manifest.networks.lasna.rpcUrl);
  const baseWallet = new ethers.Wallet(pk, baseProvider);

  const tokenArt = loadArtifact("OmniToken.sol", "OmniToken");
  const poolArt = loadArtifact("OmniPricePool.sol", "OmniPricePool");
  const vaultArt = loadArtifact("OmniGuardVault.sol", "OmniGuardVault");
  const reactiveArt = loadArtifact("OmniGuardReactive.sol", "OmniGuardReactive");

  const weth = new ethers.Contract(manifest.contracts.oWETH, tokenArt.abi, baseWallet);
  const usdc = new ethers.Contract(manifest.contracts.oUSDC, tokenArt.abi, baseWallet);
  const pool = new ethers.Contract(manifest.contracts.omniPricePool, poolArt.abi, baseWallet);
  const vault = new ethers.Contract(manifest.contracts.omniGuardVault, vaultArt.abi, baseWallet);
  const reactive = new ethers.Contract(manifest.contracts.omniGuardReactive, reactiveArt.abi, lasnaProvider);

  const lasnaStartBlock = await lasnaProvider.getBlockNumber();
  const baseStartBlock = await baseProvider.getBlockNumber();

  const proof = {
    executedAt: new Date().toISOString(),
    contracts: manifest.contracts,
    steps: [],
    metrics: {},
  };

  console.log("=== OmniGuard Live Cross-Chain Proof (Base Sepolia <-> Reactive Lasna) ===");
  // Reset pool price cleanly to $3,000 if needed
  const currentSpot = await pool.getSpotPrice();
  if (currentSpot !== ethers.parseUnits("3000", 6)) {
    const resetTx = await pool.simulateMarketPrice(ethers.parseUnits("3000", 6));
    await resetTx.wait();
    console.log("Reset pool spot price to $3,000.00");
  }

  // Step 1: Arm a 2 oWETH Trailing Stop-Loss position (5% trailing stop, $4,500 TP, 12% crash breaker)
  console.log("\n[Step 1] Arming 2 oWETH position on Base Sepolia (5% trailing stop)...");
  await (await weth.approve(manifest.contracts.omniGuardVault, ethers.MaxUint256)).wait();
  const tArmStart = Date.now();
  const armTx = await vault.openAndArmPosition(
    ethers.parseEther("2"),
    500, // 5% trailing stop
    ethers.parseUnits("4500", 6),
    1200 // 12% single-tick flash crash shield
  );
  const armRcpt = await armTx.wait();
  const armBlock = await baseProvider.getBlock(armRcpt.blockNumber);
  const armedParsed = armRcpt.logs
    .map((l) => {
      try {
        return vault.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "PositionArmed");
  const posId = Number(armedParsed.args.positionId);
  console.log(`  Position #${posId} armed on Base Sepolia! Tx: ${armTx.hash}`);

  // Wait for Lasna to auto-mirror PositionArmed!
  console.log("  Waiting for Reactive Lasna to mirror PositionArmed via react()...");
  const { res: regLogs, elapsedMs: armSyncMs } = await pollUntil(async () => {
    const g = await reactive.getGuardState(posId);
    if (!g.active) return null;
    const logs = await findRecentLogs(lasnaProvider, manifest.contracts.omniGuardReactive, reactive.interface, "GuardRegistered", lasnaStartBlock);
    return logs.length ? logs[logs.length - 1] : { transactionHash: "confirmed-state", blockNumber: await lasnaProvider.getBlockNumber() };
  }, "Lasna GuardRegistered");
  const regBlock = await lasnaProvider.getBlock(regLogs.blockNumber);
  console.log(`  Mirrored on Lasna! Tx: ${regLogs.transactionHash} (wall: ${armSyncMs}ms)`);

  proof.steps.push({
    step: 1,
    label: "Arm Trailing Stop Position (Base Sepolia -> Lasna Auto-Mirror)",
    positionId: posId,
    originTx: armTx.hash,
    originBlock: armRcpt.blockNumber,
    originTimestamp: armBlock.timestamp,
    reactiveTx: regLogs.transactionHash,
    reactiveBlock: regLogs.blockNumber,
    reactiveTimestamp: regBlock ? regBlock.timestamp : null,
    wallLatencyMs: armSyncMs,
  });

  // Step 2: Market Rally ($3,000 -> $3,400, +13.33%) -> Lasna ratchets HWM to $3,400 (new stop = $3,230)
  console.log("\n[Step 2] Simulating market rally ($3,000 -> $3,400) on Base Sepolia...");
  const rallyLasnaStart = await lasnaProvider.getBlockNumber();
  const rallyTx = await pool.simulateMarketPrice(ethers.parseUnits("3400", 6));
  const rallyRcpt = await rallyTx.wait();
  const rallyBlock = await baseProvider.getBlock(rallyRcpt.blockNumber);
  console.log(`  Rally PriceSync Tx (Base Sepolia): ${rallyTx.hash}`);

  console.log("  Waiting for Lasna to ratchet High-Water Mark -> $3,400...");
  const { res: hwmLog, elapsedMs: rallySyncMs } = await pollUntil(async () => {
    const g = await reactive.getGuardState(posId);
    if (g.highWaterMark < ethers.parseUnits("3400", 6)) return null;
    const logs = await findRecentLogs(lasnaProvider, manifest.contracts.omniGuardReactive, reactive.interface, "HighWaterMarkRatcheted", rallyLasnaStart);
    return logs.length ? logs[logs.length - 1] : { transactionHash: "confirmed-hwm", blockNumber: await lasnaProvider.getBlockNumber() };
  }, "Lasna HighWaterMarkRatcheted");
  const hwmBlock = await lasnaProvider.getBlock(hwmLog.blockNumber);
  console.log(`  HWM ratcheted on Lasna to $3,400 (Stop = $3,230)! Tx: ${hwmLog.transactionHash} (wall: ${rallySyncMs}ms)`);

  proof.steps.push({
    step: 2,
    label: "Market Rally +13.3% ($3,000 -> $3,400): Stateful HWM Ratchet on Lasna",
    originTx: rallyTx.hash,
    originBlock: rallyRcpt.blockNumber,
    originTimestamp: rallyBlock.timestamp,
    reactiveTx: hwmLog.transactionHash,
    reactiveBlock: hwmLog.blockNumber,
    reactiveTimestamp: hwmBlock ? hwmBlock.timestamp : null,
    newHighWaterMarkUsd: 3400,
    newTrailingStopUsd: 3230,
    wallLatencyMs: rallySyncMs,
  });

  // Step 3: Pullback ($3,400 -> $3,200, breaches $3,230 trailing stop!) -> Lasna fires Callback -> Base Sepolia executes swap!
  console.log("\n[Step 3] Simulating pullback ($3,400 -> $3,200) breaching $3,230 trailing stop...");
  const triggerLasnaStart = await lasnaProvider.getBlockNumber();
  const triggerBaseStart = await baseProvider.getBlockNumber();
  const usdcBefore = await usdc.balanceOf(baseWallet.address);

  const dropTx = await pool.simulateMarketPrice(ethers.parseUnits("3200", 6));
  const dropRcpt = await dropTx.wait();
  const dropBlock = await baseProvider.getBlock(dropRcpt.blockNumber);
  const tDropConfirmed = Date.now();
  console.log(`  Trigger PriceSync Tx (Base Sepolia): ${dropTx.hash} (block ${dropRcpt.blockNumber})`);

  console.log("  Waiting for Lasna GuardCallbackRequested...");
  const { res: cbReqLog, elapsedMs: toLasnaMs } = await pollUntil(async () => {
    const logs = await findRecentLogs(lasnaProvider, manifest.contracts.omniGuardReactive, reactive.interface, "GuardCallbackRequested", triggerLasnaStart);
    return logs.length ? logs[logs.length - 1] : null;
  }, "Lasna GuardCallbackRequested");
  const cbReqBlock = await lasnaProvider.getBlock(cbReqLog.blockNumber);
  console.log(`  Reactive Callback Requested on Lasna! Tx: ${cbReqLog.transactionHash} (+${toLasnaMs}ms)`);

  console.log("  Waiting for Base Sepolia Callback Proxy to invoke OmniGuardVault.executeGuardCallback()...");
  const { res: execLog, elapsedMs: totalCallbackMs } = await pollUntil(async () => {
    const logs = await findRecentLogs(baseProvider, manifest.contracts.omniGuardVault, vault.interface, "GuardExecuted", triggerBaseStart);
    return logs.length ? logs[logs.length - 1] : null;
  }, "Base Sepolia GuardExecuted", 120000, 1500);
  const execBlock = await baseProvider.getBlock(execLog.blockNumber);
  const e2eWallMs = Date.now() - tDropConfirmed;
  const e2eBlockDeltaSec = execBlock.timestamp - dropBlock.timestamp;
  const usdcAfter = await usdc.balanceOf(baseWallet.address);
  const protectedUsdc = Number(usdcAfter - usdcBefore) / 1e6;

  console.log(`  SUCCESS! Callback Executed on Base Sepolia!`);
  console.log(`    Callback Tx (Base Sepolia): ${execLog.transactionHash} (block ${execLog.blockNumber})`);
  console.log(`    Protected USDC Delivered:   $${protectedUsdc.toFixed(2)} oUSDC`);
  console.log(`    On-Chain Block Latency:     ${e2eBlockDeltaSec}s (${execLog.blockNumber - dropRcpt.blockNumber} Base blocks)`);
  console.log(`    Measured Wall-Clock:        ${e2eWallMs}ms`);

  proof.steps.push({
    step: 3,
    label: "Trailing Stop Breach ($3,200 <= $3,230): Full Autonomous Cross-Chain Settlement",
    positionId: posId,
    originTx: dropTx.hash,
    originBlock: dropRcpt.blockNumber,
    originTimestamp: dropBlock.timestamp,
    reactiveTx: cbReqLog.transactionHash,
    reactiveBlock: cbReqLog.blockNumber,
    reactiveTimestamp: cbReqBlock ? cbReqBlock.timestamp : null,
    callbackTx: execLog.transactionHash,
    callbackBlock: execLog.blockNumber,
    callbackTimestamp: execBlock.timestamp,
    protectedUsdc,
    onChainLatencySec: e2eBlockDeltaSec,
    wallLatencyMs: e2eWallMs,
  });

  proof.metrics = {
    positionId: posId,
    entryPriceUsd: 3000,
    peakHighWaterMarkUsd: 3400,
    trailingStopPriceUsd: 3230,
    triggerPriceUsd: 3200,
    protectedUsdc,
    originToLasnaMs: toLasnaMs,
    endToEndWallMs: e2eWallMs,
    endToEndBlockSec: e2eBlockDeltaSec,
    baseSepoliaBlockDelta: execLog.blockNumber - dropRcpt.blockNumber,
  };

  fs.writeFileSync(path.join(__dirname, "..", "live-proof.json"), JSON.stringify(proof, null, 2));
  const feDir = path.join(__dirname, "..", "frontend", "src");
  if (fs.existsSync(feDir)) {
    fs.writeFileSync(path.join(feDir, "live-proof.json"), JSON.stringify(proof, null, 2));
  }
  console.log("\nSaved full live proof to live-proof.json!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
