import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createTransferCheckedWithTransferHookInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS, chunk, pk } from "./context.js";
import { getMultipleAccounts, sendTx } from "./tx.js";
import { mintProgramId } from "./token.js";
import { proRata } from "./holders.js";

/// Airdrops. DB-free: the functions return per-wallet outcomes and the caller persists them. The ATA-rent
/// policy below is the one every tek of ours converged on (see feedback-avoid-airdrop-skips).

export const RENT_EXEMPT_LAMPORTS = 890_880; // a system account below this cannot be created by a transfer

/// Send `amountRaw` of `mint` to holders pro rata by their balance of (usually) another coin.
///
/// ATA policy — a holder without an account for `mint`:
///   • gets one opened by the payer when their drop is worth ≥ `ataRentThresholdSol` (value in SOL you pass via
///     `valueSol` for the whole drop) or when `skipStreaks[wallet] + 1 ≥ ataSkipGraceCycles`
///   • otherwise is skipped this round (status "skipped", reason) — the caller carries their share
///   • `rentPaidBefore` (wallets the payer already opened an account for, who closed it) are always skipped
/// Several batches in flight (`concurrency`), each its own tx. Transfer-hook mints halve the batch sizes.
/// Returns { paid, skipped, failed, droppedRaw, txs, outcomes: [{wallet, amountRaw, valueSol, share, status, tx?, error?, created?}] }
export async function airdropTokens(ctx, {
  wallet, mint, amountRaw, holders, eligibleRaw, decimals = 6, programId, transferHook = false, valueSol = 0,
  ataRentThresholdSol = 0.002, ataSkipGraceCycles = 10, skipStreaks = new Map(), rentPaidBefore = new Set(),
  transfersPerTx = 10, createsPerTx = 4, concurrency = 4, createAccounts = true, onProgress,
}) {
  const mintPk = pk(mint);
  programId = programId || (await mintProgramId(ctx, mint));
  const me = wallet.publicKey;
  const sourceAta = getAssociatedTokenAddressSync(mintPk, me, false, programId);

  // 1. shares
  const plan = proRata(holders, amountRaw, eligibleRaw).map((p) => ({ ...p, valueSol: valueSol * p.share }));
  if (!plan.length) return { paid: 0, skipped: 0, failed: 0, droppedRaw: 0n, txs: [], outcomes: [], planned: 0 };

  // 2. who already has an account for this mint
  const exists = (await getMultipleAccounts(ctx, plan.map((p) => getAssociatedTokenAddressSync(mintPk, new PublicKey(p.wallet), true, programId)))).map((i) => i !== null);
  const transfers = [], creates = [], skipped = [];
  plan.forEach((p, i) => {
    if (exists[i]) transfers.push(p);
    else if (!createAccounts) skipped.push({ ...p, status: "skipped", error: "no token account for this mint" });
    else if (rentPaidBefore.has(p.wallet)) skipped.push({ ...p, status: "skipped", error: "an account was opened for this wallet before and closed — open one yourself to receive again" });
    else if (p.valueSol >= ataRentThresholdSol || (skipStreaks.get(p.wallet) || 0) + 1 >= ataSkipGraceCycles) creates.push(p);
    else skipped.push({ ...p, status: "skipped", error: `drop worth ${p.valueSol.toFixed(5)} SOL is under the ${ataRentThresholdSol} SOL account-rent threshold — paid once it adds up, or after ${ataSkipGraceCycles} skipped rounds` });
  });

  // 3. send — a few batches at once; each is its own transaction, order does not matter
  const perTx = transferHook ? Math.max(2, Math.floor(transfersPerTx / 2)) : transfersPerTx;
  const perCreateTx = transferHook ? Math.max(1, Math.floor(createsPerTx / 2)) : createsPerTx;
  const queues = [...chunk(transfers, perTx).map((b) => ({ b, create: false })), ...chunk(creates, perCreateTx).map((b) => ({ b, create: true }))];
  const outcomes = [...skipped];
  let paid = 0, failed = 0, droppedRaw = 0n, qi = 0, done = 0;
  const txs = [];
  const runOne = async ({ b, create }, idx) => {
    try {
      const instructions = [];
      for (const p of b) {
        const owner = new PublicKey(p.wallet), dest = getAssociatedTokenAddressSync(mintPk, owner, true, programId);
        if (create) instructions.push(createAssociatedTokenAccountIdempotentInstruction(me, dest, owner, mintPk, programId));
        instructions.push(transferHook
          ? await createTransferCheckedWithTransferHookInstruction(ctx.connection, sourceAta, mintPk, dest, me, p.amountRaw, decimals, [], "confirmed", programId)
          : createTransferCheckedInstruction(sourceAta, mintPk, dest, me, p.amountRaw, decimals, [], programId));
      }
      const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: create ? 60_000 * b.length + 20_000 : 12_000 * b.length + 20_000 });
      txs.push(sig);
      for (const p of b) { outcomes.push({ ...p, status: "paid", tx: sig, created: create }); paid++; droppedRaw += p.amountRaw; }
    } catch (err) {
      const msg = String(err.message).slice(0, 300);
      ctx.log.error?.(`[airdrop] batch ${idx + 1}/${queues.length} failed: ${msg}`);
      for (const p of b) { outcomes.push({ ...p, status: "failed", error: msg }); failed++; }
    }
    done++;
    onProgress?.({ paid, failed, skipped: skipped.length, batches: queues.length, batch: done, txs: [...txs] });
  };
  const workers = Array.from({ length: Math.min(concurrency, queues.length) || 1 }, async () => { while (qi < queues.length) { const idx = qi++; await runOne(queues[idx], idx); } });
  await Promise.all(workers);
  return { paid, skipped: skipped.length, failed, droppedRaw, txs, outcomes, planned: plan.length };
}

