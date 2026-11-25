/**
 * Automatically splits Ethereum Sepolia ETH into:
 *   1) Reactive Lasna lREACT via official Sepolia Faucet (0x9b9BB25f1A81078C544C829c5EB7822d747Cf434)
 *   2) Base Sepolia ETH via official L1StandardBridge (0xfd0Bf71F60660E2f608ed56e1659C450eB113120)
 */
const { ethers } = require("ethers");
require("dotenv").config();

const ETH_SEPOLIA_RPC = process.env.ETH_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";

const ETH_SEPOLIA_LASNA_FAUCET = "0x9b9BB25f1A81078C544C829c5EB7822d747Cf434";
const BASE_SEPOLIA_L1_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";

const FAUCET_ABI = ["function request(address receiver) external payable"];
const BRIDGE_ABI = ["function depositETH(uint32 _minGasLimit, bytes calldata _extraData) external payable"];

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

  const ethProvider = new ethers.JsonRpcProvider(ETH_SEPOLIA_RPC);
  const baseProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);

  const ethWallet = new ethers.Wallet(pk, ethProvider);

  const ethBal = await ethProvider.getBalance(ethWallet.address);
  const baseBalBefore = await baseProvider.getBalance(ethWallet.address);
  const lasnaBalBefore = await lasnaProvider.getBalance(ethWallet.address);

  console.log("Deployer:", ethWallet.address);
  console.log("Eth Sepolia ETH: ", ethers.formatEther(ethBal));
  console.log("Base Sepolia ETH:", ethers.formatEther(baseBalBefore));
  console.log("Lasna lREACT:    ", ethers.formatEther(lasnaBalBefore));

  if (ethBal < ethers.parseEther("0.01")) {
    throw new Error("Insufficient Ethereum Sepolia ETH (need >= 0.01 ETH).");
  }

  // Reserve ~0.005 ETH for L1 gas; split remainder between Lasna faucet and Base Sepolia bridge
  const usable = ethBal - ethers.parseEther("0.005");
  const lasnaSend = usable > ethers.parseEther("0.04") ? ethers.parseEther("0.025") : usable / 2n;
  const baseSend = usable > ethers.parseEther("0.04") ? ethers.parseEther("0.02") : usable / 2n;

  if (lasnaBalBefore < ethers.parseEther("1.5")) {
    const faucet = new ethers.Contract(ETH_SEPOLIA_LASNA_FAUCET, FAUCET_ABI, ethWallet);
    console.log(`\n[1/2] Sending ${ethers.formatEther(lasnaSend)} Eth Sepolia -> Lasna Faucet...`);
    const tx1 = await faucet.request(ethWallet.address, { value: lasnaSend });
    console.log("  Lasna Faucet Tx (Sepolia):", tx1.hash);
    await tx1.wait();
    console.log("  Confirmed!");
  } else {
    console.log("\n[1/2] Lasna already funded, skipping faucet.");
  }

  if (baseBalBefore < ethers.parseEther("0.01")) {
    const bridge = new ethers.Contract(BASE_SEPOLIA_L1_BRIDGE, BRIDGE_ABI, ethWallet);
    console.log(`\n[2/2] Bridging ${ethers.formatEther(baseSend)} Eth Sepolia -> Base Sepolia...`);
    const tx2 = await bridge.depositETH(200000, "0x", { value: baseSend });
    console.log("  Base Bridge Tx (Sepolia):", tx2.hash);
    await tx2.wait();
    console.log("  Confirmed on Ethereum Sepolia! Waiting for L2 arrival + lREACT arrival...");
  } else {
    console.log("\n[2/2] Base Sepolia already funded, skipping bridge.");
  }

  // Poll up to 4 minutes for both Base Sepolia ETH and Lasna lREACT to arrive
  for (let i = 0; i < 48; i++) {
    const [bNow, lNow] = await Promise.all([
      baseProvider.getBalance(ethWallet.address),
      lasnaProvider.getBalance(ethWallet.address),
    ]);
    console.log(
      `  [${i * 5}s] Base Sepolia: ${ethers.formatEther(bNow)} ETH | Lasna: ${ethers.formatEther(lNow)} lREACT`
    );
    if (bNow >= ethers.parseEther("0.008") && lNow >= ethers.parseEther("1.0")) {
      console.log("\nBOTH CHAINS FUNDED! Ready for `npm run deploy:live`!");
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("Timed out waiting for bridge arrival — re-check balances in 1 minute.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
