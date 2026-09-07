import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { getQuote } from "../market/quotes.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  estimateRoundTripCost,
  worstCaseOutputAfterSlippage,
} from "../execution/expenses.js";
import { computeOnChainSwap } from "../onchain/crossCheck.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDC_DECIMALS = 1_000_000;
const SOL_DECIMALS = 1_000_000_000;

const DEXES = [
  "Raydium",
  "Meteora DLMM",
  "Orca V2",
  "Quantum",
  "Phoenix",
  "Whirlpool",
  "Raydium CLMM",
  "OpenBook V2",
];

const START_USDC = 10;
const SCAN_INTERVAL_MS = 5_000;
// Minimum gross return required before we call something
// a candidate. This is NOT a trading signal.
const MIN_PROFIT_PCT = 0.10;

// Safety buffer for anything not itemized by expenses.ts (e.g. residual
// slippage beyond the worst-case bound below).
const SAFETY_BUFFER_PCT = 0.05;

// The bot has no USDC token account yet (confirmed via getTokenAccountsByOwner),
// so a real round trip would pay rent to create one on its first trade.
const SELL_TOKEN_ACCOUNT_EXISTS = false;

// A quote older than this is not considered fresh enough
// for a paper opportunity.
const MAX_QUOTE_AGE_MS = 3_000;
const MAX_BUY_VENUES_TO_PROBE = 2;
const LOG_DIR = "./logs";
const LOG_FILE = path.join(LOG_DIR, "arbitrage-opportunities.jsonl");


type QuoteStatus =
  | "OK"
  | "NO_ROUTE"
  | "QUOTE_ERROR"
  | "STALE_QUOTE";

interface DexQuote {
  dex: string;
  outAmount: bigint;
  priceImpactPct: string;
  contextSlot?: number;
  requestedAt: number;
  onChainOutAmount?: bigint; // this bot's own computed swap output, for cross-checking Jupiter
}

interface OpportunityRecord {
  timestamp: string;
  buyDex: string;
  sellDex: string;

  startingUsdc: number;
  solBought: number;
  finalUsdc: number;

  grossProfitUsdc: number;
  grossReturnPct: number;

  estimatedCostsUsdc: number;
  costBreakdownLamports: {
    baseFee: number;
    priorityFee: number;
    jitoTip: number;
    rent: number;
  };
  estimatedNetProfitUsdc: number;
  estimatedNetReturnPct: number;

  worstCaseFinalUsdc: number;
  worstCaseNetProfitUsdc: number;

  buyQuoteAgeMs: number;
  sellQuoteAgeMs: number;

  buyContextSlot?: number;
  sellContextSlot?: number;

  // This bot's own on-chain-computed swap output, for cross-checking
  // Jupiter's quote independently. Absent for DEXes with no reader wired up
  // (see src/onchain/crossCheck.ts) or if the live fetch/decode failed.
  buyOnChainOutAmount?: string; // bigint, stringified for JSON
  sellOnChainOutAmount?: string;

  status: "CANDIDATE" | "NO_TRADE" | "STALE_QUOTE";
}

interface SellResult {
  status: QuoteStatus;
  quote?: DexQuote;
}
function selectBestBuyQuotes(
  quotes: DexQuote[],
): DexQuote[] {
  return [...quotes]
    .filter(isFresh)
    .sort((a, b) => {
      if (a.outAmount > b.outAmount) {
        return -1;
      }

      if (a.outAmount < b.outAmount) {
        return 1;
      }

      return 0;
    })
    .slice(0, MAX_BUY_VENUES_TO_PROBE);
}

