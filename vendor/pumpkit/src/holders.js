import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_DECIMALS, SYSTEM_PROGRAM, bondingCurvePda, canonicalPumpPoolPda, pk } from "./context.js";
import { getMultipleAccounts, withRetry } from "./tx.js";
import { mintProgramId } from "./token.js";
import { fetchTopHoldersList } from "./pumpfun/market.js";

/// Who holds a coin. Snapshots come from getProgramAccounts on the SNAPSHOT connection (public endpoints
/// 429 or refuse it — publicnode refuses it outright, api.mainnet-beta works with backoff, Helius is best).

/// The system accounts that must never be paid: the curve PDA, the canonical PumpSwap pool, plus whatever
/// the caller adds (engine wallet, main wallet, lockers...).
export function systemExclusions({ mint, pool, extra = [] }) {
  const mintPk = pk(mint);
  const set = new Set([bondingCurvePda(mintPk).toBase58(), canonicalPumpPoolPda(mintPk).toBase58(), ...extra.map(String)].filter(Boolean));
  if (pool) set.add(String(pool));
  return set;
}

/// Every wallet holding `mint`, largest first, balances summed across their token accounts. Raw units.
/// {holders: [{wallet, raw, account}], totalRaw, eligibleRaw, accounts, excluded}
///  - `account` is the holder's fullest EXISTING token account (so a payout in the same mint needs no ATA create)
///  - `minRaw` drops dust, `maxHolders` caps the list (largest first), `onlyWallets` drops program-owned owners
export async function snapshotHolders(ctx, { mint, exclude = [], pool, minRaw = 0n, maxHolders = Infinity, onlyWallets = true }) {
  const mintPk = pk(mint);
  const programId = await mintProgramId(ctx, mint);
  const filters = programId.equals(TOKEN_PROGRAM_ID) ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintPk.toBase58() } }] : [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }];
  // owner (32) + amount (8) — 40 bytes per account instead of the whole thing
  const accounts = await withRetry(() => ctx.snapshotConnection.getProgramAccounts(programId, { commitment: "confirmed", filters, dataSlice: { offset: 32, length: 40 } }), { tries: 4, baseMs: 4000 });
  const excluded = systemExclusions({ mint, pool, extra: exclude });
  const byOwner = new Map();
  for (const { pubkey, account } of accounts) {
    const d = account.data;
    if (d.length < 40) continue;
    const owner = new PublicKey(d.subarray(0, 32)).toBase58();
    const amount = d.readBigUInt64LE(32);
    if (amount === 0n || excluded.has(owner)) continue;
    const prev = byOwner.get(owner);
    if (!prev) byOwner.set(owner, { wallet: owner, raw: amount, account: pubkey.toBase58(), top: amount });
    else { prev.raw += amount; if (amount > prev.top) { prev.top = amount; prev.account = pubkey.toBase58(); } }
  }
  let holders = [...byOwner.values()].filter((h) => h.raw >= minRaw).map(({ wallet, raw, account }) => ({ wallet, raw, account }));
  holders.sort((a, b) => (a.raw < b.raw ? 1 : a.raw > b.raw ? -1 : a.wallet < b.wallet ? -1 : 1));
  if (onlyWallets) holders = await filterWallets(ctx, holders, (h) => h.wallet);
  const totalRaw = holders.reduce((s, h) => s + h.raw, 0n);
  if (holders.length > maxHolders) holders = holders.slice(0, maxHolders);
  const eligibleRaw = holders.reduce((s, h) => s + h.raw, 0n);
  return { holders, totalRaw, eligibleRaw, accounts: accounts.length, excluded: [...excluded], programId };
}

/// Keep only real wallets: system-owned, non-executable accounts — or nothing on chain yet (still a valid
/// owner). Drops the bonding curve, pools, lockers, vault PDAs. Reads 100 owners per call.
export async function filterWallets(ctx, items, key = (x) => x) {
  const infos = await getMultipleAccounts(ctx, items.map((it) => key(it)));
  return items.filter((it, i) => { const a = infos[i]; return !a || (a.owner.equals(SystemProgram.programId) && !a.executable); });
}

/// Top holders without getProgramAccounts: pump.fun's own list, then the RPC's 20 largest accounts.
/// Returns EXISTING token accounts, so a transfer to them never has to create anything.
export async function topHolders(ctx, { mint, exclude = [], limit = 20 }) {
  const mintPk = pk(mint);
  let rows;
  try {
    const list = await fetchTopHoldersList(mintPk.toBase58());
    if (!list.length) throw new Error("top-holders → empty");
    const programId = await mintProgramId(ctx, mint);
    rows = list.map((h) => ({ wallet: String(h.address), account: getAssociatedTokenAddressSync(mintPk, new PublicKey(h.address), true, programId).toBase58(), raw: BigInt(Math.floor(Number(h.amount) * 10 ** PUMP_DECIMALS)) })).filter((r) => r.raw > 0n);
    const accounts = await getMultipleAccounts(ctx, rows.map((r) => r.account));
    rows = rows.filter((_, i) => accounts[i]); // a holder keeping the coin in a non-ATA account is skipped
  } catch (err) {
    ctx.log.warn?.(`[holders] pump.fun list unavailable (${String(err.message).slice(0, 80)}) — asking the RPC`);
    // an "indexed request" on publicnode → the snapshot connection (api.mainnet-beta / Helius) answers it
    const largest = (await ctx.snapshotConnection.getTokenLargestAccounts(mintPk)).value.filter((a) => BigInt(a.amount) > 0n);
    if (!largest.length) return [];
    const parsed = await ctx.connection.getMultipleParsedAccounts(largest.map((a) => a.address));
    rows = largest.map((a, i) => ({ account: a.address.toBase58(), wallet: parsed.value[i]?.data?.parsed?.info?.owner || "", frozen: parsed.value[i]?.data?.parsed?.info?.state === "frozen", raw: BigInt(a.amount) })).filter((r) => r.wallet && !r.frozen);
  }
  const skip = systemExclusions({ mint, extra: exclude });
  rows = rows.filter((r) => !skip.has(r.wallet));
  const owners = await getMultipleAccounts(ctx, rows.map((r) => r.wallet));
  return rows.filter((_, i) => !owners[i] || owners[i].owner.toBase58() === SYSTEM_PROGRAM).slice(0, limit).map(({ wallet, account, raw }) => ({ wallet, account, raw }));
}

/// Pro-rata split of `amountRaw` across holders by their balance. Drops zero shares.
export function proRata(holders, amountRaw, eligibleRaw = holders.reduce((s, h) => s + h.raw, 0n)) {
  if (eligibleRaw <= 0n || amountRaw <= 0n) return [];
  return holders.map((h) => ({ ...h, amountRaw: (amountRaw * h.raw) / eligibleRaw, share: Number(h.raw) / Number(eligibleRaw) })).filter((h) => h.amountRaw > 0n);
}

/// Compare two snapshots: wallets whose balance did not drop (NDA-style "no dump" eligibility).
export function heldOrGrew(prev, next) {
  const before = new Map(prev.holders.map((h) => [h.wallet, h.raw]));
  return next.holders.filter((h) => before.has(h.wallet) && h.raw >= before.get(h.wallet));
}

export { AccountLayout };
