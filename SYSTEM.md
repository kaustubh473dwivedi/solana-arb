# solana-arb — System Overview

A paper-trading (no real execution) cross-DEX arbitrage scanner for SOL/USDC on Solana. It watches multiple DEXes, looks for price gaps between them, and estimates whether a round-trip trade (buy SOL cheap on one venue, sell it for USDC on another) would be profitable after realistic costs.

**Two things run in this project, and only one is in scope:**
- `src/strategy/crossDex.ts` — the actual focus. Cross-exchange arbitrage.
- `src/strategy/collector.ts` — a separate, unrelated mean-reversion data collector. Out of scope; don't conflate the two.

Nothing in this codebase signs or sends a real transaction. Every number is either a live quote from Jupiter's API or this bot's own computed estimate of what a swap *would* return — for research/paper-trading only.

---

## Directory structure

```
solana-arb/
├── src/
│   ├── index.ts                  # standalone script: wallet balance + one quote (not part of the bot loop)
│   ├── market/
│   │   └── quotes.ts             # Jupiter HTTP quote client (rate-limited, queued)
│   ├── execution/
│   │   ├── expenses.ts           # off-chain cost model: base fee, priority fee, jito tip, rent
│   │   └── swapMath.ts           # on-chain swap math for all 4 AMM architectures (pure functions of pool state)
│   ├── onchain/
│   │   ├── connection.ts         # shared mainnet RPC Connection
│   │   ├── poolRegistry.ts       # resolves each DEX -> its real pool/market address (cached 1h)
│   │   ├── constantProduct.ts    # reads real reserves for Raydium v4 / Orca V2 pools
│   │   ├── clmm.ts               # reads real pool + tick-array state for Whirlpool / Raydium CLMM
│   │   ├── dlmm.ts               # reads real pool + bin-array state for Meteora DLMM
│   │   ├── orderbook.ts          # reads real order book (bids/asks) for Phoenix / OpenBook V2
│   │   └── crossCheck.ts         # glue: DEX name -> (fetch real state -> build swapMath pool -> compute swap)
│   └── strategy/
│       ├── crossDex.ts           # THE BOT — scan loop, arbitrage detection, logging (in scope)
│       └── collector.ts          # separate stat-arb data collector (OUT of scope)
├── logs/
│   └── arbitrage-opportunities.jsonl   # one JSON line per opportunity ever printed
├── secrets/
│   └── bot-keypair.json          # devnet wallet keypair (used only by index.ts)
├── .env                          # SOLANA_RPC_URL, SOLANA_MAINNET_RPC_URL, JUPITER_API_KEY
├── package.json / tsconfig.json
└── dist/                         # compiled output (gitignored, regenerable via `npx tsc`)
```

---

## The core idea: two independent price sources, compared

Every scan gets a price for the same trade from **two completely independent paths**, and prints/logs both side by side:

1. **Jupiter's quote API** (`src/market/quotes.ts`) — the established, "trust the aggregator" path. Fast, handles routing across dozens of DEXes, but a black box.
2. **This bot's own on-chain reader** (`src/onchain/*` + `src/execution/swapMath.ts`) — fetches the real pool account directly from mainnet and computes the swap output itself, using the same math each DEX's program actually runs.

The second path exists purely as a **cross-check** — a way to verify Jupiter isn't lying and to understand the mechanics, not to replace Jupiter's routing. `crossDex.ts` still uses Jupiter's number for all real arbitrage-detection logic (thresholds, P&L, logging as `CANDIDATE`); the on-chain number is printed alongside as `on-chain: ... (+X% vs Jupiter)` for visibility only.

---

## File-by-file purpose

### `src/market/quotes.ts` — Jupiter quote client
Exports `getQuote(inputMint, outputMint, amount, dexes?)`. Wraps Jupiter's `/swap/v1/quote` HTTP endpoint with:
- A **global request queue** (`queueRequest`) — every call is serialized, never concurrent.
- **Rate-limit backoff** (`MIN_REQUEST_INTERVAL_MS = 750`) — waits at least 750ms between requests; on a 429 it reads `Retry-After` and cools down for up to 1 retry before giving up.
- Requires `JUPITER_API_KEY` in `.env`; throws if missing.

