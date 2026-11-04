import { createRequire } from "node:module";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

// The pump.fun SDKs' ESM builds break on Node (bad named imports from @coral-xyz/anchor).
// Their CJS builds work — every project of ours loads them this way.
const require = createRequire(import.meta.url);
const pumpSdk = require("@pump-fun/pump-sdk");
const pumpSwapSdk = require("@pump-fun/pump-swap-sdk");

export const { PumpSdk, OnlinePumpSdk, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda, feeSharingConfigPda, newBondingCurve, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } = pumpSdk;
export const { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } = pumpSwapSdk;
export { pumpSdk, pumpSwapSdk, BN, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

export const LAMPORTS = LAMPORTS_PER_SOL;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const PUMP_DECIMALS = 6; // every pump.fun coin
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const UA = { accept: "application/json", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36" };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
export const pk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));
export const isPubkey = (s) => { try { new PublicKey(s); return true; } catch { return false; } };
export const toRaw = (ui, decimals) => BigInt(Math.floor(ui * 10 ** decimals));
export const fromRaw = (raw, decimals) => Number(raw) / 10 ** decimals;
export const lamportsOf = (sol) => BigInt(Math.max(0, Math.floor(sol * LAMPORTS)));
export const solOf = (lamports) => Number(lamports) / LAMPORTS;

/// Everything a tool needs, built once per process (or per wallet/RPC pair) and passed as the first argument.
///   const ctx = createContext({ rpcUrl, snapshotRpcUrl, priorityMicroLamports, slippagePct })
/// No module reads process.env or holds a global config — that is what made the per-project copies
/// hard to lift out. `log` defaults to console; pass a no-op to silence a tool.
export function createContext({
  rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  snapshotRpcUrl = process.env.SNAPSHOT_RPC_URL || rpcUrl,
  priorityMicroLamports = Number(process.env.PRIORITY_MICRO_LAMPORTS || 100_000),
  slippagePct = Number(process.env.SLIPPAGE_PCT || 5),
  commitment = "confirmed",
  log = console,
} = {}) {
  const connection = new Connection(rpcUrl, commitment);
  const snapshotConnection = snapshotRpcUrl === rpcUrl ? connection : new Connection(snapshotRpcUrl, commitment);
  return {
    connection, snapshotConnection, priorityMicroLamports, slippagePct, commitment, log,
    sdk: new PumpSdk(),
    online: new OnlinePumpSdk(connection),
    amm: new OnlinePumpAmmSdk(connection),
    caches: { mintProgram: new Map(), globals: { at: 0 }, price: new Map(), catalog: { at: 0, map: new Map() }, markets: new Map() },
  };
}
