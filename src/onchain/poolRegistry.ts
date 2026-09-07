import { PublicKey } from "@solana/web3.js";

// Resolves each DEX to its real SOL/USDC pool/market address, once at
// startup, rather than on every 5s scan. Discovery mechanism differs per
// DEX (see comments) -- there's no single unified way to do this without
// Jupiter, which is exactly the tradeoff of going on-chain-native.

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface PoolRegistryEntry {
  address: PublicKey;
  resolvedAt: number;
}

const cache = new Map<string, PoolRegistryEntry>();
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function isFresh(entry: PoolRegistryEntry): boolean {
  return Date.now() - entry.resolvedAt < REFRESH_INTERVAL_MS;
}

// Raydium AMM v4 and Orca V2 pool addresses: verified live against their
// program IDs during development (see conversation record). Raydium also
// publishes a discovery API (api-v3.raydium.io/pools/info/mint) but a
// hardcoded, already-verified address is simpler and has one less failure
// mode for a single well-known pair.
const KNOWN_ADDRESSES: Record<string, string> = {
  "raydium-v4": "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
  "orca-v2": "EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U",
};

async function resolveKnownAddress(key: string): Promise<PublicKey> {
  const address = KNOWN_ADDRESSES[key];
  if (!address) {
    throw new Error(`No known pool address configured for "${key}"`);
  }
  return new PublicKey(address);
}

async function resolveMeteoraDlmmPool(): Promise<PublicKey> {
  // Meteora's REST API (dlmm-api.meteora.ag) 404'd on every documented path.
  // The SDK's on-chain PDA lookup (getCustomizablePermissionlessLbPairIfExists)
  // works but only finds *a* deterministic pool for the pair, not necessarily
  // a liquid/actively-traded one -- verified live it returns a stale pool
  // priced ~20% off every other venue. The Jupiter-route trick (same as
  // Whirlpool/Raydium CLMM) reliably finds the pool Jupiter actually routes
  // through, so use that instead.
  return resolvePoolViaJupiterRoute("Meteora DLMM");
}

// Whirlpool / Raydium CLMM pool discovery: reuse the same trick proven live
// in this conversation -- ask Jupiter for a quote filtered to one DEX label
// and read the real pool address out of the route. Simpler and more
// reliable than independently indexing every CLMM pool ourselves.
async function resolvePoolViaJupiterRoute(dexLabel: string): Promise<PublicKey> {
  const url = new URL("https://api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", SOL_MINT);
  url.searchParams.set("outputMint", USDC_MINT);
  // 10 SOL -- large enough that Jupiter engages a pool's direct route
  // instead of only routing small amounts through an indirect multi-hop path.
  url.searchParams.set("amount", "10000000000");
  url.searchParams.set("dexes", dexLabel);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Jupiter route lookup failed for ${dexLabel}: ${response.status}`);
  }

  const quote = (await response.json()) as {
    routePlan?: Array<{
      swapInfo: { ammKey: string; inputMint: string; outputMint: string };
    }>;
    error?: string;
  };

  if (quote.error || !quote.routePlan?.length) {
    throw new Error(`No ${dexLabel} route found via Jupiter`);
  }

  // A filtered-to-one-DEX quote can still be a multi-hop route (e.g.
  // SOL->USDT->USDC) -- only trust a hop whose mints are actually SOL/USDC
  // directly, don't just take routePlan[0] blindly.
  const directHop = quote.routePlan.find(
    (hop) =>
      (hop.swapInfo.inputMint === SOL_MINT && hop.swapInfo.outputMint === USDC_MINT) ||
      (hop.swapInfo.inputMint === USDC_MINT && hop.swapInfo.outputMint === SOL_MINT),
  );

  if (!directHop) {
    throw new Error(
      `${dexLabel} route via Jupiter has no direct SOL/USDC hop (got ${quote.routePlan.length}-hop route through other mints)`,
    );
  }

  return new PublicKey(directHop.swapInfo.ammKey);
}

async function resolvePhoenixMarket(): Promise<PublicKey> {
  const response = await fetch(
    "https://raw.githubusercontent.com/Ellipsis-Labs/phoenix-sdk/master/master_config.json",
  );
  if (!response.ok) {
    throw new Error(`Phoenix master config request failed: ${response.status}`);
  }

  // Real structure (verified live, differs from the SDK's own doc examples):
  // { "mainnet-beta": { markets: [{ market, baseMint, quoteMint }, ...] } }
  const config = (await response.json()) as {
    "mainnet-beta": {
      markets: Array<{ market: string; baseMint: string; quoteMint: string }>;
    };
  };

  const entry = config["mainnet-beta"].markets.find(
    (m) => m.baseMint === SOL_MINT && m.quoteMint === USDC_MINT,
  );

  if (!entry) {
    throw new Error("No Phoenix SOL/USDC market found in master config");
  }

  return new PublicKey(entry.market);
}

// findAccountsByMints (getProgramAccounts-based discovery) is rejected by
// the public mainnet RPC endpoint -- confirmed during development, and the
// SDK mishandles that rejection with an opaque internal error rather than a
// clean one. Sidestepped with a hardcoded, verified address instead (same
// pattern as raydium-v4/orca-v2 above): confirmed live via Market.load that
// this is the real OpenBook v2 SOL/USDC market (name "SOL-USDC", correct
// mints) -- it just happens to have almost no real liquidity resting on it
// right now (best bid/ask nowhere near the real ~$105 price), which even
// Jupiter's own router reflects (it returns "No routes found" for this pair
// via the "OpenBook V2" label). Not a bug -- this venue is simply unused for
// this pair at the moment; the reader will reflect real depth automatically
// if that ever changes.
const OPENBOOK_V2_SOL_USDC_MARKET = "HPGeZAXNNPzex7QnHP2ZCgyny13BqkNkRg6Lc49PJpdm";

async function resolveOpenBookMarket(): Promise<PublicKey> {
  return new PublicKey(OPENBOOK_V2_SOL_USDC_MARKET);
}

export type PoolKind =
  | "raydium-v4"
  | "orca-v2"
  | "meteora-dlmm"
  | "whirlpool"
  | "raydium-clmm"
  | "phoenix"
  | "openbook-v2";

const RESOLVERS: Record<PoolKind, () => Promise<PublicKey>> = {
  "raydium-v4": () => resolveKnownAddress("raydium-v4"),
  "orca-v2": () => resolveKnownAddress("orca-v2"),
  "meteora-dlmm": resolveMeteoraDlmmPool,
  whirlpool: () => resolvePoolViaJupiterRoute("Whirlpool"),
  "raydium-clmm": () => resolvePoolViaJupiterRoute("Raydium CLMM"),
  phoenix: resolvePhoenixMarket,
  "openbook-v2": resolveOpenBookMarket,
};

export async function getPoolAddress(kind: PoolKind): Promise<PublicKey> {
  const cached = cache.get(kind);
  if (cached && isFresh(cached)) {
    return cached.address;
  }

  const address = await RESOLVERS[kind]();
  cache.set(kind, { address, resolvedAt: Date.now() });
  return address;
}
