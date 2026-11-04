import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_SIZE, AccountLayout, AccountState, ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAccountLenForMint, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes, getTokenMetadata, unpackMint,
} from "@solana/spl-token";
import { pk, sleep } from "./context.js";

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// pump.fun mints are Token-2022 nowadays, older ones classic SPL — NEVER assume: read the mint's owner
/// program. `getAssociatedTokenAddressSync` defaults to the classic program, so a wrong guess reads an
/// empty ATA ("buy confirmed but no tokens received") and transfers fail. Cached per mint.
export async function mintProgramId(ctx, mint) {
  const key = String(mint);
  const cache = ctx.caches.mintProgram;
  if (cache.has(key)) return cache.get(key);
  const info = await ctx.connection.getAccountInfo(pk(mint));
  if (!info) throw new Error(`mint ${key} not found on chain`);
  const pid = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null;
  if (!pid) throw new Error(`${key} is not an SPL token mint`);
  cache.set(key, pid);
  return pid;
}

/// The ATA of `owner` for `mint` under the right program (allowOwnerOffCurve so PDAs work as owners).
export async function ataOf(ctx, { mint, owner, programId }) {
  return getAssociatedTokenAddressSync(pk(mint), pk(owner), true, programId || (await mintProgramId(ctx, mint)));
}

export async function tokenBalanceRaw(ctx, { owner, mint, programId }) {
  const ata = await ataOf(ctx, { mint, owner, programId });
  try { return BigInt((await ctx.connection.getTokenAccountBalance(ata)).value.amount); } catch {}
  // some public RPCs refuse getTokenAccountBalance: read the raw token account instead (amount = u64 LE at byte 64)
  try {
    const info = await ctx.connection.getAccountInfo(ata);
    if (!info || info.data.length < 72) return 0n;
    return info.data.readBigUInt64LE(64);
  } catch { return 0n; }
}

/// Right after a buy the RPC can still return the OLD balance — poll until it moves past `above`.
export async function tokenBalanceSettled(ctx, { owner, mint, programId, above = 0n, tries = 6, waitMs = 1500 }) {
  let v = 0n;
  for (let i = 0; i < tries; i++) {
    v = await tokenBalanceRaw(ctx, { owner, mint, programId });
    if (v > above) return v;
    await sleep(waitMs);
  }
  return v;
}

/// EVERY token account the owner has for this mint, fullest first. DEX routers and some wallets deposit
/// into auxiliary accounts rather than the ATA, so reading only the ATA can report 0 on a wallet holding millions.
export async function tokenAccounts(ctx, { owner, mint }) {
  const res = await ctx.connection.getTokenAccountsByOwner(pk(owner), { mint: pk(mint) }, "confirmed");
  return res.value.map((v) => ({ address: v.pubkey.toBase58(), amountRaw: AccountLayout.decode(v.account.data).amount })).sort((a, b) => (a.amountRaw > b.amountRaw ? -1 : a.amountRaw < b.amountRaw ? 1 : 0));
}

/// Supply read from the mint account itself — getTokenSupply is an "indexed request" that publicnode refuses.
export async function totalSupply(ctx, mint) {
  const mintPk = pk(mint);
  const info = await ctx.connection.getAccountInfo(mintPk);
  if (!info) throw new Error(`mint ${mintPk.toBase58()} not found on chain`);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = unpackMint(mintPk, info, programId);
  return { raw: m.supply, ui: Number(m.supply) / 10 ** m.decimals, decimals: m.decimals };
}

