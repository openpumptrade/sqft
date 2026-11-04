import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN, PUMP_DECIMALS, WSOL_MINT, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, pk } from "../context.js";
import { sendTx } from "../tx.js";
import { mintProgramId } from "../token.js";

/// The bonding curve: globals, quote assets, estimates, buys and sells while a coin has not graduated.

export const isSolQuote = (p) => !p || p.equals?.(PublicKey.default) || String(p) === WSOL_MINT;

/// pump.fun's Global + FeeConfig accounts, 60 s cache (the fee tiers and the tax gate live here).
export async function pumpGlobals(ctx) {
  const c = ctx.caches.globals;
  if (Date.now() - c.at < 60_000 && c.global) return c;
  const [global, feeConfig] = await Promise.all([ctx.online.fetchGlobal(), ctx.online.fetchFeeConfig()]);
  Object.assign(c, { at: Date.now(), global, feeConfig });
  return c;
}

/// The tax gate as pump.fun has it on chain right now (custom-pair coins can carry their own creator fee).
export async function taxConfig(ctx) {
  const { global } = await pumpGlobals(ctx);
  return { enabled: Boolean(global.creatorFeeConfigurable), maxBps: Number(global.maxConfigurableCreatorFeeBps?.toString?.() ?? 0), holderRewards: Boolean(global.isHolderRewardEnabled) };
}

/// SOL quote descriptor — pass it wherever a `quote` is expected for a plain SOL-paired coin.
export const SOL_QUOTE = { mint: WSOL_MINT, isSol: true, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9, symbol: "SOL", name: "Solana", image: "" };

