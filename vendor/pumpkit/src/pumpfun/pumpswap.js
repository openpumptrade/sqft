import { BN, PUMP_AMM_SDK, canonicalPumpPoolPda, pk } from "../context.js";
import { sendTx } from "../tx.js";
import { SOL_QUOTE } from "./curve.js";

/// PumpSwap — where a coin trades after graduation. The canonical pool is derived from the mint (+ quote).

export function poolOf({ mint, quote = SOL_QUOTE, pool }) {
  return pool ? pk(pool) : canonicalPumpPoolPda(pk(mint), quote.isSol ? undefined : pk(quote.mint));
}

/// Unsigned buy paying `quoteAmountRaw` of the quote asset.
export async function buildPumpswapBuy(ctx, { user, mint, quoteAmountRaw, quote = SOL_QUOTE, pool, slippagePct = ctx.slippagePct }) {
  const poolPk = poolOf({ mint, quote, pool });
  const state = await ctx.amm.swapSolanaState(poolPk, pk(user));
  const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(quoteAmountRaw.toString()), slippagePct);
  return { instructions, pool: poolPk.toBase58() };
}

export async function pumpswapBuy(ctx, { wallet, mint, quoteAmountRaw, quote, pool, slippagePct }) {
  const { instructions, pool: p } = await buildPumpswapBuy(ctx, { user: wallet.publicKey, mint, quoteAmountRaw, quote, pool, slippagePct });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, pool: p, venue: "pumpswap" };
}

/// Unsigned sell of EXACTLY `tokenAmountRaw` (base) for the quote asset.
export async function buildPumpswapSell(ctx, { user, mint, tokenAmountRaw, quote = SOL_QUOTE, pool, slippagePct = ctx.slippagePct }) {
  const poolPk = poolOf({ mint, quote, pool });
  const state = await ctx.amm.swapSolanaState(poolPk, pk(user));
  const instructions = await PUMP_AMM_SDK.sellBaseInput(state, new BN(tokenAmountRaw.toString()), slippagePct);
  return { instructions, pool: poolPk.toBase58() };
}

export async function pumpswapSell(ctx, { wallet, mint, tokenAmountRaw, quote, pool, slippagePct }) {
  const { instructions, pool: p } = await buildPumpswapSell(ctx, { user: wallet.publicKey, mint, tokenAmountRaw, quote, pool, slippagePct });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, pool: p, venue: "pumpswap" };
}
