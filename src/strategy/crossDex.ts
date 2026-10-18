import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import { getQuote } from "../market/quotes.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  estimateRoundTripCost,
  worstCaseOutputAfterSlippage,
} from "../execution/expenses.js";
import {
  ONCHAIN_VENUES,
  refreshAll,
  snapshotAgeMs,
  snapshotDurationMs,
  warmUp,
  type MarketSnapshot,
  type VenueState,
} from "../onchain/stateStore.js";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const USDC_DECIMALS = 1_000_000;
const SOL_DECIMALS = 1_000_000_000;

const START_USDC = 10;

// Local evaluation costs microseconds, so the scan rate is now bounded by RPC
// politeness rather than by Jupiter's 750ms request gate. A full refresh is
// ~15 RPC calls; 2s keeps that inside what the public mainnet endpoint
// tolerates. With a dedicated RPC this can drop to a few hundred ms -- and
// once account subscriptions land it stops being a poll interval entirely.
const SCAN_INTERVAL_MS = 2_000;

// Minimum gross return required before we call something
// a candidate. This is NOT a trading signal.
const MIN_PROFIT_PCT = 0.10;

// Safety buffer for anything not itemized by expenses.ts (e.g. residual
// slippage beyond the worst-case bound below).
const SAFETY_BUFFER_PCT = 0.05;

// The bot has no USDC token account yet (confirmed via getTokenAccountsByOwner),
// so a real round trip would pay rent to create one on its first trade.
const SELL_TOKEN_ACCOUNT_EXISTS = false;

// A snapshot older than this is not considered fresh enough for a paper
// opportunity. Now measured once per snapshot rather than per quote: every
// venue in a snapshot is read concurrently, so one age covers both legs
// instead of the two legs drifting seconds apart.
const MAX_SNAPSHOT_AGE_MS = 3_000;

// --- Venue sanity gates ---
//
// Promoting on-chain math to the primary price source means a venue that
// decodes to a nonsensical price now drives decisions instead of being a
// diagnostic footnote. Two guards, both pure local math, run before any pair
// is evaluated.
//
// Both thresholds sit orders of magnitude above a real edge (cross-venue
// spreads on this pair measure ~0.005%), so they only ever catch garbage --
// they cannot suppress a genuine opportunity.

// A venue's own buy-then-sell round trip should retain roughly 1 - 2*fee.
// Anything losing more than this to its own spread is not a usable venue.
// Catches Phoenix's observed 37% self-spread and OpenBook V2's dead market.
const MAX_VENUE_ROUND_TRIP_LOSS_PCT = 2.0;

// A venue whose implied price disagrees with the median across all venues by
// more than this is assumed misdecoded rather than genuinely dislocated.
const MAX_PRICE_DEVIATION_PCT = 5.0;

const LOG_DIR = "./logs";
const LOG_FILE = path.join(LOG_DIR, "arbitrage-opportunities.jsonl");

// One leg of a round trip, priced by this bot's own on-chain math.
interface Leg {
  dex: string;
  outAmount: bigint;
  feePaid: number;
  executionPrice: number;
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

  // Both legs are priced from one concurrent read of every venue, so a single
  // age and slot describe the whole round trip. Replaces the old per-leg
  // buyQuoteAgeMs/sellQuoteAgeMs/buyContextSlot/sellContextSlot fields, which
  // existed only because the two legs used to be quoted seconds apart.
  snapshotAgeMs: number;
  snapshotDurationMs: number;
  snapshotSlot: number | null;

  // Marks which pricing path produced the numbers above. Log lines written
  // before the on-chain path became primary have no such field, so a consumer
  // can tell the two eras apart.
  priceSource: "onchain";

  buyOnChainOutAmount: string; // bigint, stringified for JSON
  sellOnChainOutAmount: string;

