import "dotenv/config"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import fs from "node:fs";
import { getQuote } from "./market/quotes.js";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = "./secrets/bot-keypair.json";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function main() {
  console.log("Connecting to Solana Devnet...");

  const connection = new Connection(RPC_URL, "confirmed");

  const secretKey = Uint8Array.from(
    JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))
  );

  const wallet = Keypair.fromSecretKey(secretKey);
  const publicKey = wallet.publicKey;

  const balance = await connection.getBalance(publicKey);
  const slot = await connection.getSlot();
  const version = await connection.getVersion();

  console.log("\n=== Solana Arb Bot ===");
  console.log("Network:  Devnet");
  console.log("Wallet:   ", publicKey.toBase58());
  console.log("Balance:  ", balance / LAMPORTS_PER_SOL, "SOL");
  console.log("Slot:     ", slot);
  console.log("Version:  ", version["solana-core"]);
  const quote = await getQuote(
  SOL_MINT,
  USDC_MINT,
  0.1 * LAMPORTS_PER_SOL,
  );

console.log("\n=== SOL → USDC Quote ===");
console.log("Input:        0.1 SOL");
console.log("Output:       ", quote.outAmount, "USDC base units");
console.log("Price impact: ", quote.priceImpactPct, "%");

if (quote.routePlan?.length) {
  console.log("\n=== Route ===");

  for (const route of quote.routePlan) {
    console.log("Venue:       ", route.swapInfo.label);
    console.log("AMM key:     ", route.swapInfo.ammKey);
    console.log("Route share: ", route.percent, "%");
  }
}
}

main().catch((error) => {
  console.error("Bot startup failed:");
  console.error(error);
  process.exit(1);
});

