import { LAMPORTS, lamportsOf, sleep } from "./context.js";
import { getSolBalance } from "./wallet.js";
import { mintProgramId, tokenBalanceRaw } from "./token.js";
import { buyMeasured } from "./swap.js";
import { burnTokens } from "./burn.js";
import { claimCreatorFees, distributeSharedFees, readSharingConfig, sharedFeesWaiting } from "./pumpfun/fees.js";
import { snapshotHolders } from "./holders.js";
import { airdropSol, airdropTokens } from "./airdrop.js";

/// The engine pieces every tek reuses: a global clock, a Postgres advisory lock (Railway runs the old and the
/// new container side by side during a redeploy), and the two canonical rounds — buyback&burn and
/// claim→buy→airdrop — written against the primitives above with crash-safe bookkeeping hooks.

// ---------------------------------------------------------------- clock
/// Fixed cadence anchored at `genesis`: ticks at genesis + k·intervalSec regardless of restarts. `run(cycle)`
/// is never re-entered; `onSchedule(nextAt)` lets the caller persist/expose the next tick.
export function createScheduler({ intervalSec, genesis, run, enabled = () => true, onSchedule, log = console }) {
  const state = { genesis: genesis || Math.floor(Date.now() / 1000), cycle: 0, nextAt: 0, firing: false, lastAt: 0, timer: null };
  const now = () => Math.floor(Date.now() / 1000);
  const schedule = () => { const k = Math.floor((now() - state.genesis) / intervalSec) + 1; state.nextAt = state.genesis + k * intervalSec; onSchedule?.(state.nextAt); };
  const tick = async () => {
    if (state.firing || now() < state.nextAt) return;
    if (!enabled()) { schedule(); return; }
    state.firing = true;
    const cycle = ++state.cycle;
    try { await run(cycle); }
    catch (err) { log.error?.(`[scheduler] cycle #${cycle} failed: ${String(err.message).slice(0, 200)}`); }
    finally { state.lastAt = now(); schedule(); state.firing = false; }
  };
  return {
    state,
    start(cycle = 0) { state.cycle = cycle; schedule(); state.timer = setInterval(tick, 2_000); return state.nextAt; },
    stop() { clearInterval(state.timer); },
    /// true while a run is in flight — deploy only when idle and far from nextAt
    busy: () => state.firing,
  };
}

/// pg_try_advisory_lock on a RESERVED connection with keep-alive — postgres.js' idle_timeout would otherwise
/// close the connection and silently release the lock. `sql` is a postgres.js instance. Returns {ok, release}.
export async function advisoryLock(sql, key, { keepAliveMs = 30_000 } = {}) {
  const reserved = await sql.reserve();
  const [{ locked }] = await reserved`select pg_try_advisory_lock(${key}) as locked`;
  if (!locked) { reserved.release(); return { ok: false, release: async () => {} }; }
  const ka = setInterval(() => reserved`select 1`.catch(() => {}), keepAliveMs);
  return { ok: true, release: async () => { clearInterval(ka); await reserved`select pg_advisory_unlock(${key})`.catch(() => {}); reserved.release(); } };
}

// ---------------------------------------------------------------- rounds
/// Fees in: the on-chain fee-sharing distribution when the coin has a sharing config, a plain creator claim
/// otherwise. Returns what landed in `wallet` (SOL) and the tx.
export async function collectFees(ctx, { wallet, mint, minSol = 0.01 }) {
  const me = wallet.publicKey;
  const cfg = mint ? await readSharingConfig(ctx, mint).catch(() => null) : null;
  if (cfg) {
    const waiting = await sharedFeesWaiting(ctx, mint).catch(() => 0);
    if (waiting < minSol) return { sig: "", claimedSol: 0, waitingSol: waiting, mode: "sharing" };
    const r = await distributeSharedFees(ctx, { mint, wallet });
    return { sig: r.sig, claimedSol: r.gainedSol, waitingSol: waiting, mode: "sharing" };
  }
  const r = await claimCreatorFees(ctx, { wallet, minLamports: lamportsOf(minSol) });
  return { sig: r.sig, claimedSol: Number(r.claimedRaw) / LAMPORTS, waitingSol: Number(r.claimable.total) / LAMPORTS, mode: "creator" };
}

