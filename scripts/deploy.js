/**
 * Multi-chain deployment orchestrator for OmniGuard (Base Sepolia + Reactive Lasna Omni).
 * Follows the exact Reactive Omni deployment order:
 *   1. Base Sepolia: Deploy oWETH, oUSDC, OmniPricePool + seed deep WETH/USDC liquidity at $3,000
 *   2. Reactive Lasna: Deploy OmniGuardReactive (subscribes to OmniPricePool PriceSync) + fund reserves
 *   3. Base Sepolia: Deploy OmniGuardVault(CALLBACK_PROXY, OmniGuardReactive, pool, weth, usdc) + fund reserves
 *   4. Reactive Lasna: Call OmniGuardReactive.configureVault(OmniGuardVault) (subscribes to Vault events)
 *   5. Write deployments.json + frontend/src/deployments.json
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const BASE_SEPOLIA_CHAIN_ID = 84532;
const LASNA_CHAIN_ID = 5318007;

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";

const LASNA_SYSTEM_CONTRACT =
  process.env.LASNA_SYSTEM_CONTRACT || "0x8888888888888888888888888888888888888888";
const BASE_SEPOLIA_CALLBACK_PROXY =
  process.env.BASE_SEPOLIA_CALLBACK_PROXY || "0x476F44b11F5C942c58f4c8E3d0300E5710743585";

function loadArtifact(contractRelPath, contractName) {
  const full = path.join(__dirname, "..", "artifacts", "contracts", contractRelPath, `${contractName}.json`);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

  const baseProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);
  const baseWallet = new ethers.Wallet(pk, baseProvider);
  const lasnaWallet = new ethers.Wallet(pk, lasnaProvider);

  const baseBal = await baseProvider.getBalance(baseWallet.address);
  const lasnaBal = await lasnaProvider.getBalance(lasnaWallet.address);
  console.log("=== OmniGuard Multi-Chain Deployment ===");
  console.log("Deployer:", baseWallet.address);
  console.log("Base Sepolia ETH:", ethers.formatEther(baseBal));
  console.log("Reactive Lasna lREACT:", ethers.formatEther(lasnaBal));

  if (baseBal < ethers.parseEther("0.005")) {
    throw new Error("Need at least 0.005 Base Sepolia ETH to deploy and fund callback proxy reserves.");
  }
  if (lasnaBal < ethers.parseEther("0.2")) {
    throw new Error("Need at least 0.2 lREACT on Lasna (run `npm run fund:lasna` first).");
  }

  const tokenArt = loadArtifact("OmniToken.sol", "OmniToken");
  const poolArt = loadArtifact("OmniPricePool.sol", "OmniPricePool");
  const reactiveArt = loadArtifact("OmniGuardReactive.sol", "OmniGuardReactive");
  const vaultArt = loadArtifact("OmniGuardVault.sol", "OmniGuardVault");

  // Step 1: Deploy tokens & OmniPricePool on Base Sepolia
  console.log("\n[1/5] Deploying oWETH, oUSDC, and OmniPricePool on Base Sepolia...");
  const TokenFactory = new ethers.ContractFactory(tokenArt.abi, tokenArt.bytecode, baseWallet);
  const weth = await TokenFactory.deploy("Omni Wrapped Ether", "oWETH", 18, ethers.parseEther("5"));
  await weth.waitForDeployment();
  const wethAddr = await weth.getAddress();
  console.log("  oWETH:", wethAddr);

  const usdc = await TokenFactory.deploy("Omni USD Coin", "oUSDC", 6, ethers.parseUnits("25000", 6));
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("  oUSDC:", usdcAddr);

  const PoolFactory = new ethers.ContractFactory(poolArt.abi, poolArt.bytecode, baseWallet);
  const pool = await PoolFactory.deploy(wethAddr, usdcAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("  OmniPricePool:", poolAddr);

  // Mint & seed deep liquidity: 200 oWETH + 600,000 oUSDC ($3,000/WETH) + extra USDC backing
  console.log("  Seeding pool liquidity at $3,000.00/WETH...");
  await (await weth.mint(baseWallet.address, ethers.parseEther("250"))).wait();
  await (await usdc.mint(baseWallet.address, ethers.parseUnits("1200000", 6))).wait();
  await (await weth.approve(poolAddr, ethers.MaxUint256)).wait();
  await (await usdc.approve(poolAddr, ethers.MaxUint256)).wait();
  const seedTx = await pool.seedLiquidity(ethers.parseEther("200"), ethers.parseUnits("600000", 6));
  await seedTx.wait();
  await (await usdc.transfer(poolAddr, ethers.parseUnits("400000", 6))).wait();
  console.log("  Seeded! Spot price:", Number(await pool.getSpotPrice()) / 1e6, "USDC/WETH");

  // Step 2: Deploy OmniGuardReactive on Reactive Lasna
  console.log("\n[2/5] Deploying OmniGuardReactive on Reactive Lasna (5318007)...");
  const ReactiveFactory = new ethers.ContractFactory(reactiveArt.abi, reactiveArt.bytecode, lasnaWallet);
  const reactive = await ReactiveFactory.deploy(BASE_SEPOLIA_CHAIN_ID, poolAddr, {
    value: ethers.parseEther("0.5"),
  });
  const reactiveDeployTx = reactive.deploymentTransaction();
  await reactive.waitForDeployment();
  const reactiveAddr = await reactive.getAddress();
  console.log("  OmniGuardReactive:", reactiveAddr);
  console.log("  Deploy Tx (Lasna):", reactiveDeployTx.hash);

  // Also deposit 0.5 lREACT into SYSTEM reserves for OmniGuardReactive
  const sysContract = new ethers.Contract(
    LASNA_SYSTEM_CONTRACT,
    ["function depositTo(address target) external payable"],
    lasnaWallet
  );
  const sysDepTx = await sysContract.depositTo(reactiveAddr, { value: ethers.parseEther("0.5") });
  await sysDepTx.wait();
  console.log("  Funded Lasna SYSTEM reserves (+0.5 lREACT):", sysDepTx.hash);

  // Step 3: Deploy OmniGuardVault on Base Sepolia (pointing to official Callback Proxy + Reactive Contract)
  console.log("\n[3/5] Deploying OmniGuardVault on Base Sepolia (84532)...");
  const VaultFactory = new ethers.ContractFactory(vaultArt.abi, vaultArt.bytecode, baseWallet);
  const vault = await VaultFactory.deploy(
    BASE_SEPOLIA_CALLBACK_PROXY,
    reactiveAddr,
    poolAddr,
    wethAddr,
    usdcAddr,
    { value: ethers.parseEther("0.002") }
  );
  const vaultDeployTx = vault.deploymentTransaction();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("  OmniGuardVault:", vaultAddr);
  console.log("  Deploy Tx (Base Sepolia):", vaultDeployTx.hash);

  // Pre-fund Callback Proxy reserves for OmniGuardVault so callbacks execute with zero debt
  const proxyContract = new ethers.Contract(
    BASE_SEPOLIA_CALLBACK_PROXY,
    ["function depositTo(address target) external payable"],
    baseWallet
  );
  const proxyDepTx = await proxyContract.depositTo(vaultAddr, { value: ethers.parseEther("0.003") });
  await proxyDepTx.wait();
  console.log("  Funded Base Sepolia Callback Proxy reserves (+0.003 ETH):", proxyDepTx.hash);

  // Step 4: Wire OmniGuardVault into OmniGuardReactive on Lasna
  console.log("\n[4/5] Calling configureVault() on Reactive Lasna...");
  const cfgTx = await reactive.configureVault(vaultAddr);
  await cfgTx.wait();
  console.log("  configureVault Tx (Lasna):", cfgTx.hash);

  // Step 5: Persist deployment manifest
  const manifest = {
    deployedAt: new Date().toISOString(),
    deployer: baseWallet.address,
    networks: {
      baseSepolia: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        rpcUrl: BASE_SEPOLIA_RPC,
        explorer: "https://sepolia.basescan.org",
        callbackProxy: BASE_SEPOLIA_CALLBACK_PROXY,
      },
      lasna: {
        chainId: LASNA_CHAIN_ID,
        rpcUrl: LASNA_RPC,
        explorer: "https://lasna.reactscan.net",
        systemContract: LASNA_SYSTEM_CONTRACT,
      },
    },
    contracts: {
      oWETH: wethAddr,
      oUSDC: usdcAddr,
      omniPricePool: poolAddr,
      omniGuardVault: vaultAddr,
      omniGuardReactive: reactiveAddr,
    },
    deployTxs: {
      reactiveDeploy: reactiveDeployTx.hash,
      vaultDeploy: vaultDeployTx.hash,
      configureVault: cfgTx.hash,
      lasnaReserveDeposit: sysDepTx.hash,
      proxyReserveDeposit: proxyDepTx.hash,
    },
  };

  fs.writeFileSync(path.join(__dirname, "..", "deployments.json"), JSON.stringify(manifest, null, 2));
  const feDir = path.join(__dirname, "..", "frontend", "src");
  if (fs.existsSync(feDir)) {
    fs.writeFileSync(path.join(feDir, "deployments.json"), JSON.stringify(manifest, null, 2));
  }

  console.log("\n[5/5] Saved deployments.json! Ready for live cross-chain demo (`npm run demo:live`).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
