/**
 * Converts Base Sepolia ETH into Reactive Lasna lREACT via the official faucet contract.
 * Exchange rate: 1 Base Sepolia ETH = 100 lREACT (max 5 ETH per tx).
 * Usage: node scripts/fund-lasna.js [amountInBaseEth] (default: 0.03 -> 3 lREACT)
 */
const { ethers } = require("ethers");
require("dotenv").config();

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const BASE_SEPOLIA_FAUCET =
  process.env.BASE_SEPOLIA_LASNA_FAUCET || "0x2afaFD298b23b62760711756088F75B7409f5967";

const FAUCET_ABI = ["function request(address receiver) external payable"];

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

  const amountEth = process.argv[2] || "0.03";
  const baseProvider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);
  const wallet = new ethers.Wallet(pk, baseProvider);

  const baseBal = await baseProvider.getBalance(wallet.address);
  const lasnaBalBefore = await lasnaProvider.getBalance(wallet.address);

  console.log("Deployer address:", wallet.address);
  console.log("Base Sepolia ETH:", ethers.formatEther(baseBal));
  console.log("Lasna lREACT before:", ethers.formatEther(lasnaBalBefore));

  const faucet = new ethers.Contract(BASE_SEPOLIA_FAUCET, FAUCET_ABI, wallet);
  console.log(`Sending ${amountEth} Base Sepolia ETH -> Reactive Lasna faucet (${BASE_SEPOLIA_FAUCET})...`);
  const tx = await faucet.request(wallet.address, { value: ethers.parseEther(amountEth) });
  console.log("Base Sepolia Faucet Tx:", tx.hash);
  await tx.wait();
  console.log("Confirmed on Base Sepolia! Waiting for lREACT arrival on Lasna...");

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const bal = await lasnaProvider.getBalance(wallet.address);
    if (bal > lasnaBalBefore) {
      console.log(`SUCCESS! Lasna lREACT balance is now: ${ethers.formatEther(bal)} lREACT`);
      return;
    }
    process.stdout.write(".");
  }
  console.log("\nStill pending — check https://lasna.reactscan.net/address/" + wallet.address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
