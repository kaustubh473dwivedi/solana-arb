import "dotenv/config";

import { getQuote } from "../market/quotes.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// We will replace/verify this mint before using the collector
// for live research.
const JITOSOL_MINT =
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

const SOL_AMOUNT = 0.1;
const JITOSOL_AMOUNT = 0.1;

function usdcPrice(
  outAmount: string,
  inputAmount: number,
): number {
  // USDC has 6 decimals.
  const usdc = Number(outAmount) / 1_000_000;

  return usdc / inputAmount;
}

async function sample(): Promise<void> {
  const timestamp = new Date().toISOString();

  const solQuote = await getQuote(
    SOL_MINT,
    USDC_MINT,
    SOL_AMOUNT * 1_000_000_000,
  );

  const jitoQuote = await getQuote(
    JITOSOL_MINT,
    USDC_MINT,
    JITOSOL_AMOUNT * 1_000_000_000,
  );

  const solPrice = usdcPrice(
    solQuote.outAmount,
    SOL_AMOUNT,
  );

  const jitoPrice = usdcPrice(
    jitoQuote.outAmount,
    JITOSOL_AMOUNT,
  );

  console.log(
    JSON.stringify({
      timestamp,
      sol_usdc: solPrice,
      jitosol_usdc: jitoPrice,
    }),
  );
}

async function main(): Promise<void> {
  console.log("=== Stat-Arb Market Collector ===");
  console.log("Starting quote collection...\n");

  await sample();

  setInterval(async () => {
    try {
      await sample();
    } catch (error) {
      console.error("Quote collection failed:");
      console.error(error);
    }
  }, 5000);
}

main().catch((error) => {
  console.error("Collector startup failed:");
  console.error(error);
  process.exit(1);
});
