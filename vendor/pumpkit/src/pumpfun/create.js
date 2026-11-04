import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN, LAMPORTS, UA, getBuyTokenAmountFromSolAmount, newBondingCurve, pk } from "../context.js";
import { compileUnsigned, sendTx, simulate } from "../tx.js";
import { mintProgramId, tokenBalanceSettled } from "../token.js";
import { transferAllTokens } from "../transfer.js";
import { SOL_QUOTE, curveBuy, pumpGlobals } from "./curve.js";

/// Launching coins: metadata → IPFS, create_v2 (SOL pair or custom pair, optional tax), the custodial launch
/// (engine wallet signs) and the trustless launch (the USER's browser signs; the server only builds + relays).

export const SYMBOL_MAX_BYTES = 13; // pump.fun's UI caps at 10, the on-chain create_v2 at 13 (SymbolTooLong, 6044)

/// Metadata + image → pump.fun's IPFS (the same host its own create form uses). Returns {metadataUri, imageUri}.
export async function uploadIpfs({ name, symbol, description, imageBuffer, imageMime = "image/png", twitter, telegram, website, fileName = "coin.png" }) {
  const form = new FormData();
  form.append("file", new Blob([imageBuffer], { type: imageMime }), fileName);
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description || "");
  if (twitter) form.append("twitter", twitter);
  if (telegram) form.append("telegram", telegram);
  if (website) form.append("website", website);
  form.append("showName", "true");
  const res = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form, headers: { "user-agent": UA["user-agent"] }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`IPFS upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!j.metadataUri) throw new Error("IPFS upload returned no metadata URI");
  return { metadataUri: j.metadataUri, imageUri: j.metadata?.image || "" };
}

/// create_v2 for a coin paired with SOL (default) or quoted in a custom pair, optionally with its own creator
/// fee (`taxBps`, custom pairs only — pump.fun ignores it on SOL/USDC). SDK 2.x appends the pair's accounts itself.
export async function buildCreate(ctx, { mint, name, symbol, uri, creator, user, quote = SOL_QUOTE, taxBps = 0 }) {
  if (Buffer.byteLength(symbol) > SYMBOL_MAX_BYTES) throw new Error(`ticker over ${SYMBOL_MAX_BYTES} bytes`);
  const args = { mint: pk(mint), name, symbol, uri, creator: pk(creator), user: pk(user), mayhemMode: false };
  if (quote.isSol) return ctx.sdk.createV2Instruction(args);
  return ctx.sdk.createV2Instruction({ ...args, quoteMint: pk(quote.mint), quoteTokenProgram: quote.tokenProgram, creatorFeeBps: taxBps ? new BN(taxBps) : undefined });
}

/// Free dry run of a create from any funded payer — catches SymbolTooLong & co. before spending.
export async function simulateCreate(ctx, { name, symbol, uri = "https://example.com/x.json", payer, quote = SOL_QUOTE, taxBps = 0 }) {
  const mint = Keypair.generate().publicKey;
  const ix = await buildCreate(ctx, { mint, name, symbol, uri, creator: payer, user: payer, quote, taxBps });
  return simulate(ctx, { instructions: [ix], payer, computeUnits: 400_000 });
}

/// CUSTODIAL launch: `wallet` (the engine) creates the coin, is its creator, optionally dev-buys and ships
/// the tokens to `devBuyTo`. Returns mint, txs and what the dev buy got.
export async function createCoin(ctx, { wallet, name, symbol, uri, quote = SOL_QUOTE, taxBps = 0, devBuyLamports = 0n, devBuyTo, mintKeypair, gasReserveLamports = 0 }) {
  const mintKp = mintKeypair || Keypair.generate();
  const mint = mintKp.publicKey.toBase58();
  const createIx = await buildCreate(ctx, { mint: mintKp.publicKey, name, symbol, uri, creator: wallet.publicKey, user: wallet.publicKey, quote, taxBps });
  const createTx = await sendTx(ctx, { instructions: [createIx], payer: wallet.publicKey, signers: [wallet, mintKp], computeUnits: 400_000 });
  const out = { mint, createTx, devBuyTx: "", devTransferTx: "", devTokensRaw: 0n };
  if (devBuyLamports > 0n && quote.isSol) {
    const programId = await mintProgramId(ctx, mint);
    const balance = await ctx.connection.getBalance(wallet.publicKey);
    const lamports = BigInt(Math.min(Number(devBuyLamports), Math.max(0, balance - gasReserveLamports)));
    if (lamports > 0n) {
      const r = await curveBuy(ctx, { wallet, mint, quoteAmountRaw: lamports, quote, programId });
      out.devBuyTx = r.sig;
      out.devTokensRaw = await tokenBalanceSettled(ctx, { owner: wallet.publicKey, mint, programId });
      if (devBuyTo && String(devBuyTo) !== wallet.publicKey.toBase58()) {
        const t = await transferAllTokens(ctx, { wallet, mint, to: devBuyTo, programId });
        out.devTransferTx = t.sig;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the trustless launch
/// Unsigned launch for a USER: [fee → treasury, create_v2 (creator = user), (dev buy)]. The mint keypair is
/// generated in the browser — only its pubkey comes here; nothing is signed server-side. Over 1232 bytes the
/// dev buy moves to a second tx unless a lookup table (`lookupTables`) is passed. The browser verifies the
/// bytes with ./verify.js BEFORE signing; the server relays with tx.relaySigned and proves the fee on chain.
export async function buildLaunchTxs(ctx, { user, mint, name, symbol, uri, devBuyLamports = 0n, feeLamports = 0, treasury, slippagePct = ctx.slippagePct, lookupTables = [] }) {
  const userPk = pk(user), mintPk = pk(mint);
  const { global, feeConfig } = await pumpGlobals(ctx);
  const pre = [];
  if (feeLamports > 0) { if (!treasury) throw new Error("feeLamports without a treasury"); pre.push(SystemProgram.transfer({ fromPubkey: userPk, toPubkey: pk(treasury), lamports: Number(feeLamports) })); }
  let createIx, buyIxs = [];
  if (devBuyLamports > 0n) {
    const solAmount = new BN(devBuyLamports.toString());
    // the curve is brand new, so the quote is exact; slippage only covers someone sniping in the same block
    const spend = solAmount.muln(10_000).divn(10_000 + Math.round(slippagePct * 100));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve: newBondingCurve(global), amount: spend, quoteMint: PublicKey.default });
    [createIx, ...buyIxs] = await ctx.sdk.createV2AndBuyInstructions({ global, mint: mintPk, name, symbol, uri, creator: userPk, user: userPk, amount, solAmount, mayhemMode: false });
  } else {
    createIx = await ctx.sdk.createV2Instruction({ mint: mintPk, name, symbol, uri, creator: userPk, user: userPk, mayhemMode: false });
  }
  const one = await compileUnsigned(ctx, { payer: userPk, instructionSets: [[...pre, createIx, ...buyIxs]], computeUnits: buyIxs.length ? 400_000 : 250_000, lookupTables }).catch(() => null);
  if (one) return { ...one, split: false };
  if (!buyIxs.length) throw new Error("launch transaction too large — shorten the name / ticker");
  const two = await compileUnsigned(ctx, { payer: userPk, instructionSets: [[...pre, createIx], buyIxs], computeUnits: [250_000, 200_000], lookupTables });
  return { ...two, split: true };
}

/// Every static account pump.fun's create + buy touch (same for any deployer / mint) — the contents of an
/// address lookup table that makes fee + create + dev buy fit in one tx (1318 → 992 bytes).
export async function staticLaunchAccounts(ctx, { treasury } = {}) {
  const { global, feeConfig } = await pumpGlobals(ctx);
  const build = async () => {
    const user = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
    const solAmount = new BN(10_000_000);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: global.tokenTotalSupply, bondingCurve: newBondingCurve(global), amount: solAmount, quoteMint: PublicKey.default });
    const ixs = await ctx.sdk.createV2AndBuyInstructions({ global, mint, name: "x", symbol: "x", uri: "x", creator: user, user, amount, solAmount, mayhemMode: false });
    return new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
  };
  const [a, b] = await Promise.all([build(), build()]);
  const keys = new Set([...a].filter((k) => b.has(k)));
  for (const r of [...(global.feeRecipients || []), global.feeRecipient, ...(global.reservedFeeRecipients || []), global.reservedFeeRecipient]) if (r) keys.add(r.toBase58());
  for (const k of [SystemProgram.programId, ComputeBudgetProgram.programId, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID]) keys.add(k.toBase58());
  if (treasury) keys.add(String(treasury));
  keys.delete(PublicKey.default.toBase58());
  return [...keys].map((k) => new PublicKey(k));
}

export { LAMPORTS };
