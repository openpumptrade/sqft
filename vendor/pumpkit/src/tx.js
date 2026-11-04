import bs58 from "bs58";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { sleep } from "./context.js";

/// Build, sign, simulate and send a v0 transaction with priority fees. Resolves to the signature once
/// 'confirmed'. Throws when the simulation fails or the tx lands but errors (slippage, state moved) —
/// the caller must know, because its SOL/tokens did not move the way it planned.
export async function sendTx(ctx, { instructions, payer, signers, computeUnits = 300_000, skipSimulation = false, lookupTables = [] }) {
  const { connection } = ctx;
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ctx.priorityMicroLamports }),
    ...instructions,
  ];
  // a public RPC behind a load balancer can simulate on a node that has not seen the blockhash yet
  // ("BlockhashNotFound") — retry with a fresh one instead of failing the whole cycle
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(msg);
    tx.sign(signers);
    if (!skipSimulation) {
      const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
      if (sim.value.err) {
        const err = JSON.stringify(sim.value.err);
        if (/BlockhashNotFound/i.test(err) && attempt < 4) { await sleep(1500); continue; }
        const logs = (sim.value.logs || []).slice(-6).join("\n");
        throw new Error(`simulation failed: ${err}\n${logs}`);
      }
    }
    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
    let conf;
    try { conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed"); }
    catch (e) {
      // some public RPCs report "block height exceeded" for a tx that did land: check the signature before giving up
      for (let i = 0; i < 15; i++) {
        const st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (st?.confirmationStatus) { conf = { value: { err: st.err } }; break; }
        await sleep(2000);
      }
      if (!conf) throw e;
    }
    if (conf.value.err) {
      const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      const logs = (t?.meta?.logMessages || []).filter((l) => /Error|failed/i.test(l)).slice(-3).join(" | ");
      throw new Error(`tx ${sig} failed on chain: ${JSON.stringify(conf.value.err)} ${logs}`);
    }
    return sig;
  }
}

/// Free simulation of unsigned instructions from any funded payer — no keys needed. Great for
/// testing program limits (ticker length, account sizes) before spending anything.
export async function simulate(ctx, { instructions, payer, computeUnits = 400_000, lookupTables = [] }) {
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: "11111111111111111111111111111111", instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), ...instructions] }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  const sim = await ctx.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const logs = sim.value.logs || [];
  const reason = logs.find((l) => /Error Message/.test(l))?.replace(/.*Error Message: /, "") || (sim.value.err ? JSON.stringify(sim.value.err) : "");
  return { ok: !sim.value.err, error: reason, units: sim.value.unitsConsumed, logs, bytes: tx.serialize().length };
}

/// Compile unsigned v0 transactions for a USER's wallet to sign in the browser (trustless flows).
/// Returns the txs plus the blockhash data the client needs to know when they expire.
export async function compileUnsigned(ctx, { payer, instructionSets, computeUnits = 300_000, lookupTables = [] }) {
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash("confirmed");
  const budget = (units) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ctx.priorityMicroLamports })];
  const txs = instructionSets.map((ixs, i) => new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...budget(Array.isArray(computeUnits) ? computeUnits[i] : computeUnits), ...ixs] }).compileToV0Message(lookupTables)));
  for (const t of txs) if (t.serialize().length > 1232) throw new Error(`transaction too large (${t.serialize().length} bytes > 1232) — split it or use a lookup table`);
  return { txs, base64: txs.map((t) => Buffer.from(t.serialize()).toString("base64")), blockhash, lastValidBlockHeight };
}

/// Relay an already-signed transaction (someone else's) and rebroadcast until it lands or expires.
/// We cannot alter the bytes, only forward them — this is what makes a launch trustless.
export async function relaySigned(ctx, raw, lastValidBlockHeight) {
  const { connection } = ctx;
  const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : raw;
  const sig = bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]);
  await connection.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 0 });
  for (let i = 0; i < 60; i++) {
    const st = (await connection.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) return { sig, ok: false, error: JSON.stringify(st.err) };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { sig, ok: true };
    if (lastValidBlockHeight && i % 5 === 4) {
      const h = await connection.getBlockHeight("confirmed").catch(() => 0);
      if (h > lastValidBlockHeight) return { sig, ok: false, error: "blockhash expired before the transaction landed" };
    }
    if (i % 2 === 1) connection.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(1500);
  }
  return { sig, ok: false, pending: true, error: "not confirmed yet" };
}

/// Wait until a signature's transaction is readable (getTransaction lags a few seconds after confirm).
export async function fetchTransaction(ctx, signature, { tries = 10, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const tx = await ctx.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (tx) return tx;
    await sleep(waitMs);
  }
  return null;
}

/// How many lamports `address` gained (or lost) in a confirmed transaction — e.g. to prove a fee reached a treasury.
export function balanceDelta(tx, address) {
  const keys = [...tx.transaction.message.staticAccountKeys.map((k) => k.toBase58()), ...(tx.meta?.loadedAddresses?.writable || []).map(String), ...(tx.meta?.loadedAddresses?.readonly || []).map(String)];
  const i = keys.indexOf(String(address));
  return i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
}

/// getMultipleAccountsInfo for any number of keys. Public RPCs cap the batch (publicnode: 10 keys since
/// Oct 2026 — "403 Request blocked" above that); on that error the batch halves down to 10 and the size is
/// remembered on ctx for the rest of the process. Returns infos aligned with `keys`.
export async function getMultipleAccounts(ctx, keys, { connection = ctx.connection } = {}) {
  const out = new Array(keys.length);
  let size = ctx.accountsBatch || 100;
  for (let i = 0; i < keys.length;) {
    const part = keys.slice(i, i + size);
    try {
      const infos = await connection.getMultipleAccountsInfo(part.map((k) => new PublicKey(k)));
      infos.forEach((info, j) => { out[i + j] = info; });
      i += part.length;
    } catch (err) {
      if (/Request blocked|403|too many|batch/i.test(String(err.message)) && size > 10) { size = Math.max(10, Math.floor(size / 2)); ctx.accountsBatch = size; continue; }
      throw err;
    }
  }
  return out;
}

/// Retry an async step on transient RPC errors (429, timeouts, socket resets) with linear backoff.
export async function withRetry(fn, { tries = 4, baseMs = 2000, isTransient = (e) => /429|Too Many|rate|timeout|fetch failed|ECONN|socket hang|BlockhashNotFound/i.test(String(e?.message)) } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(i); } catch (e) { last = e; if (!isTransient(e) || i === tries) throw e; await sleep(baseMs * i); }
  }
  throw last;
}
