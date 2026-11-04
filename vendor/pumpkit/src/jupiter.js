import { VersionedTransaction } from "@solana/web3.js";
import { WSOL_MINT } from "./context.js";

/// Jupiter. quote-api.jup.ag/v6 is DEAD (fetch failed since mid-2026) — lite-api.jup.ag/swap/v1 is the
/// same request/response shape. Price: lite-api.jup.ag/price/v3.
const JUP = "https://lite-api.jup.ag";

export async function jupiterQuote(ctx, { inputMint, outputMint, amountRaw, slippageBps }) {
  const bps = slippageBps ?? Math.round(ctx.slippagePct * 100);
  const res = await fetch(`${JUP}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${bps}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`jupiter quote → ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/// One swap via Jupiter, signed by `wallet`. Returns {sig, outAmount, priceImpactPct}.
export async function jupiterSwap(ctx, { wallet, inputMint, outputMint, amountRaw, slippageBps, maxPriorityLamports = 2_000_000, simulateFirst = true }) {
  const q = await jupiterQuote(ctx, { inputMint, outputMint, amountRaw, slippageBps });
  const swapRes = await fetch(`${JUP}/swap/v1/swap`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: "high" } } }),
  });
  if (!swapRes.ok) throw new Error(`jupiter swap → ${swapRes.status}: ${(await swapRes.text()).slice(0, 160)}`);
  const { swapTransaction } = await swapRes.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([wallet]);
  const { connection } = ctx;
  if (simulateFirst) {
    const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
    if (sim.value.err) throw new Error(`swap simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-3).join(" | ")}`);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
  let conf;
  try { conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"); }
  catch (e) {
    // a slow RPC can report "expired" for a tx that did land: check the signature before giving up
    for (let i = 0; i < 10; i++) {
      const st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (st?.confirmationStatus) { conf = { value: { err: st.err } }; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!conf) throw e;
  }
  if (conf.value.err) throw new Error(`tx ${sig} failed on chain: ${JSON.stringify(conf.value.err)}`);
  return { sig, outAmount: BigInt(q.outAmount || 0), priceImpactPct: Number(q.priceImpactPct || 0) };
}

/// Buy `mint` with `lamports` of SOL.
export const swapSolFor = (ctx, { wallet, mint, lamports, ...rest }) => jupiterSwap(ctx, { wallet, inputMint: WSOL_MINT, outputMint: mint, amountRaw: lamports, ...rest });
/// Sell EXACTLY `amountRaw` of `mint` for SOL — never "everything the wallet holds".
export const swapForSol = (ctx, { wallet, mint, amountRaw, ...rest }) => jupiterSwap(ctx, { wallet, inputMint: mint, outputMint: WSOL_MINT, amountRaw, ...rest });

/// Does a SOL→mint route exist for this size? (the "is this a real market" probe)
export async function hasRoute(ctx, { mint, lamports = 10_000_000 }) {
  try { const q = await jupiterQuote(ctx, { inputMint: WSOL_MINT, outputMint: mint, amountRaw: lamports, slippageBps: 500 }); return Number(q.outAmount) > 0; } catch { return false; }
}

/// What a buy of `lamports` would give back if sold straight away (%, negative = loss) — a liquidity sanity check.
export async function roundTripPct(ctx, { mint, lamports }) {
  const buy = await jupiterQuote(ctx, { inputMint: WSOL_MINT, outputMint: mint, amountRaw: lamports });
  const sell = await jupiterQuote(ctx, { inputMint: mint, outputMint: WSOL_MINT, amountRaw: buy.outAmount });
  return (Number(sell.outAmount) / Number(lamports) - 1) * 100;
}

// ---------------------------------------------------------------- prices
/// USD price of any mint (SOL = WSOL), 30 s cache, CoinGecko fallback for SOL.
export async function getUsdPrice(ctx, mint) {
  const key = String(mint);
  const cache = ctx.caches.price;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 30_000 && hit.price > 0) return hit.price;
  let price = 0;
  try {
    const json = await (await fetch(`${JUP}/price/v3?ids=${key}`, { signal: AbortSignal.timeout(8_000) })).json();
    price = Number(json?.[key]?.usdPrice ?? json?.data?.[key]?.price);
  } catch { /* fall through */ }
  if (!(isFinite(price) && price > 0) && key === WSOL_MINT) {
    try { price = Number((await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8_000) })).json())?.solana?.usd); } catch { /* stale */ }
  }
  if (isFinite(price) && price > 0) cache.set(key, { price, ts: Date.now() });
  return cache.get(key)?.price || 0;
}
export const getSolUsd = (ctx) => getUsdPrice(ctx, WSOL_MINT);

/// Jupiter's token metadata (symbol, name, icon, liquidity) for mints DexScreener does not index.
export async function jupiterTokenMeta(mint) {
  const res = await fetch(`${JUP}/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`jupiter tokens → ${res.status}`);
  const list = await res.json();
  const hit = (Array.isArray(list) ? list : list?.tokens || []).find((t) => t.id === mint || t.address === mint);
  return hit ? { symbol: hit.symbol, name: hit.name, icon: hit.icon || hit.logoURI, liquidity: hit.liquidity } : null;
}