This is the *only* way the bot talks to Jupiter. Both `crossDex.ts` and `collector.ts` import it.

### `src/execution/expenses.ts` — off-chain cost model
Models the costs that are **not** already baked into a Jupiter quote — i.e. everything that happens *outside* the swap instruction itself:
- `baseFeeLamports()` — fixed 5,000 lamports/signature.
- `priorityFeeLamports()` — `computeUnitPrice × computeUnitLimit / 1e6`, using placeholder defaults (`DEFAULT_COMPUTE_UNIT_LIMIT = 400_000`, `DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 50_000`).
- `jitoTipLamports()` — defaults to 0 (unused).
- `rentLamportsIfMissing()` — the real 165-byte SPL token account rent-exempt minimum (1,855,569 lamports), charged if the destination token account doesn't exist yet.
- `estimateRoundTripCost()` — rolls all of the above into one `RoundTripCost` object. **Deliberately excludes** DEX swap fee, price impact, and slippage — those are already reflected in whatever `outAmount` a quote returns, not separate charges to add on top.
- `worstCaseOutputAfterSlippage()` — applies a slippage haircut (`DEFAULT_SLIPPAGE_BPS = 50` = 0.5%) to a quoted amount, for a pessimistic P&L scenario.

Used exclusively by `crossDex.ts`.

### `src/execution/swapMath.ts` — the swap math itself
Four classes, one per AMM architecture, each a **pure function of pool state → swap result**. No network calls in this file at all — it's given numbers, it returns numbers.

| Class | Architecture | Real DEXes |
|---|---|---|
| `ConstantProductPool` | `x·y=k` | Raydium AMM v4, Orca V2 |
| `CLMMPool` | tick-based concentrated liquidity, `x_v·y_v=L²` | Orca Whirlpool, Raydium CLMM |
| `DLMMPool` | discrete price bins, zero slippage per bin | Meteora DLMM |
| `OrderBookDEX` | walks real bid/ask levels | Phoenix, OpenBook V2 |

Each class implements **both directions** — `swapUSDCForSOL()` and `swapSOLForUSDC()` — since a round trip needs to buy on one venue and sell on another.

**The one subtlety that actually mattered in practice**: `CLMMPool` needs a `decimalsAdjustment` constructor argument (`10^(decimalsSOL - decimalsUSDC)`, i.e. 1000) because a tick index always maps to a *raw* base-unit price ratio (`1.0001^tick`), but `sqrtPrice`/`liquidity` are fed in as human, decimals-adjusted numbers. Omitting this caused nonsensical results whenever a trade actually crossed a real tick boundary.

A second, more subtle bug that was found and fixed here: naive AMM formulas like `L·(1/a − 1/b)` suffer **catastrophic floating-point cancellation** when `a` and `b` are nearly identical (the normal case — real pool liquidity `L` is enormous, ~10¹⁴–10¹⁵, so any modest trade barely moves the price). Every place in `CLMMPool` that used this pattern was rewritten into an algebraically-equivalent but numerically stable form (e.g. `remainingIn/(currSqrtP·finalSqrtP)` instead of `L·(1/currSqrtP − 1/finalSqrtP)`) — see the inline comments in the file for the derivation of each.

### `src/onchain/connection.ts`
One shared `Connection` object, hardcoded to mainnet (`SOLANA_MAINNET_RPC_URL` env override, else the public endpoint). All on-chain reading needs mainnet regardless of which cluster the rest of the bot points at, since that's where real liquidity and Jupiter's own routing live.

### `src/onchain/poolRegistry.ts` — DEX name → real address
`getPoolAddress(kind: PoolKind)` resolves and caches (1 hour) the actual on-chain address to read for each DEX. **Discovery mechanism differs per DEX — there's no unified way to do this**:

