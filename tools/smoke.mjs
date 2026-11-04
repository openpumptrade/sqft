// Dry-run smoke test: a throwaway key (never funded, never written anywhere), public reads from
// Solana and Parcl, one dry engine round, a local check of the owner-key signature, and the shape
// of the bridge deposit instruction. Nothing moves.
//
//   node tools/smoke.mjs
import { Keypair } from '@solana/web3.js';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';

const kp = Keypair.generate();
process.env.PRIVATE_KEY = bs58.encode(kp.secretKey);
process.env.ENGINE = '1'; process.env.ENGINE_DRY = '1';
process.env.ENGINE_DATA_FILE = join(mkdtempSync(join(tmpdir(), 'sqft-smoke-')), 'engine.json');
process.env.CREATOR_WALLET ??= '13D3ZJnhM4c53oHgbma7nDkYeuuiYW9YwtfHc6neEo6Y';   // any public creator with a vault, read only
const { LandEngine } = await import('../engine/engine.js');
const e = new LandEngine();
await e.ctxLoad();
console.log('wallet', e.state.wallet, '· owner hex', e.ownerHex());
await e.poll();
const v = e.view();
console.log('markets:', v.land.lots.map(l => `${l.label} $${l.price.toFixed(2)} (1d ${(l.change_1d * 100).toFixed(2)}%, 30d ${(l.change_30d * 100).toFixed(2)}%, ${l.spark.length} pts)`).join(' · '));
console.log('vault:', JSON.stringify(v.live.vault));
console.log('bridge:', JSON.stringify(v.live.bridge));
console.log('flow:', JSON.stringify(v.flow));
console.log('--- one dry round');
await e.round();
console.log('errors:', JSON.stringify(e.state.errors));
const p = e.parcl;
const tx = { CreateFundedAccount: { mode: 'Cross' } };
const nonce = p.nonce(), ts = Math.floor(Date.now() / 1000);
const msg = JSON.stringify([p.env.chain, tx, nonce, ts]);
const sig = p.signBytes(msg);
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(kp.publicKey.toBytes())]), format: 'der', type: 'spki' });
console.log('signature:', sig.length, 'bytes · verifies locally:', verify(null, Buffer.from(msg), pub, sig));
const ix = await p.depositInstruction({ owner: kp.publicKey, amountRaw: 5_000_000n });
console.log('deposit ix:', ix.programId.toBase58(), ix.keys.map(k => `${k.pubkey.toBase58().slice(0, 6)}${k.isSigner ? '*' : ''}${k.isWritable ? 'w' : ''}`).join(' '), Buffer.from(ix.data).toString('hex'));
process.exit(0);
