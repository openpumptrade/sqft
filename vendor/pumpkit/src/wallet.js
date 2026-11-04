import crypto from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { LAMPORTS, pk } from "./context.js";
import { sendTx } from "./tx.js";

/// A Keypair from a bs58 secret (Phantom/Solflare export) or a JSON byte array.
export function keypairFromSecret(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("empty secret key");
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  return Keypair.fromSecretKey(bs58.decode(s));
}

export function newWallet() {
  const kp = Keypair.generate();
  return { keypair: kp, address: kp.publicKey.toBase58(), secret: bs58.encode(kp.secretKey) };
}

export async function getSolBalance(ctx, address) {
  return (await ctx.connection.getBalance(pk(address))) / LAMPORTS;
}

/// Plain SOL transfer. `lamports` as bigint or number.
export async function sendSol(ctx, { wallet, to, lamports }) {
  const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pk(to), lamports: Number(lamports) });
  return sendTx(ctx, { instructions: [ix], payer: wallet.publicKey, signers: [wallet], computeUnits: 10_000 });
}

/// Send everything but the tx fee — used to refund a deposit wallet to exactly 0.
export async function sweepSol(ctx, { wallet, to, keepLamports = 0 }) {
  const balance = await ctx.connection.getBalance(wallet.publicKey);
  const amount = balance - 6_000 - keepLamports; // 5000 base fee + priority; anything between 0 and rent-exempt is rejected
  if (amount <= 0) return { sig: "", lamports: 0 };
  const sig = await sendSol(ctx, { wallet, to, lamports: amount });
  return { sig, lamports: amount };
}

// ---------------------------------------------------------------- secrets at rest
/// AES-256-GCM for custodial wallet secrets. `masterKey` = 64 hex chars. Format: gcm:<iv>:<tag>:<data>.
/// Without a key the secret is stored as `plain:<secret>` — dev only, and the caller should warn loudly.
export function encryptSecret(plain, masterKey) {
  const k = keyOf(masterKey);
  if (!k) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `gcm:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(stored, masterKey) {
  if (stored.startsWith("plain:")) return stored.slice(6);
  const [tag, ivHex, authHex, dataHex] = stored.split(":");
  if (tag !== "gcm") throw new Error("unknown secret format");
  const k = keyOf(masterKey);
  if (!k) throw new Error("MASTER_KEY required to decrypt wallet secrets");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/// Validate at BOOT, not at the first launch: a malformed key makes every custodial wallet unrecoverable.
/// (A `grep MASTER_KEY .env` once picked up a comment line and shipped a broken key to production.)
export function assertMasterKey(masterKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(masterKey || ""))) throw new Error(`MASTER_KEY must be 32 bytes of hex (64 chars) — got ${String(masterKey || "").length} chars`);
}

function keyOf(masterKey) {
  if (!masterKey) return null;
  const k = Buffer.from(masterKey, "hex");
  if (k.length !== 32) throw new Error("MASTER_KEY must be 32 bytes of hex (64 chars)");
  return k;
}

export { PublicKey };