/// Native SOL to many wallets, pro rata. No ATAs. Wallets that do not exist on chain and would receive less
/// than the rent-exempt minimum are skipped (the transfer would fail) — carry their share.
/// Returns { paid, skipped, failed, paidLamports, txs, outcomes }
export async function airdropSol(ctx, { wallet, lamports, holders, eligibleRaw, perTx = 18, minLamports = 1n, onProgress }) {
  const me = wallet.publicKey;
  const plan = proRata(holders, BigInt(lamports), eligibleRaw).filter((p) => p.amountRaw >= BigInt(minLamports));
  const outcomes = [], txs = [];
  let paid = 0, skipped = 0, failed = 0, paidLamports = 0n;
  const batches = chunk(plan, perTx);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    let infos;
    try { infos = await getMultipleAccounts(ctx, batch.map((t) => t.wallet)); }
    catch { infos = batch.map(() => ({})); } // assume they exist
    const valid = [];
    batch.forEach((t, i) => {
      if (infos[i] === null && t.amountRaw < BigInt(RENT_EXEMPT_LAMPORTS)) { outcomes.push({ ...t, status: "skipped", error: "wallet not initialized on chain and payout below the rent-exempt minimum" }); skipped++; }
      else valid.push(t);
    });
    if (!valid.length) continue;
    try {
      const instructions = valid.map((t) => SystemProgram.transfer({ fromPubkey: me, toPubkey: new PublicKey(t.wallet), lamports: Number(t.amountRaw) }));
      const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: 20_000 + valid.length * 6_000 });
      txs.push(sig);
      for (const t of valid) { outcomes.push({ ...t, status: "paid", tx: sig }); paid++; paidLamports += t.amountRaw; }
    } catch (err) {
      const msg = String(err.message).slice(0, 300);
      ctx.log.error?.(`[airdrop-sol] batch ${b + 1}/${batches.length} failed: ${msg}`);
      for (const t of valid) { outcomes.push({ ...t, status: "failed", error: msg }); failed++; }
    }
    onProgress?.({ paid, skipped, failed, batches: batches.length, batch: b + 1, txs: [...txs] });
  }
  return { paid, skipped, failed, paidLamports, paidSol: Number(paidLamports) / LAMPORTS, txs, outcomes, planned: plan.length };
}

/// Update skip streaks after a round: skipped grow, everyone paid resets. Pure helper for the caller's store.
export function nextSkipStreaks(prev, outcomes) {
  const next = new Map(prev);
  for (const o of outcomes) {
    if (o.status === "skipped") next.set(o.wallet, (next.get(o.wallet) || 0) + 1);
    else if (o.status === "paid") next.delete(o.wallet);
  }
  return next;
}