/// BLAST-style round: claim → ONE buy of `mint` with the pot → burn EXACTLY what the buy brought in (plus any
/// `burnOwedRaw` left from an earlier round whose burn failed). The wallet's own bag is never touched.
/// `ledger` hooks let the caller persist progress between steps so a crash mid-round is recoverable:
///   ledger.afterClaim({claimedSol, sig}), ledger.afterBuy({spentLamports, boughtRaw, sig}), ledger.afterBurn({burnedRaw, sig})
export async function buybackBurnRound(ctx, { wallet, mint, gasReserveSol = 0.03, minRoundSol = 0.05, burnOwedRaw = 0n, carrySol = 0, pool, ledger = {}, claim = true, dryRun = false }) {
  const me = wallet.publicKey.toBase58();
  const programId = await mintProgramId(ctx, mint);
  const out = { claimedSol: 0, potSol: 0, spentSol: 0, boughtRaw: 0n, burnedRaw: 0n, venue: "", txs: {}, dry: dryRun, note: "" };

  if (claim && !dryRun) {
    const c = await collectFees(ctx, { wallet, mint });
    out.claimedSol = c.claimedSol; if (c.sig) out.txs.claim = c.sig;
    await ledger.afterClaim?.({ claimedSol: c.claimedSol, sig: c.sig });
  }
  const walletSol = await getSolBalance(ctx, me);
  // the pot is what was credited (carry + this claim), never more than the wallet holds above gas
  out.potSol = Math.min(carrySol + out.claimedSol, Math.max(0, walletSol - gasReserveSol));
  if (dryRun) { out.note = `would buy with ${out.potSol.toFixed(4)} SOL and burn the delta (dry)`; return out; }

  let owed = burnOwedRaw;
  if (out.potSol >= minRoundSol) {
    const b = await buyMeasured(ctx, { wallet, mint, lamports: lamportsOf(out.potSol), programId, pool });
    out.spentSol = b.spentLamports / LAMPORTS; out.boughtRaw = b.boughtRaw; out.venue = b.venue; out.txs.buy = b.sig;
    owed += b.boughtRaw;
    await ledger.afterBuy?.({ spentLamports: b.spentLamports, boughtRaw: b.boughtRaw, sig: b.sig, venue: b.venue });
  } else if (owed <= 0n) { out.note = `${out.potSol.toFixed(4)} SOL under the ${minRoundSol} SOL minimum — waits`; return out; }

  const held = await tokenBalanceRaw(ctx, { owner: me, mint, programId });
  const burnRaw = owed < held ? owed : held;
  if (burnRaw > 0n) {
    const r = await burnTokens(ctx, { wallet, mint, amountRaw: burnRaw, programId });
    out.burnedRaw = burnRaw; out.txs.burn = r.sig;
    await ledger.afterBurn?.({ burnedRaw: burnRaw, sig: r.sig });
  }
  out.burnOwedRaw = owed - out.burnedRaw;
  out.note = `fees ${out.claimedSol.toFixed(4)} SOL · bought with ${out.spentSol.toFixed(4)} SOL on ${out.venue || "-"} · burned ${(Number(out.burnedRaw) / 1e6).toLocaleString()}`;
  return out;
}

/// TUNGBANK-style round: claim → buy `rewardMint` with the pot → airdrop what came in to the holders of
/// `holdersOf` (default: the coin itself), pro rata. `rewardMint` = WSOL_MINT pays SOL directly (no buy).
export async function claimBuyAirdropRound(ctx, { wallet, mint, rewardMint, holdersOf = mint, rewardDecimals = 6, gasReserveSol = 0.03, minRoundSol = 0.05, exclude = [], snapshotOpts = {}, airdropOpts = {}, ledger = {}, claim = true, dryRun = false }) {
  const me = wallet.publicKey.toBase58();
  const out = { claimedSol: 0, potSol: 0, spentSol: 0, boughtRaw: 0n, holders: 0, paid: 0, skipped: 0, failed: 0, txs: {}, dry: dryRun, note: "" };
  if (claim && !dryRun) {
    const c = await collectFees(ctx, { wallet, mint });
    out.claimedSol = c.claimedSol; if (c.sig) out.txs.claim = c.sig;
    await ledger.afterClaim?.({ claimedSol: c.claimedSol, sig: c.sig });
  }
  const walletSol = await getSolBalance(ctx, me);
  out.potSol = Math.max(0, walletSol - gasReserveSol);
  if (out.potSol < minRoundSol) { out.note = `${out.potSol.toFixed(4)} SOL under the ${minRoundSol} SOL minimum — waits`; return out; }
  if (dryRun) { out.note = `would spend ${out.potSol.toFixed(4)} SOL and airdrop (dry)`; return out; }

  const snap = await snapshotHolders(ctx, { mint: holdersOf, exclude: [me, ...exclude], ...snapshotOpts });
  out.holders = snap.holders.length;
  if (!out.holders || snap.eligibleRaw <= 0n) { out.note = "no eligible holders"; return out; }
  await ledger.afterSnapshot?.(snap);

  const isSol = !rewardMint || rewardMint === "So11111111111111111111111111111111111111112";
  if (isSol) {
    const d = await airdropSol(ctx, { wallet, lamports: lamportsOf(out.potSol), holders: snap.holders, eligibleRaw: snap.eligibleRaw, ...airdropOpts });
    Object.assign(out, { paid: d.paid, skipped: d.skipped, failed: d.failed, spentSol: d.paidSol }); out.txs.drops = d.txs;
    await ledger.afterAirdrop?.(d);
    out.note = `paid ${d.paidSol.toFixed(4)} SOL to ${d.paid} holders`;
    return out;
  }
  const b = await buyMeasured(ctx, { wallet, mint: rewardMint, lamports: lamportsOf(out.potSol) });
  out.spentSol = b.spentLamports / LAMPORTS; out.boughtRaw = b.boughtRaw; out.txs.buy = b.sig;
  await ledger.afterBuy?.({ spentLamports: b.spentLamports, boughtRaw: b.boughtRaw, sig: b.sig, venue: b.venue });
  if (b.boughtRaw <= 0n) { out.note = "buy brought nothing in"; return out; }
  await sleep(500);
  const d = await airdropTokens(ctx, { wallet, mint: rewardMint, amountRaw: b.boughtRaw, holders: snap.holders, eligibleRaw: snap.eligibleRaw, decimals: rewardDecimals, valueSol: out.spentSol, ...airdropOpts });
  Object.assign(out, { paid: d.paid, skipped: d.skipped, failed: d.failed }); out.txs.drops = d.txs;
  await ledger.afterAirdrop?.(d);
  out.note = `bought with ${out.spentSol.toFixed(4)} SOL on ${b.venue} · airdropped to ${d.paid} holders (${d.skipped} skipped, ${d.failed} failed)`;
  return out;
}