  status: "CANDIDATE" | "NO_TRADE";
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

function formatSol(lamports: bigint): string {
  return (
    Number(lamports) / SOL_DECIMALS
  ).toFixed(9);
}

function toSolBaseUnits(sol: number): bigint {
  return BigInt(Math.round(sol * SOL_DECIMALS));
}

function toUsdcBaseUnits(usdc: number): bigint {
  return BigInt(Math.round(usdc * USDC_DECIMALS));
}

interface VenueAssessment {
  usable: VenueState[];
  rejected: Array<{ dex: string; reason: string }>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/*
 * Screens out venues whose decoded state produces a price we shouldn't trust.
 *
 * Guard 1 -- self round trip. Buying and immediately selling back on the SAME
 * venue should return roughly what went in, minus twice the fee. A venue that
 * loses materially more than that has a book or curve we're reading wrong (or
 * one with no real liquidity), and its price is not safe to trade against.
 *
 * Guard 2 -- cross-venue agreement. With guard 1 passed, every surviving
 * venue should agree on the price of SOL to within a fraction of a percent.
 * One that doesn't is misdecoded, not dislocated. Median rather than mean, so
 * a single wild outlier can't drag the reference it is being judged against.
 */
function assessVenues(
  venues: VenueState[],
  startingUsdc: number,
): VenueAssessment {
  const rejected: Array<{ dex: string; reason: string }> = [];
  const priced: Array<{ venue: VenueState; impliedPrice: number }> = [];

  for (const venue of venues) {
    let impliedPrice: number;
    let retainedPct: number;

    try {
      const bought = venue.pool.swapUSDCForSOL(startingUsdc).amountOut;

      if (!(bought > 0) || !Number.isFinite(bought)) {
        rejected.push({ dex: venue.dex, reason: "buy probe produced no output" });
        continue;
      }

      const returned = venue.pool.swapSOLForUSDC(bought).amountOut;

      if (!(returned > 0) || !Number.isFinite(returned)) {
        rejected.push({ dex: venue.dex, reason: "sell probe produced no output" });
        continue;
      }

      impliedPrice = startingUsdc / bought;
      retainedPct = (returned / startingUsdc) * 100;
    } catch (error) {
      rejected.push({
        dex: venue.dex,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const lostPct = 100 - retainedPct;

    if (lostPct > MAX_VENUE_ROUND_TRIP_LOSS_PCT) {
      rejected.push({
        dex: venue.dex,
        reason:
          `self round trip loses ${lostPct.toFixed(2)}% ` +
          `(implied ${impliedPrice.toFixed(2)} USDC/SOL) -- unusable spread or misdecoded state`,
      });
      continue;
    }

    priced.push({ venue, impliedPrice });
  }

  if (priced.length < 2) {
    return { usable: priced.map((p) => p.venue), rejected };
  }

  const referencePrice = median(priced.map((p) => p.impliedPrice));
  const usable: VenueState[] = [];

  for (const { venue, impliedPrice } of priced) {
    const deviationPct =
      Math.abs((impliedPrice - referencePrice) / referencePrice) * 100;

    if (deviationPct > MAX_PRICE_DEVIATION_PCT) {
      rejected.push({
        dex: venue.dex,
        reason:
          `implied ${impliedPrice.toFixed(2)} USDC/SOL is ${deviationPct.toFixed(2)}% ` +
          `off the ${referencePrice.toFixed(2)} median -- assumed misdecoded`,
      });
      continue;
    }

    usable.push(venue);
  }

  return { usable, rejected };
}

/*
 * Prices one full round trip against a single snapshot, using nothing but
 * local math -- no network calls anywhere in here.
 *
 * Both legs come from the same snapshot, so this measures a genuine
 * simultaneous spread. The swapMath classes throw when a venue cannot absorb
 * the trade ("Order book depth exhausted", "Pool out of liquidity in range",
 * "Insufficient bin depth to complete trade"), which is an ordinary outcome
 * for a thin venue rather than an error -- caught and reported as null so one
 * unfillable pair never interrupts the sweep.
 */
function priceRoundTrip(
  buyVenue: VenueState,
  sellVenue: VenueState,
  startingUsdc: number,
): { buy: Leg; sell: Leg } | { error: string } {
  try {
    const buyResult = buyVenue.pool.swapUSDCForSOL(startingUsdc);

    if (!(buyResult.amountOut > 0) || !Number.isFinite(buyResult.amountOut)) {
      return { error: "buy leg produced no usable output" };
    }

    const sellResult = sellVenue.pool.swapSOLForUSDC(buyResult.amountOut);

    if (!(sellResult.amountOut > 0) || !Number.isFinite(sellResult.amountOut)) {
      return { error: "sell leg produced no usable output" };
    }

    return {
      buy: {
        dex: buyVenue.dex,
        outAmount: toSolBaseUnits(buyResult.amountOut),
        feePaid: buyResult.feePaid,
        executionPrice: buyResult.executionPrice,
      },
      sell: {
        dex: sellVenue.dex,
        outAmount: toUsdcBaseUnits(sellResult.amountOut),
        feePaid: sellResult.feePaid,
        executionPrice: sellResult.executionPrice,
      },
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printOpportunity(
  startingUsdc: number,
  buy: Leg,
  sell: Leg,
  snapshot: MarketSnapshot,
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
  // instead of at the computed price (DEX swap fee and price impact are
  // already netted into sell.outAmount, so this only adds slippage risk).
  const worstCaseSellOutAmount =
    worstCaseOutputAfterSlippage(sell.outAmount);

  const worstCaseFinalUsdc =
    Number(worstCaseSellOutAmount) / USDC_DECIMALS;

  const worstCaseNetProfitUsdc =
    worstCaseFinalUsdc - startingUsdc - estimatedCostsUsdc;

  const ageMs = snapshotAgeMs(snapshot);

  const candidate =
    grossReturnPct >= MIN_PROFIT_PCT &&
    estimatedNetReturnPct >= SAFETY_BUFFER_PCT;

  // Only CANDIDATEs get printed now. A full sweep is 42 pairs every couple of
  // seconds -- printing all of them buries the one line that matters. Every
  // pair is still written to the log file regardless.
  if (candidate) {
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
      `  Snapshot:       slot ${snapshot.slot ?? "n/a"}, age ${ageMs}ms, read in ${snapshotDurationMs(snapshot)}ms`,
    );
    console.log(
      "  STATUS:         CANDIDATE",
    );
  }

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

    snapshotAgeMs: ageMs,
    snapshotDurationMs: snapshotDurationMs(snapshot),
    snapshotSlot: snapshot.slot,

    priceSource: "onchain",

    buyOnChainOutAmount: buy.outAmount.toString(),
    sellOnChainOutAmount: sell.outAmount.toString(),

    status: candidate
      ? "CANDIDATE"
      : "NO_TRADE",
  };

  appendOpportunity(record);
}

/*
 * Jupiter cross-check, deliberately kept OFF the hot path.
 *
 * This inverts the old arrangement: Jupiter used to price every leg and the
 * on-chain math was the cross-check. Now local math prices everything and
 * Jupiter verifies one venue per scan, round-robin, after the sweep has
 * already finished and logged. One 750ms request per scan instead of ~22
 * blocking ones -- and if it fails or rate-limits, the scan has already done
 * its real work.
 */
let crossCheckCursor = 0;

async function runJupiterCrossCheck(
  snapshot: MarketSnapshot,
): Promise<void> {
  if (snapshot.venues.length === 0) {
    return;
  }

  const venue =
    snapshot.venues[crossCheckCursor % snapshot.venues.length];

  crossCheckCursor++;

  let local: number;
  try {
    local = venue.pool.swapUSDCForSOL(START_USDC).amountOut;
  } catch {
    return; // venue can't absorb the probe size; nothing to compare
  }

  try {
    const quote = await getQuote(
      USDC_MINT,
      SOL_MINT,
      Number(toUsdcBaseUnits(START_USDC)),
      [venue.dex],
    );

    if (!quote.outAmount) {
      return;
    }

    const jupiter = Number(quote.outAmount) / SOL_DECIMALS;
    const diffPct = ((local - jupiter) / jupiter) * 100;

    console.log(
      `  cross-check ${venue.dex}: on-chain ${local.toFixed(9)} SOL` +
        ` vs Jupiter ${jupiter.toFixed(9)} SOL` +
        ` (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(3)}%)`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    // A failed cross-check is diagnostic only -- never a reason to disturb
    // the scan that already completed above.
    console.warn(
      `  cross-check ${venue.dex}: unavailable (${message})`,
    );
  }
}

async function scan(): Promise<void> {
  const snapshot = await refreshAll();

  const venueCount = snapshot.venues.length;

  console.log(
    `\n[${new Date().toISOString()}] snapshot: ${venueCount}/${ONCHAIN_VENUES.length} venues` +
      ` @ slot ${snapshot.slot ?? "n/a"} in ${snapshotDurationMs(snapshot)}ms`,
  );

  for (const failure of snapshot.failures) {
    console.warn(`  unavailable: ${failure.dex} (${failure.message})`);
  }

  if (venueCount < 2) {
    console.log(
      "  Fewer than two venues available; no pair to compare. Skipping.",
    );
    return;
  }

  if (snapshotAgeMs(snapshot) > MAX_SNAPSHOT_AGE_MS) {
    console.log(
      `  Snapshot already stale (${snapshotAgeMs(snapshot)}ms); skipping.`,
    );
    return;
  }

  const { usable, rejected } = assessVenues(snapshot.venues, START_USDC);

  for (const rejection of rejected) {
    console.warn(`  rejected: ${rejection.dex} -- ${rejection.reason}`);
  }

  if (usable.length < 2) {
    console.log(
      `  Only ${usable.length} venue(s) passed sanity checks; no pair to compare. Skipping.`,
    );
    return;
  }

  // Every ordered pair of distinct venues. The old MAX_BUY_VENUES_TO_PROBE
  // cap existed purely to bound Jupiter request volume -- with local math
  // there's nothing left to bound, so the full matrix gets swept.
  let evaluated = 0;
  let unfillable = 0;

  for (const buyVenue of usable) {
    for (const sellVenue of usable) {
      if (buyVenue.dex === sellVenue.dex) {
        continue;
      }

      const priced = priceRoundTrip(buyVenue, sellVenue, START_USDC);

      if ("error" in priced) {
        unfillable++;
        continue;
      }

      evaluated++;

      printOpportunity(
        START_USDC,
        priced.buy,
        priced.sell,
        snapshot,
      );
    }
  }

  console.log(
    `  swept ${evaluated} pairs across ${usable.length} venues` +
      (unfillable > 0 ? ` (${unfillable} unfillable at this size)` : "") +
      `, best buy leg: ${bestBuyLegSummary(usable)}`,
  );

  await runJupiterCrossCheck(snapshot);
}

// Cheap one-line read on where SOL is actually cheapest this snapshot, so the
// terminal still shows market movement now that only CANDIDATEs print.
function bestBuyLegSummary(venues: VenueState[]): string {
  let best: { dex: string; out: number } | null = null;

  for (const venue of venues) {
    try {
      const out = venue.pool.swapUSDCForSOL(START_USDC).amountOut;
      if (!best || out > best.out) {
        best = { dex: venue.dex, out };
      }
    } catch {
      continue;
    }
  }

  return best
    ? `${best.dex} ${formatSol(toSolBaseUnits(best.out))} SOL`
    : "none";
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
    "Pricing: on-chain state (Jupiter demoted to off-path cross-check)",
  );

  console.log(
    `Minimum candidate return: ${MIN_PROFIT_PCT.toFixed(2)}%`,
  );

  console.log(
    `Logging: ${LOG_FILE}`,
  );

  // Resolve every pool address up front. Three venues discover theirs through
  // a Jupiter route lookup, each serialized behind the 750ms request gate, so
  // paying that here keeps it out of the first real scan.
  console.log("\nResolving pool addresses...");

  try {
    const warm = await warmUp();
    console.log(
      `Ready: ${warm.venues.length}/${ONCHAIN_VENUES.length} venues` +
        ` in ${snapshotDurationMs(warm)}ms`,
    );
    for (const failure of warm.failures) {
      console.warn(`  unavailable: ${failure.dex} (${failure.message})`);
    }
  } catch (error) {
    console.error("Warm-up failed; continuing anyway:");
    console.error(error);
  }

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
      250,
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
