import { createRequire } from "node:module";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { mainnetConnection } from "./connection.js";

// @orca-so/whirlpools-sdk exports some classes (ParsableWhirlpool etc.) that
// don't resolve correctly through this project's ESM import (same family of
// issue as @meteora-ag/dlmm) -- CJS require is the reliable path here too.
const require = createRequire(import.meta.url);
const {
  PDAUtil,
  ParsableWhirlpool,
  ParsableTickArray,
} = require("@orca-so/whirlpools-sdk");
const {
  PoolInfoLayout,
  TickArrayLayout,
  getPdaTickArrayAddress,
} = require("@raydium-io/raydium-sdk-v2");

export type CLMMVariant = "whirlpool" | "raydium-clmm";

const WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

// Whirlpool's on-chain sqrtPrice/tick represent RAW base-unit ratios
// (tokenB per tokenA), unaware of each mint's decimals. Converting to a
// human "USDC per SOL" price needs a decimals adjustment, and the tick
// math's sign only lines up with this module's SOL/USDC convention when
// tokenMintA is SOL -- the other ordering isn't handled here.
function decimalsAdjustedSqrtPrice(rawSqrtPrice: number, tokenMintA: PublicKey): number {
  if (tokenMintA.toBase58() === SOL_MINT) {
    return rawSqrtPrice * Math.sqrt(10 ** (SOL_DECIMALS - USDC_DECIMALS));
  }
  throw new Error(
    "This pool has USDC as tokenMintA (SOL as tokenMintB) -- that ordering " +
      "isn't handled yet, only tokenMintA === SOL is supported.",
  );
}

export interface CLMMState {
  sqrtPrice: number;
  currentTick: number;
  liquidity: number;
  tickSpacing: number;
  feeRate: number;
  tickArray: Map<number, number>; // tickIndex -> liquidityNet
  // Must be passed into CLMMPool's constructor -- its internal tick->price
  // math needs this to stay on the same scale as sqrtPrice/liquidity above.
  decimalsAdjustment: number;
}

// How many tick arrays to fetch on either side of the current tick. Orca's
// own on-chain swap instruction only ever crosses up to 3 -- matching that
// ceiling here rather than fetching arbitrarily many.
const TICK_ARRAY_OFFSETS = [-1, 0, 1, 2];

export async function fetchWhirlpoolState(
  poolAddress: PublicKey,
): Promise<CLMMState> {
  const poolInfo = await mainnetConnection.getAccountInfo(poolAddress);
  if (!poolInfo) {
    throw new Error(`Whirlpool account not found: ${poolAddress.toBase58()}`);
  }

  const pool = ParsableWhirlpool.parse(poolAddress, poolInfo);
  if (!pool) {
    throw new Error(`Failed to parse Whirlpool account ${poolAddress.toBase58()}`);
  }

  const mintA = pool.tokenMintA.toBase58();
  const mintB = pool.tokenMintB.toBase58();
  const isSolUsdcPair =
    (mintA === SOL_MINT && mintB === USDC_MINT) ||
    (mintA === USDC_MINT && mintB === SOL_MINT);
  if (!isSolUsdcPair) {
    throw new Error(
      `Pool ${poolAddress.toBase58()} is not a SOL/USDC pair (mintA=${mintA}, mintB=${mintB})`,
    );
  }

  const tickArrayPdas = TICK_ARRAY_OFFSETS.map((offset) =>
    PDAUtil.getTickArrayFromTickIndex(
      pool.tickCurrentIndex,
      pool.tickSpacing,
      poolAddress,
      WHIRLPOOL_PROGRAM_ID,
      offset,
    ),
  );

  const tickArrayAddresses = tickArrayPdas.map((pda: { publicKey: PublicKey }) => pda.publicKey);
  const tickArrayInfos = await mainnetConnection.getMultipleAccountsInfo(tickArrayAddresses);

  const tickArray = new Map<number, number>();

  tickArrayInfos.forEach((info: AccountInfo<Buffer> | null, i: number) => {
    if (!info) return; // uninitialized tick array -- no liquidity events in this range

    const parsed = ParsableTickArray.parse(tickArrayAddresses[i], info);
    if (!parsed) return;

    parsed.ticks.forEach((tick: { initialized: boolean; liquidityNet: { toString(): string } }, slot: number) => {
      if (!tick.initialized) return;
      const tickIndex = parsed.startTickIndex + slot * pool.tickSpacing;
      tickArray.set(tickIndex, Number(tick.liquidityNet.toString()));
    });
  });

  const rawSqrtPrice = Number(pool.sqrtPrice.toString()) / 2 ** 64;

  return {
    sqrtPrice: decimalsAdjustedSqrtPrice(rawSqrtPrice, pool.tokenMintA),
    currentTick: pool.tickCurrentIndex,
    liquidity: Number(pool.liquidity.toString()),
    tickSpacing: pool.tickSpacing,
    feeRate: pool.feeRate / 1_000_000,
    tickArray,
    decimalsAdjustment: 10 ** (SOL_DECIMALS - USDC_DECIMALS),
  };
}

