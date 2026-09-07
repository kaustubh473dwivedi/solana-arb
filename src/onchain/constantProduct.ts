import { PublicKey } from "@solana/web3.js";
import { struct, blob } from "@solana/buffer-layout";
import { mainnetConnection } from "./connection.js";

export type ConstantProductVariant = "raydium-v4" | "orca-v2";

// Byte offsets confirmed against raydium-io/raydium-amm state.rs and the
// legacy solana-labs token-swap TokenSwapLayout (Orca V2 is a byte-identical
// fork). Verified live: 752-byte Raydium pool, 324-byte Orca pool.
// Vault fields are plain 32-byte blobs, wrapped into PublicKey after decode
// (avoids @solana/buffer-layout-utils' non-standard package.json "exports"
// resolution, which TypeScript's NodeNext moduleResolution fails to resolve).
const RAYDIUM_V4_LAYOUT = struct<{ baseVault: Uint8Array; quoteVault: Uint8Array }>([
  blob(336, "header"),
  blob(32, "baseVault"),
  blob(32, "quoteVault"),
]);

const ORCA_V2_LAYOUT = struct<{
  poolTokenProgramId: Uint8Array;
  tokenAccountA: Uint8Array;
  tokenAccountB: Uint8Array;
}>([
  blob(3, "header"),
  blob(32, "poolTokenProgramId"),
  blob(32, "tokenAccountA"),
  blob(32, "tokenAccountB"),
]);

// Typical default fee tiers for these pool types. Not decoded per-pool (the
// confirmed research covered vault offsets, not fee-field offsets) -- treat
// as a reasonable approximation for cross-checking, not an exact per-pool value.
export const DEFAULT_FEE_RATE: Record<ConstantProductVariant, number> = {
  "raydium-v4": 0.0025,
  "orca-v2": 0.003,
};

export interface ConstantProductReserves {
  reserveSOL: number;
  reserveUSDC: number;
  solVault: PublicKey;
  usdcVault: PublicKey;
}

async function getVaultAddresses(
  poolAddress: PublicKey,
  variant: ConstantProductVariant,
): Promise<{ vaultA: PublicKey; vaultB: PublicKey }> {
  const accountInfo = await mainnetConnection.getAccountInfo(poolAddress);
  if (!accountInfo) {
    throw new Error(`Pool account not found: ${poolAddress.toBase58()}`);
  }

  if (variant === "raydium-v4") {
    const decoded = RAYDIUM_V4_LAYOUT.decode(accountInfo.data);
    return {
      vaultA: new PublicKey(decoded.baseVault),
      vaultB: new PublicKey(decoded.quoteVault),
    };
  }

  const decoded = ORCA_V2_LAYOUT.decode(accountInfo.data);
  return {
    vaultA: new PublicKey(decoded.tokenAccountA),
    vaultB: new PublicKey(decoded.tokenAccountB),
  };
}

// Vault order (A vs B) isn't guaranteed to be SOL-then-USDC, so we resolve
// each vault's mint to know which reserve is which.
export async function fetchConstantProductReserves(
  poolAddress: PublicKey,
  variant: ConstantProductVariant,
  solMint: PublicKey,
  usdcMint: PublicKey,
): Promise<ConstantProductReserves> {
  const { vaultA, vaultB } = await getVaultAddresses(poolAddress, variant);

  const [vaultAInfo, vaultBInfo] = await Promise.all([
    mainnetConnection.getParsedAccountInfo(vaultA),
    mainnetConnection.getParsedAccountInfo(vaultB),
  ]);

  const infoA = (vaultAInfo.value?.data as any)?.parsed?.info;
  const infoB = (vaultBInfo.value?.data as any)?.parsed?.info;

  if (!infoA || !infoB) {
    throw new Error(
      `Failed to parse vault token accounts for pool ${poolAddress.toBase58()}`,
    );
  }

  const aIsSol = infoA.mint === solMint.toBase58();
  const aIsUsdc = infoA.mint === usdcMint.toBase58();

  if (!aIsSol && !aIsUsdc) {
    throw new Error(
      `Vault A mint ${infoA.mint} matches neither SOL nor USDC for pool ${poolAddress.toBase58()}`,
    );
  }

  return {
    reserveSOL: Number(aIsSol ? infoA.tokenAmount.uiAmount : infoB.tokenAmount.uiAmount),
    reserveUSDC: Number(aIsSol ? infoB.tokenAmount.uiAmount : infoA.tokenAmount.uiAmount),
    solVault: aIsSol ? vaultA : vaultB,
    usdcVault: aIsSol ? vaultB : vaultA,
  };
}
