import "dotenv/config";
import { Connection } from "@solana/web3.js";

// Pool/tick/bin/order-book decoding needs mainnet state regardless of which
// cluster the rest of the bot talks to (Jupiter's quotes are mainnet-only too).
const MAINNET_RPC_URL =
  process.env.SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export const mainnetConnection = new Connection(MAINNET_RPC_URL, "confirmed");
