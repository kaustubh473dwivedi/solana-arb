import { PublicKey } from "@solana/web3.js";
import { getPoolAddress } from "./poolRegistry.js";
import { fetchConstantProductReserves, DEFAULT_FEE_RATE } from "./constantProduct.js";
import { fetchDlmmState } from "./dlmm.js";
import { fetchCLMMState } from "./clmm.js";
import { fetchPhoenixOrderBook, fetchOpenBookOrderBook } from "./orderbook.js";
import {
  ConstantProductPool,
  CLMMPool,
  DLMMPool,
  OrderBookDEX,
  type SwapResult,
} from "../execution/swapMath.js";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export type SwapDirection = "usdc-to-sol" | "sol-to-usdc";

// Widened from `{ amountOut }` to the full SwapResult: now that the state
// store evaluates round trips locally, callers want feePaid/executionPrice
// too, and every swapMath class already returns exactly this shape.
export interface Swappable {
  swapUSDCForSOL(amountInUSDC: number): SwapResult;
  swapSOLForUSDC(amountInSOL: number): SwapResult;
}

// Only DEXes actually present in crossDex.ts's DEXES array get a case here.
// "Quantum" has no public SDK/IDL (see plan), so no cross-check is possible
// for it -- falls through to the default null case.
export async function buildPoolForDex(dex: string): Promise<Swappable | null> {
  switch (dex) {
    case "Raydium": {
      const address = await getPoolAddress("raydium-v4");
      const reserves = await fetchConstantProductReserves(
        address,
        "raydium-v4",
        SOL_MINT,
        USDC_MINT,
      );
      return new ConstantProductPool(
        reserves.reserveSOL,
        reserves.reserveUSDC,
        DEFAULT_FEE_RATE["raydium-v4"],
      );
    }

    case "Orca V2": {
      const address = await getPoolAddress("orca-v2");
      const reserves = await fetchConstantProductReserves(
        address,
        "orca-v2",
        SOL_MINT,
        USDC_MINT,
      );
      return new ConstantProductPool(
        reserves.reserveSOL,
        reserves.reserveUSDC,
        DEFAULT_FEE_RATE["orca-v2"],
      );
    }

    case "Meteora DLMM": {
      const address = await getPoolAddress("meteora-dlmm");
      const state = await fetchDlmmState(address);
      return new DLMMPool(state.activeBinId, state.binStepBps, state.feeRate, state.bins);
    }

    case "Phoenix": {
      const address = await getPoolAddress("phoenix");
      const book = await fetchPhoenixOrderBook(address);
      return new OrderBookDEX(book.askOrders, book.bidOrders, book.takerFeeRate);
    }

    case "Whirlpool": {
      const address = await getPoolAddress("whirlpool");
      const state = await fetchCLMMState(address, "whirlpool");
      return new CLMMPool(
        state.sqrtPrice,
        state.currentTick,
        state.liquidity,
        state.tickSpacing,
        state.feeRate,
        state.tickArray,
        state.decimalsAdjustment,
      );
    }

    case "Raydium CLMM": {
      const address = await getPoolAddress("raydium-clmm");
      const state = await fetchCLMMState(address, "raydium-clmm");
      return new CLMMPool(
        state.sqrtPrice,
        state.currentTick,
        state.liquidity,
        state.tickSpacing,
        state.feeRate,
        state.tickArray,
        state.decimalsAdjustment,
      );
    }

    case "OpenBook V2": {
      const address = await getPoolAddress("openbook-v2");
      const book = await fetchOpenBookOrderBook(address);
      return new OrderBookDEX(book.askOrders, book.bidOrders, book.takerFeeRate);
    }

    default:
      return null;
  }
}

// Computes what this bot's own on-chain math says a swap should return,
// independent of Jupiter, for cross-checking. Returns null (not an error)
// for DEXes with no reader wired in, or if the live fetch/decode fails --
// callers should treat this as "no cross-check available this scan",
// never as a reason to abort the scan itself.
export async function computeOnChainSwap(
  dex: string,
  direction: SwapDirection,
  amountHumanUnits: number,
): Promise<number | null> {
  try {
    const pool = await buildPoolForDex(dex);
    if (!pool) return null;

    return direction === "usdc-to-sol"
      ? pool.swapUSDCForSOL(amountHumanUnits).amountOut
      : pool.swapSOLForUSDC(amountHumanUnits).amountOut;
  } catch (error) {
    console.warn(
      `    [on-chain cross-check] ${dex} failed:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
