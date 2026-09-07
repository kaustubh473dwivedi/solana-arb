import { createRequire } from "node:module";
import { PublicKey, Keypair } from "@solana/web3.js";
import { mainnetConnection } from "./connection.js";
import type { LimitOrder } from "../execution/swapMath.js";

const require = createRequire(import.meta.url);

export interface OrderBookState {
  askOrders: LimitOrder[]; // ascending by price
  bidOrders: LimitOrder[]; // descending by price
  takerFeeRate: number;
}

// Phoenix: fully tested against the real live SOL/USDC market.
export async function fetchPhoenixOrderBook(
  marketAddress: PublicKey,
  levels = 10,
): Promise<OrderBookState> {
  const phoenix = require("@ellipsis-labs/phoenix-sdk");

  const market = await phoenix.MarketState.loadFromAddress({
    connection: mainnetConnection,
    address: marketAddress,
  });

  const ladder = phoenix.getMarketUiLadder(market, levels);

  return {
    askOrders: ladder.asks.map((l: { price: number; quantity: number }) => ({
      price: l.price,
      solQuantity: l.quantity,
    })),
    bidOrders: ladder.bids.map((l: { price: number; quantity: number }) => ({
      price: l.price,
      solQuantity: l.quantity,
    })),
    // Phoenix's taker fee is read from market.header/marketData at a rate
    // that varies by market tier; 0 here since the ladder prices already
    // reflect the raw book (fee is charged separately at settlement).
    takerFeeRate: 0,
  };
}

// OpenBook v2's client needs a full Anchor Provider (a Connection + a
// Wallet), even for pure reads. A throwaway keypair works fine here -- it
// only needs a public key to satisfy the Wallet interface, nothing is ever
// signed or sent.
let cachedProvider: unknown;
function getReadOnlyProvider() {
  if (!cachedProvider) {
    // openbook-v2's own nested @coral-xyz/anchor copy (0.29.0) must be used,
    // not whatever version this project's hoisted top-level node_modules
    // resolves to (0.31.0/0.32.1, from the other Solana SDKs pulled in) --
    // those aren't guaranteed IDL/API-compatible with what openbook-v2 expects.
    // Deliberately NOT added to package.json: @meteora-ag/dlmm, @openbook-dex/
    // openbook-v2, and @orca-so/whirlpools-sdk each pin a genuinely different,
    // non-deduped anchor version (0.31.0/0.29.0/0.32.1) -- there's no single
    // "the" version to declare, and a top-level entry wouldn't be what this
    // scoped require below actually resolves to anyway.
    const openbookMainPath = require.resolve("@openbook-dex/openbook-v2");
    const scopedRequire = createRequire(openbookMainPath);
    const anchor = scopedRequire("@coral-xyz/anchor");
    const wallet = new anchor.Wallet(Keypair.generate());
    cachedProvider = new anchor.AnchorProvider(mainnetConnection, wallet, {});
  }
  return cachedProvider;
}

export async function fetchOpenBookOrderBook(
  marketAddress: PublicKey,
  levels = 10,
): Promise<OrderBookState> {
  const openbook = require("@openbook-dex/openbook-v2");
  const client = new openbook.OpenBookV2Client(getReadOnlyProvider());

  const market = await openbook.Market.load(client, marketAddress);
  await market.loadOrderBook();

  const toLimitOrders = (levelsL2: Array<[number, number]>): LimitOrder[] =>
    levelsL2.map(([price, size]) => ({ price, solQuantity: size }));

  return {
    askOrders: toLimitOrders(market.asks.getL2(levels)),
    bidOrders: toLimitOrders(market.bids.getL2(levels)),
    // OpenBook v2's taker fee is a market-level config value; 0 here since
    // the ladder prices already reflect the raw resting orders.
    takerFeeRate: 0,
  };
}