const RAYDIUM_CLMM_TICK_ARRAY_SIZE = 60;

function raydiumTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const span = tickSpacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE;
  return Math.floor(tick / span) * span;
}

export async function fetchRaydiumClmmState(
  poolAddress: PublicKey,
): Promise<CLMMState> {
  const poolInfo = await mainnetConnection.getAccountInfo(poolAddress);
  if (!poolInfo) {
    throw new Error(`Raydium CLMM pool account not found: ${poolAddress.toBase58()}`);
  }

  const pool = PoolInfoLayout.decode(poolInfo.data);

  const mintA = pool.mintA.toBase58();
  const mintB = pool.mintB.toBase58();
  const isSolUsdcPair =
    (mintA === SOL_MINT && mintB === USDC_MINT) ||
    (mintA === USDC_MINT && mintB === SOL_MINT);
  if (!isSolUsdcPair) {
    throw new Error(
      `Pool ${poolAddress.toBase58()} is not a SOL/USDC pair (mintA=${mintA}, mintB=${mintB})`,
    );
  }
  if (mintA !== SOL_MINT) {
    throw new Error(
      "This pool has USDC as mintA (SOL as mintB) -- that ordering isn't handled yet.",
    );
  }

  const startIndices = TICK_ARRAY_OFFSETS.map(
    (offset) =>
      raydiumTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing) +
      offset * pool.tickSpacing * RAYDIUM_CLMM_TICK_ARRAY_SIZE,
  );

  const tickArrayAddresses = startIndices.map(
    (startIndex) => getPdaTickArrayAddress(poolInfo.owner, poolAddress, startIndex).publicKey,
  );

  const tickArrayInfos = await mainnetConnection.getMultipleAccountsInfo(tickArrayAddresses);

  const tickArray = new Map<number, number>();

  tickArrayInfos.forEach((info: AccountInfo<Buffer> | null) => {
    if (!info) return;

    const decoded = TickArrayLayout.decode(info.data);
    decoded.ticks.forEach((tick: { tick: number; liquidityNet: { toString(): string } }) => {
      if (tick.tick === 0 && tick.liquidityNet.toString() === "0") return; // empty slot
      tickArray.set(tick.tick, Number(tick.liquidityNet.toString()));
    });
  });

  const rawSqrtPrice = Number(pool.sqrtPriceX64.toString()) / 2 ** 64;
  const decimalsAdjustment = 10 ** (pool.mintDecimalsA - pool.mintDecimalsB);

  return {
    sqrtPrice: rawSqrtPrice * Math.sqrt(decimalsAdjustment),
    currentTick: pool.tickCurrent,
    liquidity: Number(pool.liquidity.toString()),
    tickSpacing: pool.tickSpacing,
    feeRate: 0.0001, // typical Raydium CLMM fee tier; not decoded per-pool here
    tickArray,
    decimalsAdjustment,
  };
}

export async function fetchCLMMState(
  poolAddress: PublicKey,
  variant: CLMMVariant,
): Promise<CLMMState> {
  return variant === "whirlpool"
    ? fetchWhirlpoolState(poolAddress)
    : fetchRaydiumClmmState(poolAddress);
}
