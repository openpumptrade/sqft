import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage } from "@solana/web3.js";

/// Browser-side (also fine in Node) verification of the launch transactions a server built — run it BEFORE the
/// wallet signs. Refuses anything that is not exactly: compute budget, at most ONE fee transfer of the
/// advertised amount to the advertised treasury, pump.fun create_v2 for the mint THIS browser generated with
/// YOU as creator and the metadata you typed, and (optionally) your own dev buy capped at what you typed.
/// Pure @solana/web3.js, no pump SDK — bundle it with the frontend.

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180];
const BUY = [102, 6, 61, 18, 1, 218, 235, 234];
const ALLOWED = new Set([ComputeBudgetProgram.programId.toBase58(), SystemProgram.programId.toBase58(), PUMP_PROGRAM, ATA_PROGRAM]);

const startsWith = (d, disc) => disc.every((b, i) => d[i] === b);
function readString(d, o) {
  const len = new DataView(d.buffer, d.byteOffset + o, 4).getUint32(0, true);
  return [new TextDecoder().decode(d.slice(o + 4, o + 4 + len)), o + 4 + len];
}

/// expect = { wallet, mint, treasury, feeLamports, name, symbol, devBuyLamports (bigint), slippagePct }
/// Returns [{label, ok}] — sign only when every check is ok.
export async function verifyLaunch(connection, txs, lookupTable, e) {
  let alts = [];
  if (lookupTable) {
    const r = await connection.getAddressLookupTable(new PublicKey(lookupTable));
    if (!r.value) throw new Error("lookup table not found");
    alts = [r.value];
  }
  const expectFee = Number(e.feeLamports || 0) > 0;
  let feeTransfers = 0, feeOk = !expectFee, createOk = false, creatorOk = false, metaOk = false, buyOk = e.devBuyLamports === 0n, programsOk = true, payerOk = true, signersOk = true, otherTransfers = 0;
  for (const [i, tx] of txs.entries()) {
    const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
    if (msg.payerKey.toBase58() !== e.wallet) payerOk = false;
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(String);
    const allowedSigners = i === 0 ? [e.wallet, e.mint] : [e.wallet];
    if (signers.some((s) => !allowedSigners.includes(s))) signersOk = false;
    for (const ix of msg.instructions) {
      const pid = ix.programId.toBase58();
      if (!ALLOWED.has(pid)) { programsOk = false; continue; }
      const d = ix.data;
      if (pid === SystemProgram.programId.toBase58()) {
        const type = new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true);
        if (type !== 2) { programsOk = false; continue; } // only plain transfers
        const lamports = Number(new DataView(d.buffer, d.byteOffset + 4, 8).getBigUint64(0, true));
        const to = ix.keys[1].pubkey.toBase58();
        if (expectFee && to === e.treasury) { feeTransfers++; feeOk = lamports === Number(e.feeLamports) && ix.keys[0].pubkey.toBase58() === e.wallet; }
        else otherTransfers++;
      }
      if (pid === PUMP_PROGRAM) {
        if (startsWith(d, CREATE_V2)) {
          createOk = ix.keys.some((k) => k.pubkey.toBase58() === e.mint && k.isSigner);
          let o = 8, name, symbol;
          [name, o] = readString(d, o);
          [symbol, o] = readString(d, o);
          [, o] = readString(d, o);
          const creator = new PublicKey(d.slice(o, o + 32)).toBase58();
          creatorOk = creator === e.wallet;
          metaOk = name === e.name && symbol === e.symbol;
        } else if (startsWith(d, BUY)) {
          const maxSol = new DataView(d.buffer, d.byteOffset + 16, 8).getBigUint64(0, true);
          const cap = (e.devBuyLamports * BigInt(10_000 + Math.round((e.slippagePct || 0) * 100))) / 10_000n;
          buyOk = maxSol <= cap && ix.keys.some((k) => k.pubkey.toBase58() === e.wallet && k.isSigner);
        } else programsOk = false; // no other pump instruction belongs in a launch
      }
    }
  }
  return [
    { label: "you pay the fees and sign", ok: payerOk && signersOk },
    { label: "only known programs", ok: programsOk && otherTransfers === 0 },
    ...(expectFee ? [{ label: `one fee of ${Number(e.feeLamports) / 1e9} SOL to the treasury`, ok: feeOk && feeTransfers === 1 }] : []),
    { label: "creates your mint", ok: createOk },
    { label: "you are the creator", ok: creatorOk },
    { label: "name and ticker match", ok: metaOk },
    { label: e.devBuyLamports > 0n ? "dev buy capped at your amount" : "no hidden buy", ok: buyOk },
  ];
}

export const allOk = (checks) => checks.every((c) => c.ok);