| DEX | How it's found |
|---|---|
| `raydium-v4`, `orca-v2` | Hardcoded, pre-verified addresses (simplest, one less failure mode) |
| `whirlpool`, `raydium-clmm`, `meteora-dlmm` | Ask Jupiter for a quote filtered to that one DEX label, read the real pool address out of the returned route (`resolvePoolViaJupiterRoute`) — validated to only trust a hop whose mints are *directly* SOL/USDC, since a filtered quote can still be a multi-hop route through another mint |
| `phoenix` | Fetches Phoenix's own published `master_config.json` market list |
| `openbook-v2` | Hardcoded, pre-verified address (its `getProgramAccounts`-based discovery is rejected by the public RPC endpoint) |

### `src/onchain/constantProduct.ts` — Raydium v4 / Orca V2 reader
`fetchConstantProductReserves(poolAddress, variant, solMint, usdcMint)`. Decodes the pool account's raw bytes using hand-rolled `@solana/buffer-layout` structs (exact byte offsets for each program's vault-pubkey fields), then fetches the two vault **token accounts** (plain SPL accounts) to get real reserve balances. Resolves which vault is SOL vs USDC by checking each vault's parsed mint — vault ordering isn't guaranteed.

### `src/onchain/clmm.ts` — Whirlpool / Raydium CLMM reader
`fetchCLMMState(poolAddress, variant)`. For each variant: decode the main pool account (`liquidity`, `sqrtPrice`, `currentTick`, `tickSpacing`, `feeRate`), then fetch up to 4 adjacent **tick array** accounts (via each program's own PDA-derivation helper) and flatten every initialized tick's `liquidityNet` into one `Map<tickIndex, liquidityNet>`. Uses each SDK's real Anchor-based decoder (`ParsableWhirlpool`/`ParsableTickArray` for Orca, `PoolInfoLayout`/`TickArrayLayout` for Raydium) rather than hand-rolled offsets, since these accounts use packed/bytemuck layouts that are easy to get subtly wrong.

### `src/onchain/dlmm.ts` — Meteora DLMM reader
`fetchDlmmState(poolAddress)`. Decodes the `lbPair` account for `activeId`/`binStep`, then fetches up to 3 adjacent **bin array** accounts (70 bins each) via the SDK's own PDA derivation, and builds a flat `DLMMBin[]` list (real `reserveX`/`reserveY`/`price` per bin, price computed via the SDK's own `getPriceOfBinByBinId` helper, decimals-adjusted).

### `src/onchain/orderbook.ts` — Phoenix / OpenBook V2 reader
`fetchPhoenixOrderBook()` and `fetchOpenBookOrderBook()`, both returning the same `OrderBookState` shape (`askOrders`, `bidOrders`, `takerFeeRate`). Both venues' order books are intricate binary tree structures (a red-black tree for Phoenix, a slab for OpenBook) — **hand-parsing was deliberately not attempted**; both use the DEX's own official SDK to load the market and read an L2 price ladder.

### `src/onchain/crossCheck.ts` — the glue layer
`computeOnChainSwap(dex, direction, amountHumanUnits)` is the single entry point `crossDex.ts` calls. Internally, `buildPoolForDex(dex)` is a big switch statement: DEX name → (call the matching reader above → construct the matching `swapMath.ts` class instance). Returns `null` (not a thrown error) for any DEX with no reader wired up, or if the live fetch/decode fails — this is a deliberate design choice so a cross-check failure **never** breaks the main scan loop.

### `src/strategy/crossDex.ts` — the bot itself
See "How arbitrage detection actually happens" below for the full flow. Key constants at the top:
```ts
const DEXES = ["Raydium", "Meteora DLMM", "Orca V2", "Quantum", "Phoenix", "Whirlpool", "Raydium CLMM", "OpenBook V2"];
const START_USDC = 10;              // pretend starting capital per scan
const MIN_PROFIT_PCT = 0.10;        // gross return threshold (0.10%, NOT a trading signal by itself)
const SAFETY_BUFFER_PCT = 0.05;     // net return threshold, after estimated costs
const MAX_QUOTE_AGE_MS = 3_000;     // reject stale quotes
const MAX_BUY_VENUES_TO_PROBE = 2;  // cap combinations tested per scan
```

### `src/index.ts`
Not part of the bot loop — a standalone script that connects to devnet, prints the wallet's SOL balance, and fetches one SOL→USDC quote as a sanity check. Uses `secrets/bot-keypair.json`.

