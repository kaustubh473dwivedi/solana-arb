import { LAMPORTS_PER_SOL } from "@solana/web3.js";

// --- Base network fee ---
// Fixed cost per required signature. Has been 5000 lamports since genesis;
// safe to treat as a constant rather than fetching it per transaction.
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000;

export const DEFAULT_SIGNATURE_COUNT = 1;

export function baseFeeLamports(
  signatureCount: number = DEFAULT_SIGNATURE_COUNT,
): number {
  return BASE_FEE_LAMPORTS_PER_SIGNATURE * signatureCount;
}

// --- Priority fee ---
// lamports = computeUnitPrice (micro-lamports/CU) * computeUnitLimit (CU) / 1_000_000
//
// The defaults below are rough placeholders for a two-instruction swap
// round trip, not a measured value. A live bot should pull a real estimate
// from getRecentPrioritizationFees and simulateTransaction before sending,
// rather than trusting these constants.
export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
export const DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 50_000;

export function priorityFeeLamports(
  computeUnitLimit: number = DEFAULT_COMPUTE_UNIT_LIMIT,
  computeUnitPriceMicroLamports: number = DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
): number {
  return Math.ceil(
    (computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000,
  );
}

// --- Jito tip ---
// A plain SOL transfer to a Jito tip account, included inside a bundle.
// Only ever charged if the bundle actually lands, so it defaults to 0
// (not used) rather than an estimate.
export function jitoTipLamports(tipLamports: number = 0): number {
  return tipLamports;
}

// --- DEX swap fee ---
// Jupiter's quote.outAmount already nets this out per leg. This is only
// useful for surfacing how much of a quote's shortfall was pool fee vs.
// price impact — it is NOT a separate charge to apply on top of a quote.
export function dexSwapFeeUnits(
  amountBeforeFee: bigint,
  feeBps: number,
): bigint {
  return (amountBeforeFee * BigInt(feeBps)) / 10_000n;
}

// --- Price impact ---
// Also already reflected in quote.outAmount. This turns quote.priceImpactPct
// into a concrete cost, in the output token's base units, for a given trade.
export function priceImpactCost(
  outAmount: bigint,
  priceImpactPct: number,
): number {
  return Number(outAmount) * (priceImpactPct / 100);
}

// --- Slippage tolerance ---
// The worst-case output you'd still accept before an on-chain swap
// instruction reverts rather than executing at a bad price.
export const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

export function worstCaseOutputAfterSlippage(
  outAmount: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): bigint {
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

// --- Rent ---
// Rent-exempt minimum for a standard 165-byte SPL token account, fetched
// live via getMinimumBalanceForRentExemption(165) on mainnet (2026-09-06).
// Solana's rent schedule is effectively static, so hardcoding avoids an
// RPC round trip on every estimate.
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 1_855_569;

export function rentLamportsIfMissing(accountExists: boolean): number {
  return accountExists ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS;
}

// --- Roll-up: everything charged win-or-lose for one round trip ---
// (base fee + priority fee + jito tip + rent for any new accounts).
// DEX swap fee, price impact, and slippage are deliberately excluded here —
// they're contingent on the swap succeeding and are already reflected in
// quote.outAmount, not separate deductions to add on top.
export interface RoundTripCostParams {
  signatureCount?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  jitoTip?: number;
  buyTokenAccountExists?: boolean;
  sellTokenAccountExists?: boolean;
}

export interface RoundTripCost {
  baseFeeLamports: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
  rentLamports: number;
  totalLamports: number;
  totalSol: number;
}

export function estimateRoundTripCost(
  params: RoundTripCostParams = {},
): RoundTripCost {
  const baseFee = baseFeeLamports(params.signatureCount);

  const priorityFee = priorityFeeLamports(
    params.computeUnitLimit,
    params.computeUnitPriceMicroLamports,
  );

  const tip = jitoTipLamports(params.jitoTip);

  const rent =
    rentLamportsIfMissing(params.buyTokenAccountExists ?? true) +
    rentLamportsIfMissing(params.sellTokenAccountExists ?? true);

  const totalLamports = baseFee + priorityFee + tip + rent;

  return {
    baseFeeLamports: baseFee,
    priorityFeeLamports: priorityFee,
    jitoTipLamports: tip,
    rentLamports: rent,
    totalLamports,
    totalSol: totalLamports / LAMPORTS_PER_SOL,
  };
}
