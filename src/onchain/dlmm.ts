import { createRequire } from "node:module";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { mainnetConnection } from "./connection.js";
import type { DLMMBin } from "../execution/swapMath.js";

// Same ESM-export issue as the other Solana SDKs pulled in this session --
// CJS require is the reliable path.
const require = createRequire(import.meta.url);
const DLMM = require("@meteora-ag/dlmm");
const BN = require("bn.js");

const METEORA_DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;

const MAX_BIN_PER_ARRAY = 70;

export interface DLMMState {
  activeBinId: number;
  binStepBps: number;
  feeRate: number;
  bins: DLMMBin[];
}

// How many bin arrays to fetch on either side of the active one. Each array
// holds 70 bins, so this covers a wide enough band for a modest trade.
const BIN_ARRAY_OFFSETS = [-1, 0, 1];

export async function fetchDlmmState(poolAddress: PublicKey): Promise<DLMMState> {
  const program = DLMM.createProgram(mainnetConnection);

  const poolInfo = await mainnetConnection.getAccountInfo(poolAddress);
  if (!poolInfo) {
    throw new Error(`DLMM pool account not found: ${poolAddress.toBase58()}`);
  }

  const lbPair = DLMM.decodeAccount(program, "lbPair", poolInfo.data);

  const mintX = lbPair.tokenXMint.toBase58();
  const mintY = lbPair.tokenYMint.toBase58();
  const isSolUsdcPair =
    (mintX === SOL_MINT && mintY === USDC_MINT) ||
    (mintX === USDC_MINT && mintY === SOL_MINT);
  if (!isSolUsdcPair) {
    throw new Error(
      `Pool ${poolAddress.toBase58()} is not a SOL/USDC pair (X=${mintX}, Y=${mintY})`,
    );
  }
  if (mintX !== SOL_MINT) {
    throw new Error(
      "This pool has USDC as tokenX (SOL as tokenY) -- that ordering isn't handled yet.",
    );
  }

  const activeBinArrayIndex = DLMM.binIdToBinArrayIndex(new BN(lbPair.activeId));

  const bins: DLMMBin[] = [];

  for (const offset of BIN_ARRAY_OFFSETS) {
    const index = activeBinArrayIndex.add(new BN(offset));
    const [binArrayPda] = DLMM.deriveBinArray(poolAddress, index, METEORA_DLMM_PROGRAM_ID);

    const binArrayInfo: AccountInfo<Buffer> | null =
      await mainnetConnection.getAccountInfo(binArrayPda);
    if (!binArrayInfo) continue; // uninitialized range -- no liquidity here

    const binArray = DLMM.decodeAccount(program, "binArray", binArrayInfo.data);
    const startBinId = index.toNumber() * MAX_BIN_PER_ARRAY;

    binArray.bins.forEach((bin: { amountX: { toString(): string }; amountY: { toString(): string } }, slot: number) => {
      const binId = startBinId + slot;
      const rawPrice = Number(DLMM.getPriceOfBinByBinId(binId, lbPair.binStep).toString());

      bins.push({
        binId,
        price: rawPrice * 10 ** (SOL_DECIMALS - USDC_DECIMALS),
        reserveX: Number(bin.amountX.toString()) / 10 ** SOL_DECIMALS,
        reserveY: Number(bin.amountY.toString()) / 10 ** USDC_DECIMALS,
      });
    });
  }

  return {
    activeBinId: lbPair.activeId,
    binStepBps: lbPair.binStep,
    feeRate: 0.0001, // typical DLMM base fee; the exact per-pool variable/base fee split isn't decoded here
    bins,
  };
}
