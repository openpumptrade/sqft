import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, feeSharingConfigPda, pk, sleep } from "../context.js";
import { sendTx } from "../tx.js";
import { SOL_QUOTE } from "./curve.js";

/// Creator fees: what is waiting in the vaults, claiming it, and the on-chain fee-sharing split.

function vaultPdas(creatorPk) {
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPk.toBuffer()], PUMP_PROGRAM_ID);
  const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creatorPk.toBuffer()], PUMP_AMM_PROGRAM_ID);
  return { creatorVault, ammVaultAuth };
}

/// Unclaimed creator fees for `creator` in the quote asset — bonding-curve vault + PumpSwap vault, raw units.
export async function creatorVaultBalances(ctx, { creator, quote = SOL_QUOTE }) {
  const creatorPk = pk(creator);
  if (quote.isSol) {
    const total = BigInt((await ctx.online.getCreatorVaultBalanceBothPrograms(creatorPk)).toString());
    return { bonding: total, amm: 0n, total, sol: Number(total) / LAMPORTS };
  }
  const quoteMint = pk(quote.mint);
  const { creatorVault, ammVaultAuth } = vaultPdas(creatorPk);
  const read = async (owner) => { try { return BigInt((await ctx.connection.getTokenAccountBalance(getAssociatedTokenAddressSync(quoteMint, owner, true, quote.tokenProgram))).value.amount); } catch { return 0n; } };
  const [bonding, amm] = await Promise.all([read(creatorVault), read(ammVaultAuth)]);
  return { bonding, amm, total: bonding + amm, sol: null };
}

/// Instructions that move every unclaimed creator fee into the creator's wallet (SOL) / quote ATA (custom pair).
export async function claimInstructions(ctx, { creator, quote = SOL_QUOTE, feePayer }) {
  const creatorPk = pk(creator);
  const payer = feePayer ? pk(feePayer) : creatorPk;
  if (quote.isSol) return ctx.online.collectCoinCreatorFeeInstructions(creatorPk, payer);
  const quoteMint = pk(quote.mint);
  const ata = getAssociatedTokenAddressSync(quoteMint, creatorPk, false, quote.tokenProgram);
  const claimable = await creatorVaultBalances(ctx, { creator, quote });
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer, ata, creatorPk, quoteMint, quote.tokenProgram)];
  if (claimable.total > 0n) ixs.push(...(await ctx.online.collectCoinCreatorFeeV2Instructions(creatorPk, quoteMint, quote.tokenProgram, payer)));
  return ixs;
}

/// Claim the creator fees of `wallet` (the coin's creator). Returns the tx and how much SOL actually landed.
export async function claimCreatorFees(ctx, { wallet, quote = SOL_QUOTE, minLamports = 0n }) {
  const me = wallet.publicKey;
  const claimable = await creatorVaultBalances(ctx, { creator: me, quote });
  if (claimable.total <= BigInt(minLamports)) return { sig: "", claimedRaw: 0n, claimable };
  const instructions = await claimInstructions(ctx, { creator: me, quote });
  if (!instructions.length) return { sig: "", claimedRaw: 0n, claimable };
  const before = quote.isSol ? await ctx.connection.getBalance(me) : null;
  const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: 200_000 });
  let claimedRaw = claimable.total;
  if (quote.isSol) { await sleep(1000); claimedRaw = BigInt(Math.max(0, (await ctx.connection.getBalance(me)) - before)); }
  return { sig, claimedRaw, claimable };
}

// ---------------------------------------------------------------- fee sharing (immutable splits)
/// Instructions that write the fee split on chain, once: create the sharing config for `mint` (payer = the
/// coin's creator) and set the final shareholders. pump.fun locks the config after `updateFeeShares`, so
/// nobody — not even the creator — can ever point the fees anywhere else. shareBps must add up to 10000.
export async function feeSharingInstructions(ctx, { mint, creator, shareholders }) {
  const mintPk = pk(mint), creatorPk = pk(creator);
  const total = shareholders.reduce((s, x) => s + x.shareBps, 0);
  if (total !== 10_000) throw new Error(`shareBps add up to ${total} — must be 10000`);
  const createIx = await ctx.sdk.createFeeSharingConfig({ creator: creatorPk, mint: mintPk, pool: null });
  const updateIx = await ctx.sdk.updateFeeShares({ authority: creatorPk, mint: mintPk, currentShareholders: [creatorPk], newShareholders: shareholders.map((s) => ({ address: pk(s.address), shareBps: s.shareBps })) });
  return { instructions: [createIx, updateIx], sharingConfig: feeSharingConfigPda(mintPk).toBase58() };
}

export async function writeFeeSharing(ctx, { wallet, mint, shareholders }) {
  const { instructions, sharingConfig } = await feeSharingInstructions(ctx, { mint, creator: wallet.publicKey, shareholders });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 200_000 });
  return { sig, sharingConfig };
}

/// The on-chain sharing config of a coin, or null when it still has a plain creator.
export async function readSharingConfig(ctx, mint) {
  const pda = feeSharingConfigPda(pk(mint));
  const info = await ctx.connection.getAccountInfo(pda);
  if (!info) return null;
  const cfg = PUMP_SDK.decodeSharingConfig(info);
  return { address: pda.toBase58(), admin: cfg.admin?.toBase58?.() || "", adminRevoked: Boolean(cfg.adminRevoked), shareholders: (cfg.shareholders || []).map((s) => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps?.toString?.() ?? s.shareBps) })) };
}

/// Fees waiting in a fee-sharing coin's vaults (curve + PumpSwap), in SOL.
export async function sharedFeesWaiting(ctx, mint) {
  const bn = await ctx.online.getCreatorVaultBalanceBothPrograms(feeSharingConfigPda(pk(mint)));
  return Number(bn.toString()) / LAMPORTS;
}

/// Permissionless: move every fee in the vaults to the shareholders. Any funded wallet can pay for it.
export async function distributeSharedFees(ctx, { mint, wallet }) {
  const me = wallet.publicKey;
  const before = await ctx.connection.getBalance(me);
  const { instructions } = await ctx.online.buildDistributeCreatorFeesInstructions(pk(mint), { payer: me });
  const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: 300_000 });
  await sleep(1200);
  const after = await ctx.connection.getBalance(me);
  return { sig, gainedSol: Math.max(0, (after - before) / LAMPORTS) };
}
