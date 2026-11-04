import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { pk } from "./context.js";
import { sendTx } from "./tx.js";
import { mintProgramId, tokenBalanceRaw } from "./token.js";

/// Burn EXACTLY `amountRaw`. Total supply goes down, forever.
///
/// There is deliberately no `burnAll` here. The engine wallet is usually the coin's creator wallet, and the
/// user makes their dev buy from it — a "burn everything the wallet holds" once burned a 5% dev bag
/// (~1 ETH) on round #1. Burn only what the engine bought: see `burnDelta` and the `burnOwed` pattern.
export async function burnTokens(ctx, { wallet, mint, amountRaw, decimals = 6, programId }) {
  if (amountRaw <= 0n) return { sig: "", amountRaw: 0n };
  programId = programId || (await mintProgramId(ctx, mint));
  const mintPk = pk(mint);
  const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, programId);
  const instructions = [createBurnCheckedInstruction(ata, mintPk, wallet.publicKey, amountRaw, decimals, [], programId)];
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 80_000 });
  return { sig, amountRaw };
}

/// Burn what a buy brought in: `balanceAfter − balanceBefore`, capped at what the wallet holds now. Pass the
/// balance you read BEFORE the buy; anything the wallet already had stays untouched.
export async function burnDelta(ctx, { wallet, mint, balanceBeforeRaw, extraOwedRaw = 0n, decimals = 6, programId }) {
  programId = programId || (await mintProgramId(ctx, mint));
  const held = await tokenBalanceRaw(ctx, { owner: wallet.publicKey, mint, programId });
  const delta = held > balanceBeforeRaw ? held - balanceBeforeRaw : 0n;
  const owed = delta + extraOwedRaw;
  const amountRaw = owed < held ? owed : held;
  if (amountRaw <= 0n) return { sig: "", amountRaw: 0n, delta, held };
  const r = await burnTokens(ctx, { wallet, mint, amountRaw, decimals, programId });
  return { ...r, delta, held };
}