/// Name/symbol/uri: Token-2022 TokenMetadata extension first (pump.fun's newer mints), Metaplex PDA second.
export async function readMetadata(ctx, mint, programId) {
  const mintPk = pk(mint);
  programId = programId || (await mintProgramId(ctx, mint));
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const m = await getTokenMetadata(ctx.connection, mintPk, "confirmed", programId);
      if (m?.symbol || m?.name) return { name: m.name, symbol: m.symbol, uri: m.uri, source: "token2022" };
    } catch { /* fall through */ }
  }
  try {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()], METADATA_PROGRAM);
    const acc = await ctx.connection.getAccountInfo(pda);
    if (!acc) return null;
    let o = 1 + 32 + 32; // key, update authority, mint — then three u32-prefixed strings
    const str = () => { const len = acc.data.readUInt32LE(o); o += 4; const v = acc.data.subarray(o, o + len).toString("utf8").replace(/\0+$/, "").trim(); o += len; return v; };
    const name = str(), symbol = str(), uri = str();
    return { name, symbol, uri, source: "metaplex" };
  } catch { return null; }
}

/// One call for everything a tool needs to know about a mint: program, decimals, supply, metadata, the
/// Token-2022 extensions that matter for moving it around, and the rent one recipient ATA costs.
export async function mintInfo(ctx, mint) {
  const mintPk = pk(mint);
  const info = await ctx.connection.getAccountInfo(mintPk);
  if (!info) throw new Error(`mint ${mintPk.toBase58()} not found on chain`);
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : info.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null;
  if (!programId) throw new Error("not an SPL token mint");
  ctx.caches.mintProgram.set(mintPk.toBase58(), programId);
  const m = unpackMint(mintPk, info, programId);
  const out = {
    mint: mintPk.toBase58(), programId, is2022: programId.equals(TOKEN_2022_PROGRAM_ID), decimals: m.decimals, supplyRaw: m.supply,
    mintAuthority: m.mintAuthority?.toBase58() || null, freezeAuthority: m.freezeAuthority?.toBase58() || null,
    transferFee: false, transferHook: false, nonTransferable: false, permanentDelegate: false, defaultFrozen: false, extensions: [],
  };
  if (out.is2022) {
    const ext = getExtensionTypes(m.tlvData);
    out.extensions = ext.map((e) => ExtensionType[e] || String(e));
    out.transferFee = ext.includes(ExtensionType.TransferFeeConfig);        // every transfer shrinks — airdrops bleed
    out.transferHook = ext.includes(ExtensionType.TransferHook);            // xStocks & co. — transfers need the hook's extra accounts
    out.nonTransferable = ext.includes(ExtensionType.NonTransferable);
    out.permanentDelegate = ext.includes(ExtensionType.PermanentDelegate);  // issuer keeps a claw-back key (regulated assets)
    out.defaultFrozen = ext.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(m)?.state === AccountState.Frozen;
  }
  const ataSize = out.is2022 ? getAccountLenForMint(m) : ACCOUNT_SIZE;
  const [rentPerAta, meta] = await Promise.all([ctx.connection.getMinimumBalanceForRentExemption(ataSize), readMetadata(ctx, mintPk, programId)]);
  return { ...out, rentPerAta, name: meta?.name || null, symbol: meta?.symbol || null, uri: meta?.uri || null };
}

/// Can this mint be bought and sent to thousands of wallets without surprises? The checks every basket /
/// reward-token flow needs before accepting an asset. Returns {ok, reason, info}.
export async function auditMint(ctx, mint) {
  try {
    const info = await mintInfo(ctx, mint);
    if (info.transferFee) return { ok: false, reason: "has a transfer fee — every airdrop would shrink", info };
    if (info.nonTransferable) return { ok: false, reason: "non-transferable", info };
    if (info.defaultFrozen) return { ok: false, reason: "new accounts are frozen by default — holders could not receive it", info };
    return { ok: true, reason: "", info, warnings: [info.transferHook && "transfer hook (transfers carry extra accounts)", info.permanentDelegate && "permanent delegate (issuer can claw back)", info.freezeAuthority && "freeze authority set"].filter(Boolean) };
  } catch (err) { return { ok: false, reason: String(err.message).slice(0, 200), info: null }; }
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync };
