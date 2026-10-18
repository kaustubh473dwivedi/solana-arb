import { buildPoolForDex, type Swappable } from "./crossCheck.js";
import { mainnetConnection } from "./connection.js";

/*
 * Live market-state cache.
 *
 * Replaces the old per-quote fetch pattern, where every single price lookup
 * re-fetched a pool's accounts from scratch and every venue was queried
 * sequentially behind Jupiter's 750ms request gate (~20s for one full scan).
 *
 * Here, every venue is refreshed CONCURRENTLY into a cache, and the strategy
 * then evaluates round trips against that cache using pure local math -- no
 * network in the hot path at all. Wall clock for a full market snapshot drops
 * from ~20s to roughly one RPC round trip.
 *
 * Just as important as the speed: every venue in a snapshot is read at
 * effectively the same moment, so a cross-venue comparison is a real spread
 * rather than two market states observed seconds apart.
 *
 * This module is also the seam where WebSocket account subscriptions will
 * plug in: consumers only ever ask for "current state of venue X", so
 * swapping poll-refresh for push-updates underneath changes nothing above.
 */

// Only venues with an on-chain reader wired up in crossCheck.ts. "Quantum"
// is deliberately absent -- no public SDK or IDL, so it cannot be priced
// locally and therefore cannot participate in the fast path at all.
export const ONCHAIN_VENUES = [
  "Raydium",
  "Orca V2",
  "Meteora DLMM",
  "Whirlpool",
  "Raydium CLMM",
  "Phoenix",
  "OpenBook V2",
] as const;

export type OnChainVenue = (typeof ONCHAIN_VENUES)[number];

export interface VenueState {
  dex: string;
  pool: Swappable;
  fetchedAt: number;
}

export interface VenueFailure {
  dex: string;
  message: string;
  failedAt: number;
}

export interface MarketSnapshot {
  venues: VenueState[];
  failures: VenueFailure[];
  // Slot the snapshot was taken at, fetched alongside the pool reads. Replaces
  // Jupiter's contextSlot as this bot's own notion of "when" a price was true.
  slot: number | null;
  startedAt: number;
  completedAt: number;
}

export function snapshotDurationMs(snapshot: MarketSnapshot): number {
  return snapshot.completedAt - snapshot.startedAt;
}

export function snapshotAgeMs(snapshot: MarketSnapshot): number {
  return Date.now() - snapshot.completedAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * Refreshes every venue concurrently and returns whatever succeeded.
 *
 * Per-venue failure isolation is the whole point of allSettled here: one dead
 * RPC read, one pool with a layout change, or one illiquid market must never
 * blank the entire snapshot or throw into the scan loop. A venue that fails
 * is simply absent from `venues` and recorded in `failures` for visibility --
 * the same fail-soft contract crossCheck.ts already guarantees.
 */
export async function refreshAll(
  venues: readonly string[] = ONCHAIN_VENUES,
): Promise<MarketSnapshot> {
  const startedAt = Date.now();

  const [slotResult, ...poolResults] = await Promise.allSettled([
    mainnetConnection.getSlot(),
    ...venues.map((dex) => buildPoolForDex(dex)),
  ]);

  const ready: VenueState[] = [];
  const failures: VenueFailure[] = [];
  const completedAt = Date.now();

  poolResults.forEach((result, i) => {
    const dex = venues[i];

    if (result.status === "rejected") {
      failures.push({
        dex,
        message: errorMessage(result.reason),
        failedAt: completedAt,
      });
      return;
    }

    // buildPoolForDex returns null for a venue with no reader wired up.
    if (!result.value) {
      failures.push({
        dex,
        message: "no on-chain reader wired up for this venue",
        failedAt: completedAt,
      });
      return;
    }

    ready.push({ dex, pool: result.value, fetchedAt: completedAt });
  });

  return {
    venues: ready,
    failures,
    slot: slotResult.status === "fulfilled" ? slotResult.value : null,
    startedAt,
    completedAt,
  };
}

/*
 * Resolves every venue's pool address once, so the first real snapshot isn't
 * paying for address discovery.
 *
 * Worth doing explicitly at startup because three venues (Whirlpool, Raydium
 * CLMM, Meteora DLMM) discover their pool address via a Jupiter route lookup,
 * and those calls are serialized behind the same 750ms request gate as every
 * other Jupiter call. Addresses are then cached for an hour by poolRegistry,
 * so this cost is paid once per hour rather than inside a scan.
 */
export async function warmUp(
  venues: readonly string[] = ONCHAIN_VENUES,
): Promise<MarketSnapshot> {
  return refreshAll(venues);
}