### `src/strategy/collector.ts` — out of scope
A separate mean-reversion research tool comparing SOL/USDC vs JitoSOL/USDC prices every 5s. Shares `quotes.ts` but nothing else with `crossDex.ts`. Not touched by any of the on-chain cross-check work.

---

## How arbitrage detection actually happens (the real flow)

Everything below happens inside `crossDex.ts`'s `main()` → infinite loop → `scan()`, once every ~5 seconds:

**1. Collect a buy quote from every DEX** (`collectUsdcToSolQuotes`)
For each of the 8 `DEXES`, sequentially: ask Jupiter "if I spend 10 USDC, how much SOL do I get on *this specific DEX*?" (`getDexQuote`). Each result also triggers `computeCrossCheckOutAmount` — the on-chain reader for that DEX (if one is wired up), producing `onChainOutAmount` for display only.

**2. Print every buy quote found**, including the on-chain cross-check line (`+X% vs Jupiter`) when available, plus Jupiter's own `priceImpactPct`.

**3. Narrow to the top 2 buy venues** (`selectBestBuyQuotes`) — freshest quotes, sorted by most SOL received, capped at `MAX_BUY_VENUES_TO_PROBE`.

**4. For each selected buy venue, test selling on every *other* DEX** (`testRoundTrip`, nested loop over `DEXES`):
   - Re-check the buy quote is still fresh (time has passed since step 1).
   - Ask Jupiter: "if I sell that much SOL, how much USDC do I get on *this* DEX?" (another `getDexQuote` call, same cross-check mechanism).
   - If fresh and valid, call `printOpportunity(startingUsdc, buy, sell)`.

**5. `printOpportunity` — the actual profit math**:
```
grossProfitUsdc = finalUsdc - startingUsdc
usdcPerSol      = startingUsdc / solBought          // this trade's own implied price
estimatedCostsUsdc = estimateRoundTripCost(...).totalSol * usdcPerSol
estimatedNetProfitUsdc = grossProfitUsdc - estimatedCostsUsdc
worstCaseFinalUsdc = worstCaseOutputAfterSlippage(sell.outAmount)  // 0.5% haircut
candidate = grossReturnPct >= MIN_PROFIT_PCT AND estimatedNetReturnPct >= SAFETY_BUFFER_PCT
```
Prints everything (including the on-chain cross-check for the sell leg), then appends a full `OpportunityRecord` — every number above, plus both legs' on-chain cross-check amounts — as one line to `logs/arbitrage-opportunities.jsonl`.

**6. Loop.** `main()`'s `while(true)` re-runs `scan()` roughly every 5 seconds (adjusted for how long the previous scan took), catching and logging any error without crashing.

**Nothing here ever builds, signs, or sends a transaction** — `candidate`/`CANDIDATE` just means "this line is interesting enough to have been worth computing," logged for later human review.

---

## Known limitations (deliberate, not bugs)

- **`Quantum`** has no cross-check — it's a real, live Jupiter-routed program with no public SDK or documentation; building a reader would mean independently reverse-engineering an unknown binary layout.
- **`OpenBook V2`** has a fully working reader, but its only SOL/USDC market currently has almost no real resting liquidity (best bid/ask nowhere near the real price) — confirmed independently by Jupiter's own router also returning "no route" for this pair. The cross-check will start producing meaningful numbers automatically if that market ever gets real liquidity.
- **CLMM readers only handle the case where `tokenMintA`/`mintX` is SOL** — the reverse mint ordering throws a clear error rather than silently computing a wrong price.
- **Fee rates for constant-product/CLMM/DLMM pools are typical defaults, not decoded per-pool** — fine for cross-checking purposes, not exact.
- **Several third-party SDKs (`@meteora-ag/dlmm`, `@orca-so/whirlpools-sdk`, `@openbook-dex/openbook-v2`) have broken ESM builds** (their compiled `.mjs` output has subpath imports that fail strict Node ESM resolution). Worked around throughout by forcing their CJS build via `createRequire(import.meta.url)` — look for this pattern in `clmm.ts`, `dlmm.ts`, `orderbook.ts`, `poolRegistry.ts`.
