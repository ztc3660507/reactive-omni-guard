const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const SYSTEM_ADDR = "0x8888888888888888888888888888888888888888";
const BASE_SEPOLIA_CHAIN_ID = 84532n;

function toLogRecord(receipt, contractAddr, eventName, iface) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === eventName) {
        return {
          chainId: BASE_SEPOLIA_CHAIN_ID,
          contractAddress: log.address,
          topic0: BigInt(log.topics[0] || 0),
          topic1: BigInt(log.topics[1] || 0),
          topic2: BigInt(log.topics[2] || 0),
          topic3: BigInt(log.topics[3] || 0),
          data: log.data,
          blockNumber: BigInt(log.blockNumber),
          opCode: BigInt(log.topics.length),
          blockHash: BigInt(log.blockHash),
          txHash: BigInt(log.transactionHash),
          logIndex: BigInt(log.index),
        };
      }
    } catch (_) {}
  }
  throw new Error(`Event ${eventName} not found in receipt`);
}

describe("OmniGuard (Reactive Omni x Base Sepolia)", function () {
  let deployer, alice, bob, attacker;
  let system, proxy, weth, usdc, pool, reactive, vault;

  beforeEach(async function () {
    [deployer, alice, bob, attacker] = await ethers.getSigners();

    // 1. Deploy MockSystemContract and install its runtime bytecode at official Omni SYSTEM (0x8888...8888)
    const MockSystem = await ethers.getContractFactory("MockSystemContract");
    const deployedMockSystem = await MockSystem.deploy();
    await deployedMockSystem.waitForDeployment();
    const runtimeCode = await ethers.provider.getCode(await deployedMockSystem.getAddress());
    await network.provider.send("hardhat_setCode", [SYSTEM_ADDR, runtimeCode]);
    system = await ethers.getContractAt("MockSystemContract", SYSTEM_ADDR);
    await system.clearState();

    // 2. Deploy MockCallbackProxy (simulates Base Sepolia 0x476F44b1...43585)
    const MockProxy = await ethers.getContractFactory("MockCallbackProxy");
    proxy = await MockProxy.deploy();
    await proxy.waitForDeployment();

    // 3. Deploy oWETH & oUSDC + OmniPricePool on simulated Base Sepolia
    const OmniToken = await ethers.getContractFactory("OmniToken");
    weth = await OmniToken.deploy("Omni Wrapped Ether", "oWETH", 18, ethers.parseEther("5"));
    usdc = await OmniToken.deploy("Omni USD Coin", "oUSDC", 6, ethers.parseUnits("25000", 6));
    await weth.waitForDeployment();
    await usdc.waitForDeployment();

    const OmniPricePool = await ethers.getContractFactory("OmniPricePool");
    pool = await OmniPricePool.deploy(await weth.getAddress(), await usdc.getAddress());
    await pool.waitForDeployment();

    // Seed pool at $3,000.00/WETH with deep liquidity: 200 oWETH + 600,000 oUSDC
    await weth.mint(deployer.address, ethers.parseEther("200"));
    await usdc.mint(deployer.address, ethers.parseUnits("1200000", 6));
    await weth.approve(await pool.getAddress(), ethers.MaxUint256);
    await usdc.approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.seedLiquidity(ethers.parseEther("200"), ethers.parseUnits("600000", 6));
    // Extra USDC backing inside pool so upward market price simulation ($3,000 -> $4,500) stays fully backed
    await usdc.transfer(await pool.getAddress(), ethers.parseUnits("400000", 6));

    // 4. Deploy OmniGuardReactive on simulated Reactive Lasna (Step 1 of Omni deployment order)
    const OmniGuardReactive = await ethers.getContractFactory("OmniGuardReactive");
    reactive = await OmniGuardReactive.deploy(BASE_SEPOLIA_CHAIN_ID, await pool.getAddress(), {
      value: ethers.parseEther("1"),
    });
    await reactive.waitForDeployment();

    // 5. Deploy OmniGuardVault on simulated Base Sepolia passing (proxy, reactive) (Step 2)
    const OmniGuardVault = await ethers.getContractFactory("OmniGuardVault");
    vault = await OmniGuardVault.deploy(
      await proxy.getAddress(),
      await reactive.getAddress(),
      await pool.getAddress(),
      await weth.getAddress(),
      await usdc.getAddress(),
      { value: ethers.parseEther("0.5") }
    );
    await vault.waitForDeployment();

    // 6. Wire vault on Reactive contract (Step 3) -> subscribes to 3 vault lifecycle events
    await reactive.configureVault(await vault.getAddress());

    // Give Alice and Bob testnet oWETH via public faucet
    await weth.connect(alice).faucet();
    await weth.connect(bob).faucet();
    await weth.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await weth.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  it("registers all 4 Reactive Omni subscriptions cleanly", async function () {
    expect(await system.getSubscriptionCount()).to.equal(4n);
    expect(await reactive.vaultConfigured()).to.equal(true);
    expect(await reactive.vault()).to.equal(await vault.getAddress());
  });

  it("executes full Trailing Stop-Loss lifecycle: rally HWM ratchet -> pullback -> anti-duplicate lock -> callback swap -> O(1) cleanup", async function () {
    // Alice opens 2 oWETH position at $3,000 with 5% trailing stop, $4,200 TP, 12% crash breaker
    const armTx = await vault
      .connect(alice)
      .openAndArmPosition(ethers.parseEther("2"), 500, ethers.parseUnits("4200", 6), 1200);
    const armRcpt = await armTx.wait();
    const armedLog = toLogRecord(armRcpt, await vault.getAddress(), "PositionArmed", vault.interface);

    // Lasna receives PositionArmed automatically
    const regTx = await system.triggerReact(await reactive.getAddress(), armedLog);
    const regRcpt = await regTx.wait();
    expect(regRcpt.gasUsed).to.be.lessThan(300000n);

    let g = await reactive.getGuardState(1);
    expect(g.active).to.equal(true);
    expect(g.highWaterMark).to.equal(ethers.parseUnits("3000", 6));

    // Rally: $3,000 -> $3,400 (+13.33%) -> HWM ratchets to $3,400 (new trailing stop = $3,230), NO callback
    const rallyTx = await pool.simulateMarketPrice(ethers.parseUnits("3400", 6));
    const rallyLog = toLogRecord(await rallyTx.wait(), await pool.getAddress(), "PriceSync", pool.interface);
    await expect(system.triggerReact(await reactive.getAddress(), rallyLog))
      .to.emit(reactive, "HighWaterMarkRatcheted")
      .withArgs(1n, ethers.parseUnits("3400", 6), ethers.parseUnits("3230", 6));

    expect(await system.getCallbackCount()).to.equal(0n);

    // Mild dip: $3,400 -> $3,260 -> still above $3,230 trailing stop -> NO callback
    const dipTx = await pool.simulateMarketPrice(ethers.parseUnits("3260", 6));
    const dipLog = toLogRecord(await dipTx.wait(), await pool.getAddress(), "PriceSync", pool.interface);
    await system.triggerReact(await reactive.getAddress(), dipLog);
    expect(await system.getCallbackCount()).to.equal(0n);

    // Trailing stop breach: $3,260 -> $3,200 (<= $3,230) -> triggers TrailingStopLoss (reason = 1)!
    const stopTx = await pool.simulateMarketPrice(ethers.parseUnits("3200", 6));
    const stopLog = toLogRecord(await stopTx.wait(), await pool.getAddress(), "PriceSync", pool.interface);
    const reactTx = await system.triggerReact(await reactive.getAddress(), stopLog);
    const reactRcpt = await reactTx.wait();
    expect(reactRcpt.gasUsed).to.be.lessThan(500000n); // well within Lasna 900k cap

    expect(await system.getCallbackCount()).to.equal(1n);
    g = await reactive.getGuardState(1);
    expect(g.pendingCallback).to.equal(true);

    // Rapid second price tick before callback lands -> anti-duplicate lock prevents double callback!
    const dupTx = await pool.simulateMarketPrice(ethers.parseUnits("3150", 6));
    const dupLog = toLogRecord(await dupTx.wait(), await pool.getAddress(), "PriceSync", pool.interface);
    await system.triggerReact(await reactive.getAddress(), dupLog);
    expect(await system.getCallbackCount()).to.equal(1n);

    // Callback Proxy delivers queued callback onto Base Sepolia OmniGuardVault
    const cb = await system.getCallback(0);
    expect(cb.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID);
    expect(cb.recipient).to.equal(await vault.getAddress());

    const aliceUsdcBefore = await usdc.balanceOf(alice.address);
    const deliverTx = await proxy.deliverCallback(
      cb.recipient,
      cb.reactiveSender,
      cb.gasLimit,
      cb.payload,
      ethers.parseEther("0.001")
    );
    const deliverRcpt = await deliverTx.wait();
    expect(deliverRcpt.gasUsed).to.be.lessThan(400000n); // well within 500k CALLBACK_GAS_LIMIT

    const aliceUsdcAfter = await usdc.balanceOf(alice.address);
    const receivedUsdc = aliceUsdcAfter - aliceUsdcBefore;
    // Alice locked in > $6,200 USDC for 2 WETH (profit above original $6,000 entry despite pullback!)
    expect(receivedUsdc).to.be.greaterThan(ethers.parseUnits("6150", 6));

    const pos = await vault.getPosition(1);
    expect(pos.status).to.equal(2n); // Executed
    expect(pos.executedReason).to.equal(1n); // TrailingStopLoss
    expect(pos.highWaterMark).to.equal(ethers.parseUnits("3400", 6));
    expect(pos.usdcOut).to.equal(receivedUsdc);

    // Relay GuardExecuted back to Lasna -> O(1) swap-and-pop removes position from active set
    const execLog = toLogRecord(deliverRcpt, await vault.getAddress(), "GuardExecuted", vault.interface);
    await system.triggerReact(await reactive.getAddress(), execLog);

    expect((await reactive.getActivePositionIds()).length).to.equal(0);
    expect(await reactive.callbacksConfirmed()).to.equal(1n);
  });

  it("triggers Flash-Crash Circuit Breaker (reason = 3) before wider trailing stop", async function () {
    // Bob arms 1 oWETH with 20% trailing stop, NO TP, and 8% single-tick crash shield
    const armTx = await vault.connect(bob).openAndArmPosition(ethers.parseEther("1"), 2000, 0, 800);
    const armedLog = toLogRecord(await armTx.wait(), await vault.getAddress(), "PositionArmed", vault.interface);
    await system.triggerReact(await reactive.getAddress(), armedLog);

    // Baseline tick at $3,000
    const baseTx = await pool.simulateMarketPrice(ethers.parseUnits("3000", 6));
    await system.triggerReact(
      await reactive.getAddress(),
      toLogRecord(await baseTx.wait(), await pool.getAddress(), "PriceSync", pool.interface)
    );

    // Sudden -10% flash crash ($3,000 -> $2,700): above 20% trailing stop ($2,400), but >= 8% crash shield!
    const crashTx = await pool.simulateMarketPrice(ethers.parseUnits("2700", 6));
    const crashLog = toLogRecord(await crashTx.wait(), await pool.getAddress(), "PriceSync", pool.interface);
    await expect(system.triggerReact(await reactive.getAddress(), crashLog))
      .to.emit(reactive, "GuardCallbackRequested")
      .withArgs(1n, 3, ethers.parseUnits("2700", 6), ethers.parseUnits("3000", 6), 3n);

    const cb = await system.getCallback(0);
    await proxy.deliverCallback(cb.recipient, cb.reactiveSender, cb.gasLimit, cb.payload, 0);
    const pos = await vault.getPosition(1);
    expect(pos.executedReason).to.equal(3n); // FlashCrashBreaker
  });

  it("triggers Take-Profit (reason = 2) when target price is reached", async function () {
    const armTx = await vault
      .connect(alice)
      .openAndArmPosition(ethers.parseEther("1"), 500, ethers.parseUnits("3500", 6), 0);
    await system.triggerReact(
      await reactive.getAddress(),
      toLogRecord(await armTx.wait(), await vault.getAddress(), "PositionArmed", vault.interface)
    );

    const pumpTx = await pool.simulateMarketPrice(ethers.parseUnits("3550", 6));
    await expect(
      system.triggerReact(
        await reactive.getAddress(),
        toLogRecord(await pumpTx.wait(), await pool.getAddress(), "PriceSync", pool.interface)
      )
    )
      .to.emit(reactive, "GuardCallbackRequested")
      .withArgs(1n, 2, ethers.parseUnits("3550", 6), ethers.parseUnits("3550", 6), 2n);

    const cb = await system.getCallback(0);
    await proxy.deliverCallback(cb.recipient, cb.reactiveSender, cb.gasLimit, cb.payload, 0);
    const pos = await vault.getPosition(1);
    expect(pos.executedReason).to.equal(2n); // TakeProfit
  });

  it("handles manual disarm gracefully without reverting on late callbacks", async function () {
    const armTx = await vault.connect(alice).openAndArmPosition(ethers.parseEther("1"), 500, 0, 0);
    await system.triggerReact(
      await reactive.getAddress(),
      toLogRecord(await armTx.wait(), await vault.getAddress(), "PositionArmed", vault.interface)
    );

    // Price drops and queues callback
    const dropTx = await pool.simulateMarketPrice(ethers.parseUnits("2800", 6));
    await system.triggerReact(
      await reactive.getAddress(),
      toLogRecord(await dropTx.wait(), await pool.getAddress(), "PriceSync", pool.interface)
    );

    // Alice disarms manually BEFORE callback lands
    const disarmTx = await vault.connect(alice).disarmAndWithdraw(1);
    const disarmLog = toLogRecord(await disarmTx.wait(), await vault.getAddress(), "PositionDisarmed", vault.interface);
    await system.triggerReact(await reactive.getAddress(), disarmLog);
    expect((await reactive.getActivePositionIds()).length).to.equal(0);

    // Late callback arrives -> emits GuardSkipped, does NOT revert!
    const cb = await system.getCallback(0);
    await expect(proxy.deliverCallback(cb.recipient, cb.reactiveSender, cb.gasLimit, cb.payload, 0))
      .to.emit(vault, "GuardSkipped")
      .withArgs(1n, 3); // PositionStatus.Disarmed
  });

  it("enforces strict Omni authentication (onlySystem, onlyServiceProvider, onlyCallbackSender)", async function () {
    const fakeLog = {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      contractAddress: await pool.getAddress(),
      topic0: 0n,
      topic1: 0n,
      topic2: 0n,
      topic3: 0n,
      data: "0x",
      blockNumber: 1n,
      opCode: 2n,
      blockHash: 0n,
      txHash: 0n,
      logIndex: 0n,
    };

    // 1. Direct react() call by non-SYSTEM fails
    await expect(reactive.connect(attacker).react(fakeLog)).to.be.revertedWithCustomError(
      reactive,
      "NotAuthorized"
    );

    // 2. Direct executeGuardCallback() call by non-proxy fails
    await expect(
      vault.connect(attacker).executeGuardCallback(await reactive.getAddress(), 1, 1, 3000e6, 3000e6)
    ).to.be.revertedWithCustomError(vault, "NotAuthorized");

    // 3. Forged callback through legitimate proxy from an unauthorized reactive contract fails
    const payload = vault.interface.encodeFunctionData("executeGuardCallback", [
      ethers.ZeroAddress,
      1,
      1,
      ethers.parseUnits("2800", 6),
      ethers.parseUnits("3000", 6),
    ]);
    await expect(
      proxy.deliverCallback(await vault.getAddress(), attacker.address, 300000, payload, 0)
    )
      .to.emit(proxy, "CallbackDelivered")
      .withArgs(await vault.getAddress(), attacker.address, false);
  });

  it("settles outstanding debt cleanly via coverDebt() on both sides", async function () {
    await system.setDebt(await reactive.getAddress(), ethers.parseEther("0.05"));
    expect(await system.debt(await reactive.getAddress())).to.equal(ethers.parseEther("0.05"));
    await reactive.coverDebt();
    expect(await system.debt(await reactive.getAddress())).to.equal(0n);

    await proxy.setDebt(await vault.getAddress(), ethers.parseEther("0.02"));
    expect(await proxy.debt(await vault.getAddress())).to.equal(ethers.parseEther("0.02"));
    await vault.coverDebt();
    expect(await proxy.debt(await vault.getAddress())).to.equal(0n);
  });
});
