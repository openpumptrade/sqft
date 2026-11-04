import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction,
  createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { pk } from "./context.js";
import { getMultipleAccounts, sendTx } from "./tx.js";
import { mintProgramId, tokenBalanceRaw } from "./token.js";

/// Instructions to move `amountRaw` of `mint` from `from` (owner) to `to` (owner): idempotent ATA create for
/// the destination + transferChecked, under the mint's real program. `transferHook` mints (xStocks) need the
/// async variant that resolves the hook's extra accounts.
export async function transferInstructions(ctx, { from, to, mint, amountRaw, decimals, programId, transferHook = false, payer = from, createDest = true }) {
  const mintPk = pk(mint), fromPk = pk(from), toPk = pk(to);
  programId = programId || (await mintProgramId(ctx, mint));
  const src = getAssociatedTokenAddressSync(mintPk, fromPk, true, programId);
  const dest = getAssociatedTokenAddressSync(mintPk, toPk, true, programId);
  const ixs = [];
  if (createDest) ixs.push(createAssociatedTokenAccountIdempotentInstruction(pk(payer), dest, toPk, mintPk, programId));
  ixs.push(transferHook
    ? await createTransferCheckedWithTransferHookInstruction(ctx.connection, src, mintPk, dest, fromPk, amountRaw, decimals, [], "confirmed", programId)
    : createTransferCheckedInstruction(src, mintPk, dest, fromPk, amountRaw, decimals, [], programId));
  return ixs;
}

/// Send EXACTLY `amountRaw` of `mint` from `wallet` to `to`.
export async function transferTokens(ctx, { wallet, mint, to, amountRaw, decimals = 6, programId, transferHook = false }) {
  if (amountRaw <= 0n) return { sig: "", amountRaw: 0n };
  const instructions = await transferInstructions(ctx, { from: wallet.publicKey, to, mint, amountRaw, decimals, programId, transferHook });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: transferHook ? 120_000 : 80_000 });
  return { sig, amountRaw };
}

/// Move the WHOLE ATA balance of `mint` from wallet → `to` (dev buy → user, ops share, recovery).
export async function transferAllTokens(ctx, { wallet, mint, to, decimals = 6, programId, transferHook = false }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const amountRaw = await tokenBalanceRaw(ctx, { owner: wallet.publicKey, mint, programId });
  if (amountRaw === 0n) return { sig: "", amountRaw: 0n };
  return transferTokens(ctx, { wallet, mint, to, amountRaw, decimals, programId, transferHook });
}

/// Several transfers of the same mint in ONE transaction (≤ ~10 with ATA creates, ≤ ~18 without).
export async function batchTransferTokens(ctx, { wallet, mint, recipients, decimals = 6, programId, transferHook = false, createDest = true }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const instructions = [];
  for (const r of recipients) instructions.push(...(await transferInstructions(ctx, { from: wallet.publicKey, to: r.wallet, mint, amountRaw: r.amountRaw, decimals, programId, transferHook, createDest })));
  const n = recipients.length;
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: (createDest ? 60_000 : 12_000) * n + 20_000 });
  return { sig, count: n, amountRaw: recipients.reduce((s, r) => s + r.amountRaw, 0n) };
}

/// Close the wallet's token account once it is empty — the ~0.002 SOL of rent comes home. Returns "" if not empty.
export async function closeEmptyAta(ctx, { wallet, mint, programId }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const ata = getAssociatedTokenAddressSync(pk(mint), wallet.publicKey, false, programId);
  const bal = await ctx.connection.getTokenAccountBalance(ata).catch(() => null);
  if (!bal || BigInt(bal.value.amount) !== 0n) return "";
  return sendTx(ctx, { instructions: [createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], programId)], payer: wallet.publicKey, signers: [wallet], computeUnits: 20_000 });
}

/// Which of these owners already have an ATA for `mint` — derived locally, read 100 at a time (no indexer).
export async function existingAtas(ctx, { mint, owners, programId }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const mintPk = pk(mint);
  return (await getMultipleAccounts(ctx, owners.map((o) => getAssociatedTokenAddressSync(mintPk, new PublicKey(o), true, programId)))).map((info) => info !== null);
}