/// pump.fun's custom-pair catalog (what its create form offers): mint → ticker/name/decimals/image/price. 10 min cache.
export async function fetchQuoteCatalog(ctx) {
  const c = ctx.caches.catalog;
  if (Date.now() - c.at < 10 * 60_000 && c.map.size) return c.map;
  const res = await fetch("https://blockchain-swap.pump.fun/supported/coin-create-mints", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`coin-create-mints → ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data || json.mints || [];
  const map = new Map();
  for (const m of list) map.set(m.mint, { mint: m.mint, ticker: m.ticker || m.symbol, name: m.symbol || m.ticker, decimals: Number(m.decimals), image: m.image_url || "", priceUsd: Number(m.price_usd || 0) });
  Object.assign(c, { at: Date.now(), map });
  return map;
}

/// What a coin is quoted in: SOL, or a custom-pair asset ($PUMP, WBTC, an xStock...).
export async function resolveQuote(ctx, quoteMint) {
  if (isSolQuote(quoteMint)) return SOL_QUOTE;
  const key = String(quoteMint);
  const cat = await fetchQuoteCatalog(ctx).catch(() => new Map());
  const c = cat.get(key);
  const info = await ctx.connection.getParsedAccountInfo(pk(key));
  const decimals = info.value?.data?.parsed?.info?.decimals ?? c?.decimals ?? 6;
  const tokenProgram = info.value?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return { mint: key, isSol: false, tokenProgram, decimals, symbol: c?.ticker || `${key.slice(0, 4)}…${key.slice(-4)}`, name: c?.name || "", image: c?.image || "" };
}

/// The coin's curve: quote (normalized), creator, tax (creatorFeeBps), graduation.
export async function loadCurve(ctx, mint) {
  let bc;
  try { bc = await ctx.online.fetchBondingCurve(pk(mint)); }
  catch (err) { if (/Invalid BondingCurve|0 bytes/i.test(String(err.message))) throw new Error(`${String(mint).slice(0, 8)}… has no pump.fun bonding curve (not a pump.fun coin)`); throw err; }
  const quoteMintPk = isSolQuote(bc.quoteMint) ? new PublicKey(WSOL_MINT) : bc.quoteMint;
  return { bondingCurve: bc, quoteMintPk, creator: bc.creator.toBase58(), complete: Boolean(bc.complete), taxBps: Number(bc.creatorFeeBps?.toString?.() ?? 0), isHolderReward: Boolean(bc.isHolderReward), tokenTotalSupply: bc.tokenTotalSupply };
}

/// true = graduated to PumpSwap, false = still on the curve, null = not a pump.fun coin.
export async function isGraduated(ctx, mint) {
  try { return Boolean((await ctx.online.fetchBondingCurve(pk(mint))).complete); } catch { return null; }
}

/// How many tokens `quoteAmountRaw` buys on the curve right now (fees included). null when graduated.
export async function estimateCurveBuy(ctx, { mint, quoteAmountRaw }) {
  const { global, feeConfig } = await pumpGlobals(ctx);
  const bc = await ctx.online.fetchBondingCurve(pk(mint));
  if (bc.complete) return null;
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(quoteAmountRaw.toString()), quoteMint: isSolQuote(bc.quoteMint) ? PublicKey.default : bc.quoteMint });
  return { tokensRaw: BigInt(amount.toString()), tokens: Number(amount.toString()) / 10 ** PUMP_DECIMALS };
}

/// Unsigned buy instructions for ANY user (the server builds, the user's wallet signs). `quote` = SOL_QUOTE or resolveQuote().
export async function buildCurveBuy(ctx, { user, mint, quoteAmountRaw, quote = SOL_QUOTE, programId, slippagePct = ctx.slippagePct }) {
  const mintPk = pk(mint), userPk = pk(user);
  programId = programId || (await mintProgramId(ctx, mint));
  const { global, feeConfig } = await pumpGlobals(ctx);
  const st = await ctx.online.fetchBuyState(mintPk, userPk, programId, quote.isSol ? undefined : pk(quote.mint));
  if (st.bondingCurve.complete) throw new Error("graduated");
  // the SDK adds `slippage` on top of the amount as the max cost — size the buy so that max never exceeds the
  // budget (a sniper moving the curve between quote and send otherwise ends in InsufficientFunds)
  const slipBps = Math.round(slippagePct * 100);
  const quoteAmount = new BN(quoteAmountRaw.toString()).muln(10_000).divn(10_000 + slipBps);
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: quoteAmount, quoteMint: st.quoteMint });
  const common = { global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mintPk, user: userPk, amount, slippage: slippagePct, tokenProgram: programId };
  const instructions = quote.isSol
    ? await ctx.sdk.buyInstructions({ ...common, solAmount: quoteAmount })
    : await ctx.sdk.buyV2Instructions({ ...common, quoteAmount, quoteTokenProgram: quote.tokenProgram });
  return { instructions, expectedTokensRaw: BigInt(amount.toString()) };
}

/// ONE buy on the curve, signed by `wallet`, paying `quoteAmountRaw` (lamports for SOL).
export async function curveBuy(ctx, { wallet, mint, quoteAmountRaw, quote = SOL_QUOTE, programId, slippagePct }) {
  const { instructions, expectedTokensRaw } = await buildCurveBuy(ctx, { user: wallet.publicKey, mint, quoteAmountRaw, quote, programId, slippagePct });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, expectedTokensRaw, venue: "curve" };
}

/// Unsigned sell of EXACTLY `tokenAmountRaw` on the curve.
export async function buildCurveSell(ctx, { user, mint, tokenAmountRaw, programId, slippagePct = ctx.slippagePct }) {
  const mintPk = pk(mint), userPk = pk(user);
  programId = programId || (await mintProgramId(ctx, mint));
  const { global, feeConfig } = await pumpGlobals(ctx);
  const st = await ctx.online.fetchSellState(mintPk, userPk, programId);
  if (st.bondingCurve.complete) throw new Error("graduated");
  const amount = new BN(tokenAmountRaw.toString());
  const solAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount });
  const instructions = await ctx.sdk.sellInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, mint: mintPk, user: userPk, amount, solAmount, slippage: slippagePct, tokenProgram: programId, mayhemMode: false });
  return { instructions, expectedQuoteRaw: BigInt(solAmount.toString()) };
}

export async function curveSell(ctx, { wallet, mint, tokenAmountRaw, programId, slippagePct }) {
  const { instructions, expectedQuoteRaw } = await buildCurveSell(ctx, { user: wallet.publicKey, mint, tokenAmountRaw, programId, slippagePct });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, expectedQuoteRaw, venue: "curve" };
}