function ensureLogDirectory(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendOpportunity(record: OpportunityRecord): void {
  ensureLogDirectory();

  fs.appendFileSync(
    LOG_FILE,
    `${JSON.stringify(record)}\n`,
    "utf-8",
  );
}

function formatUsdc(baseUnits: bigint): string {
  return (
    Number(baseUnits) / USDC_DECIMALS
  ).toFixed(6);
}

function formatSol(lamports: bigint): string {
  return (
    Number(lamports) / SOL_DECIMALS
  ).toFixed(9);
}

function quoteAgeMs(quote: DexQuote): number {
  return Date.now() - quote.requestedAt;
}

function isFresh(quote: DexQuote): boolean {
  return quoteAgeMs(quote) <= MAX_QUOTE_AGE_MS;
}

// Computes this bot's own on-chain-derived swap output alongside Jupiter's,
// so the two can be logged side by side. Returns undefined (not an error)
// whenever no on-chain reader is wired up for this DEX, or the live
// fetch/decode fails -- never blocks the Jupiter-based quote from being used.
async function computeCrossCheckOutAmount(
  dex: string,
  inputMint: string,
  amount: bigint,
): Promise<bigint | undefined> {
  const direction = inputMint === USDC_MINT ? "usdc-to-sol" : "sol-to-usdc";
  const amountHumanUnits =
    direction === "usdc-to-sol"
      ? Number(amount) / USDC_DECIMALS
      : Number(amount) / SOL_DECIMALS;

  const outHumanUnits = await computeOnChainSwap(dex, direction, amountHumanUnits);
  if (outHumanUnits === null) {
    return undefined;
  }

  const outDecimals = direction === "usdc-to-sol" ? SOL_DECIMALS : USDC_DECIMALS;
  return BigInt(Math.round(outHumanUnits * outDecimals));
}

async function getDexQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  dex: string,
): Promise<DexQuote | null> {
  const requestedAt = Date.now();

  try {
    const result = await getQuote(
      inputMint,
      outputMint,
      Number(amount),
      [dex],
    );

    if (!result.outAmount) {
      return null;
    }

    const onChainOutAmount = await computeCrossCheckOutAmount(
      dex,
      inputMint,
      amount,
    );

    return {
      dex,
      outAmount: BigInt(result.outAmount),
      priceImpactPct:
        result.priceImpactPct ?? "unknown",
      contextSlot: result.contextSlot,
      requestedAt,
      onChainOutAmount,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    if (
      message.includes("429") ||
      message
        .toLowerCase()
        .includes("rate limited")
    ) {
      console.warn(
        `    ${dex}: RATE_LIMITED`,
      );

      return null;
    }

    console.error(
      `    ${dex} quote failed:`,
      message,
    );

    return null;
  }
}
async function collectUsdcToSolQuotes(
  amount: bigint,
): Promise<DexQuote[]> {
  const results: DexQuote[] = [];

  for (const dex of DEXES) {
    const result = await getDexQuote(
      USDC_MINT,
      SOL_MINT,
      amount,
      dex,
    );

    if (result) {
      results.push(result);
    }
  }

  return results;
 } 

async function getSellQuote(
  solAmount: bigint,
  sellDex: string,
): Promise<SellResult> {
  const quote = await getDexQuote(
    SOL_MINT,
    USDC_MINT,
    solAmount,
    sellDex,
  );

  if (!quote) {
    return {
      status: "NO_ROUTE",
    };
  }

  if (!isFresh(quote)) {
    return {
      status: "STALE_QUOTE",
      quote,
    };
  }

  return {
    status: "OK",
    quote,
  };
}

function printOpportunity(
  startingUsdc: number,
  buy: DexQuote,
  sell: DexQuote,
): void {
  const finalUsdc =
    Number(sell.outAmount) / USDC_DECIMALS;

  const solBought =
    Number(buy.outAmount) / SOL_DECIMALS;

  const grossProfitUsdc =
    finalUsdc - startingUsdc;

  const grossReturnPct =
    (grossProfitUsdc / startingUsdc) * 100;

  // Price implied by this specific buy leg (USDC spent / SOL received),
  // used to convert the lamport-denominated cost model into USDC.
  const usdcPerSol = startingUsdc / solBought;

  const roundTripCost = estimateRoundTripCost({
    sellTokenAccountExists: SELL_TOKEN_ACCOUNT_EXISTS,
  });

  const estimatedCostsUsdc =
    roundTripCost.totalSol * usdcPerSol;

  const estimatedNetProfitUsdc =
    grossProfitUsdc - estimatedCostsUsdc;

  const estimatedNetReturnPct =
    (estimatedNetProfitUsdc / startingUsdc) * 100;

  // Worst case if the sell leg fills at the edge of its slippage tolerance
  // instead of at the quoted price (DEX swap fee and price impact are
  // already netted into sell.outAmount, so this only adds slippage risk).
  const worstCaseSellOutAmount =
    worstCaseOutputAfterSlippage(sell.outAmount);

  const worstCaseFinalUsdc =
    Number(worstCaseSellOutAmount) / USDC_DECIMALS;

  const worstCaseNetProfitUsdc =
    worstCaseFinalUsdc - startingUsdc - estimatedCostsUsdc;

  const buyAge = quoteAgeMs(buy);
  const sellAge = quoteAgeMs(sell);

  const candidate =
    grossReturnPct >= MIN_PROFIT_PCT &&
    estimatedNetReturnPct >= SAFETY_BUFFER_PCT;

  console.log(`\n  ${buy.dex} → ${sell.dex}`);
  console.log(
    `  Start:          ${startingUsdc.toFixed(6)} USDC`,
  );
  console.log(
    `  SOL bought:     ${solBought.toFixed(9)}`,
  );
  console.log(
    `  USDC back:      ${finalUsdc.toFixed(6)}`,
  );
  if (sell.onChainOutAmount !== undefined) {
    console.log(
      `  USDC back (on-chain): ${(Number(sell.onChainOutAmount) / USDC_DECIMALS).toFixed(6)}`,
    );
  }
  console.log(
    `  Gross P&L:      ${grossProfitUsdc.toFixed(6)} USDC`,
  );
  console.log(
    `  Gross return:   ${grossReturnPct.toFixed(4)}%`,
  );
  console.log(
    `  Est. costs:     ${estimatedCostsUsdc.toFixed(6)} USDC` +
      ` (base ${roundTripCost.baseFeeLamports} + priority ${roundTripCost.priorityFeeLamports}` +
      ` + jito ${roundTripCost.jitoTipLamports} + rent ${roundTripCost.rentLamports} lamports)`,
  );
  console.log(
    `  Est. net P&L:   ${estimatedNetProfitUsdc.toFixed(6)} USDC`,
  );
  console.log(
    `  Est. net return:${estimatedNetReturnPct.toFixed(4)}%`,
  );
  console.log(
    `  Worst case P&L: ${worstCaseNetProfitUsdc.toFixed(6)} USDC (at ${DEFAULT_SLIPPAGE_BPS / 100}% slippage)`,
  );
  console.log(
    `  Quote age:      buy ${buyAge}ms / sell ${sellAge}ms`,
  );
  console.log(
    `  Context slots:  ${buy.contextSlot ?? "n/a"} → ${sell.contextSlot ?? "n/a"}`,
  );

  console.log(
    candidate
      ? "  STATUS:         CANDIDATE"
      : "  STATUS:         NO TRADE",
  );

  const record: OpportunityRecord = {
    timestamp: new Date().toISOString(),

    buyDex: buy.dex,
    sellDex: sell.dex,

    startingUsdc,
    solBought,
    finalUsdc,

    grossProfitUsdc,
    grossReturnPct,

    estimatedCostsUsdc,
    costBreakdownLamports: {
      baseFee: roundTripCost.baseFeeLamports,
      priorityFee: roundTripCost.priorityFeeLamports,
      jitoTip: roundTripCost.jitoTipLamports,
      rent: roundTripCost.rentLamports,
    },
    estimatedNetProfitUsdc,
    estimatedNetReturnPct,

    worstCaseFinalUsdc,
    worstCaseNetProfitUsdc,

    buyQuoteAgeMs: buyAge,
    sellQuoteAgeMs: sellAge,

    buyContextSlot: buy.contextSlot,
    sellContextSlot: sell.contextSlot,

    buyOnChainOutAmount: buy.onChainOutAmount?.toString(),
    sellOnChainOutAmount: sell.onChainOutAmount?.toString(),

    status: candidate
      ? "CANDIDATE"
      : "NO_TRADE",
  };

  appendOpportunity(record);
}

async function testRoundTrip(
  startingUsdc: bigint,
  buy: DexQuote,
  sellDex: string,
): Promise<void> {
  if (!isFresh(buy)) {
    console.log(
      `  ${buy.dex} → ${sellDex}: STALE BUY QUOTE`,
    );
    return;
  }

  const sellResult = await getSellQuote(
    buy.outAmount,
    sellDex,
  );

  if (sellResult.status === "NO_ROUTE") {
    console.log(
      `  ${buy.dex} → ${sellDex}: NO_ROUTE`,
    );
    return;
  }

  if (sellResult.status === "STALE_QUOTE") {
    console.log(
      `  ${buy.dex} → ${sellDex}: STALE_QUOTE`,
    );
    return;
  }

  if (!sellResult.quote) {
    console.log(
      `  ${buy.dex} → ${sellDex}: QUOTE_ERROR`,
    );
    return;
  }

  printOpportunity(
    Number(startingUsdc) / USDC_DECIMALS,
    buy,
    sellResult.quote,
  );
}

async function scan(): Promise<void> {
  console.log(
    "\n========================================",
  );
  console.log(
    "       CROSS-DEX ARBITRAGE SCAN",
  );
  console.log(
    "========================================",
  );

  const startingUsdc = BigInt(
    Math.round(
      START_USDC * USDC_DECIMALS,
    ),
  );

  console.log(
    `Starting capital: ${START_USDC.toFixed(2)} USDC`,
  );

  console.log(
    `Minimum candidate return: ${MIN_PROFIT_PCT.toFixed(2)}%`,
  );

  const headerRoundTripCost = estimateRoundTripCost({
    sellTokenAccountExists: SELL_TOKEN_ACCOUNT_EXISTS,
  });

  console.log(
    `Estimated TX cost: ${headerRoundTripCost.totalSol.toFixed(9)} SOL` +
      ` (base ${headerRoundTripCost.baseFeeLamports} + priority ${headerRoundTripCost.priorityFeeLamports}` +
      ` + jito ${headerRoundTripCost.jitoTipLamports} + rent ${headerRoundTripCost.rentLamports} lamports)`,
  );

  console.log(
    `Maximum quote age: ${MAX_QUOTE_AGE_MS}ms`,
  );

  console.log("\nUSDC → SOL quotes:");

  const buyQuotes =
    await collectUsdcToSolQuotes(
      startingUsdc,
    );

  if (buyQuotes.length === 0) {
    console.log(
      "  No DEX returned a quote.",
    );
    console.log(
      "  Skipping this scan; this is not treated as an opportunity.",
    );
    return;
  }

  for (const quote of buyQuotes) {
    console.log(
      `  ${quote.dex}: ${formatSol(quote.outAmount)} SOL`,
    );

    if (quote.onChainOutAmount !== undefined) {
      const diffPct =
        (Number(quote.onChainOutAmount - quote.outAmount) /
          Number(quote.outAmount)) *
        100;
      console.log(
        `      on-chain:     ${formatSol(quote.onChainOutAmount)} SOL (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(3)}% vs Jupiter)`,
      );
    }

    console.log(
      `      price impact: ${quote.priceImpactPct}%`,
    );

    console.log(
      `      context slot: ${quote.contextSlot ?? "n/a"}`,
    );

    console.log(
      `      age: ${quoteAgeMs(quote)}ms`,
    );
  }

  console.log(
    "\nTesting cross-DEX round trips:",
  );

 const selectedBuyQuotes =
  selectBestBuyQuotes(buyQuotes);

console.log(
  "\nSelected buy venues for deeper probing:",
);

for (const quote of selectedBuyQuotes) {
  console.log(
    `  ${quote.dex}: ${formatSol(quote.outAmount)} SOL`,
  );
}

console.log(
  "\nTesting cross-DEX round trips:",
);

for (const buy of selectedBuyQuotes) {
  for (const sellDex of DEXES) {
    if (buy.dex === sellDex) {
      continue;
    }

    await testRoundTrip(
      startingUsdc,
      buy,
      sellDex,
    );
  }
}

  console.log(
    "\n========================================",
  );
}

async function main(): Promise<void> {
  console.log(
    "=== Cross-DEX Arbitrage Scanner ===",
  );

  console.log(
    "Mode: PAPER / QUOTE ONLY",
  );

  console.log(
    "Execution: DISABLED",
  );

  console.log(
    `Minimum candidate return: ${MIN_PROFIT_PCT.toFixed(2)}%`,
  );

  console.log(
    `Logging: ${LOG_FILE}`,
  );

  while (true) {
    const scanStartedAt = Date.now();

    try {
      await scan();
    } catch (error) {
      console.error(
        "Scan failed:",
      );

      console.error(error);
    }

    const elapsed =
      Date.now() - scanStartedAt;

    const delay = Math.max(
      SCAN_INTERVAL_MS - elapsed,
      1_000,
    );

    console.log(
      `Next scan in ${delay}ms...`,
    );

    await new Promise<void>(
      (resolve) => {
        setTimeout(resolve, delay);
      },
    );
  }
}
main().catch((error) => {
  console.error(
    "Scanner startup failed:",
  );
  console.error(error);
  process.exit(1);
});
