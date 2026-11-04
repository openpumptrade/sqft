import { mintProgramId, tokenBalanceRaw } from "./token.js";
import { SOL_QUOTE, curveBuy, curveSell, isGraduated } from "./pumpfun/curve.js";
import { pumpswapBuy, pumpswapSell } from "./pumpfun/pumpswap.js";
import { swapForSol, swapSolFor } from "./jupiter.js";
import { sleep } from "./context.js";

/// Venue routing: pump.fun curve while the coin is on one → PumpSwap after graduation → Jupiter for anything
/// else (or when a pump venue fails). The caller never has to know where a coin trades.

/// ONE buy of `mint` paying `lamports` of SOL. Returns {sig, venue}.
export async function buyAny(ctx, { wallet, mint, lamports, programId, pool, quote = SOL_QUOTE }) {
  const grad = await isGraduated(ctx, mint); // null = not a pump.fun coin
  const jup = async () => { const r = await swapSolFor(ctx, { wallet, mint, lamports }); return { sig: r.sig, venue: "jupiter", outAmount: r.outAmount }; };
  if (grad === null) return jup();
  if (grad) {
    try { return await pumpswapBuy(ctx, { wallet, mint, quoteAmountRaw: BigInt(lamports), quote, pool }); }
    catch (err) { ctx.log.warn?.(`[swap] PumpSwap buy of ${String(mint).slice(0, 6)} failed (${String(err.message).slice(0, 80)}) — Jupiter`); return jup(); }
  }
  try { return await curveBuy(ctx, { wallet, mint, quoteAmountRaw: BigInt(lamports), quote, programId: programId || (await mintProgramId(ctx, mint)) }); }
  catch (err) { if (/graduated|complete|6002|BondingCurveComplete/i.test(String(err.message))) return jup(); throw err; }
}

/// Sell EXACTLY `tokenAmountRaw` of `mint` for SOL. Returns {sig, venue}.
export async function sellAny(ctx, { wallet, mint, tokenAmountRaw, programId, pool, quote = SOL_QUOTE }) {
  const grad = await isGraduated(ctx, mint);
  const jup = async () => { const r = await swapForSol(ctx, { wallet, mint, amountRaw: tokenAmountRaw }); return { sig: r.sig, venue: "jupiter", outAmount: r.outAmount }; };
  if (grad === null) return jup();
  if (grad) {
    try { return await pumpswapSell(ctx, { wallet, mint, tokenAmountRaw, quote, pool }); }
    catch (err) { ctx.log.warn?.(`[swap] PumpSwap sell of ${String(mint).slice(0, 6)} failed (${String(err.message).slice(0, 80)}) — Jupiter`); return jup(); }
  }
  try { return await curveSell(ctx, { wallet, mint, tokenAmountRaw, programId: programId || (await mintProgramId(ctx, mint)) }); }
  catch (err) { if (/graduated|complete|6002|BondingCurveComplete/i.test(String(err.message))) return jup(); throw err; }
}

/// A buy you can account for: reads SOL + token balances before and after, so the caller knows exactly what
/// was spent and what came in (the amount to burn / airdrop / credit). This is the primitive every engine round uses.
export async function buyMeasured(ctx, { wallet, mint, lamports, programId, pool, quote }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const me = wallet.publicKey;
  const sol0 = await ctx.connection.getBalance(me);
  const tok0 = await tokenBalanceRaw(ctx, { owner: me, mint, programId });
  const r = await buyAny(ctx, { wallet, mint, lamports, programId, pool, quote });
  await sleep(1200);
  const spentLamports = Math.max(0, sol0 - (await ctx.connection.getBalance(me)));
  let tok1 = tok0;
  for (let i = 0; i < 6 && tok1 <= tok0; i++) { tok1 = await tokenBalanceRaw(ctx, { owner: me, mint, programId }); if (tok1 <= tok0) await sleep(1500); }
  return { ...r, spentLamports, boughtRaw: tok1 > tok0 ? tok1 - tok0 : 0n, balanceBeforeRaw: tok0, balanceAfterRaw: tok1 };
}
