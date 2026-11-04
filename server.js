// SQFT pool server: tickets, stake verification, rounds, payouts, stats,
// the live SSE stream and static hosting of ./public. No framework.
//
// Runs in test mode out of the box (a fixed pot per round, payouts logged but no
// SOL moves). Set TREASURY_SECRET to pay out for real from that wallet.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { LandEngine } from './engine/engine.js';

const env = (k, d) => (process.env[k] ?? d);
const SOL = 1e9;
const CFG = {
  port: Number(env('PORT', 8787)),
  round_ms: Number(env('ROUND_MS', 180_000)),
  reward_per_round: Math.round(Number(env('REWARD_SOL', 0.05)) * SOL),
  payout_threshold: Math.round(Number(env('PAYOUT_THRESHOLD_SOL', 0.01)) * SOL),
  min_difficulty: Number(env('MIN_DIFFICULTY', 16)),
  max_difficulty: 56,
  token_mint: env('TOKEN_MINT', '') || null,
  ticket_ms: 120_000,
  seconds_per_proof: 4,
  data_file: env('DATA_FILE', new URL('./data/state.json', import.meta.url).pathname),
  rpc: env('RPC_URL', 'https://solana-rpc.publicnode.com'),
  cluster: env('CLUSTER', 'mainnet-beta'),
  secret: env('TREASURY_SECRET', ''),
  static_cache: Number(env('STATIC_CACHE', 300)),
};
const SIMULATED = !CFG.secret;
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAGES = ['/', '/survey', '/stats', '/leaderboard', '/rounds', '/ledger', '/benchmark', '/land', '/rules'];
const engine = new LandEngine();

// ---------- state ----------
let S = {
  round: null,                 // { id, started_at, closes_at, work: {wallet: hashes}, proofs }
  wallets: {},                 // wallet -> { work, balance, pending, paid, diff }
  rounds: [],                  // settled rounds, newest last: { id, started_at, closed_at, reward, miners, work, proofs, shares[], payouts[] }
  payouts: [],                 // newest first: { at, wallet, round, lamports, status, signature }
  samples: [],                 // { at, hashrate, miners } every minute
  bench: [],                   // { device, gpu, threads, cpu, gpu_rate, at }
  nextRound: 1,
};
const challenges = new Map();  // id -> { wallet, seed, difficulty, expires_at, round }
const seenNonce = new Set();   // `${challenge_id}:${nonce}`
const recent = [];             // proofs in the last minute: { at, wallet, credit }
const rate = new Map();        // key -> timestamps, for rate limits
let treasury = null;           // { keypair, address, balance, connection }

function load() {
  try {
    if (existsSync(CFG.data_file)) {
      const d = JSON.parse(readFileSync(CFG.data_file, 'utf8'));
      S = { ...S, ...d, round: null };
      for (const a of Object.values(S.wallets)) a.diff = CFG.min_difficulty;
      log(`loaded ${S.rounds.length} rounds, ${Object.keys(S.wallets).length} wallets`);
    }
  } catch (e) { log(`could not load state: ${e.message}`); }
}
function save() {
  try {
    mkdirSync(join(CFG.data_file, '..'), { recursive: true });
    writeFileSync(CFG.data_file, JSON.stringify({ ...S, round: undefined }));
  } catch (e) { log(`could not save: ${e.message}`); }
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const wallet = w => (S.wallets[w] ??= { work: 0, balance: 0, pending: 0, paid: 0, diff: CFG.min_difficulty });

// ---------- rounds ----------
function openRound() {
  const now = Date.now();
  S.round = { id: S.nextRound++, started_at: now, closes_at: now + CFG.round_ms, work: {}, proofs: 0 };
  log(`round #${S.round.id} open`);
}

async function settle() {
  const r = S.round;
  const now = Date.now();
  const total = Object.values(r.work).reduce((a, b) => a + b, 0);
  const reward = total > 0 ? await potForRound() : 0;
  const shares = Object.entries(r.work).sort((a, b) => b[1] - a[1]).map(([w, work]) => {
    const share = work / total;
    const lamports = Math.floor(share * reward);
    wallet(w).balance += lamports;
    wallet(w).work += work;
    return { wallet: w, work, share, lamports };
  });
  const settled = { id: r.id, started_at: r.started_at, closed_at: now, reward, miners: shares.length, work: total, proofs: r.proofs, shares, payouts: [] };
  S.rounds.push(settled);
  if (S.rounds.length > 5000) S.rounds.shift();
  log(`round #${r.id} settled · ${shares.length} miners · ${reward / SOL} SOL`);
  openRound();
  broadcast('settled', { round: settled.id, reward });
  await payOut(settled);
  save();
}

// Simulated: the configured pot. Real: the same pot, capped by what the wallet holds minus a fee reserve.
async function potForRound() {
  if (SIMULATED) return CFG.reward_per_round;
  try {
    treasury.balance = await treasury.connection.getBalance(treasury.keypair.publicKey);
  } catch {}
  const spendable = Math.max(0, treasury.balance - 0.01 * SOL);
  return Math.min(CFG.reward_per_round, spendable);
}

async function payOut(round) {
  for (const [w, acct] of Object.entries(S.wallets)) {
    if (acct.balance < CFG.payout_threshold) continue;
    const lamports = acct.balance;
    acct.balance = 0;
    const p = { at: Date.now(), wallet: w, round: round.id, lamports, status: SIMULATED ? 'sim' : 'queued', signature: null };
    S.payouts.unshift(p);
    round.payouts.push(p);
    if (SIMULATED) {
      p.signature = 'sim' + randomBytes(28).toString('hex');
      acct.paid += lamports;
      broadcast('payout', { wallet: w, lamports });
      continue;
    }
    acct.pending += lamports;
    p.status = 'submitted';
    try {
      p.signature = await sendSol(w, lamports);
      p.status = 'sent';
      acct.pending -= lamports;
      acct.paid += lamports;
      broadcast('payout', { wallet: w, lamports });
      log(`paid ${lamports / SOL} SOL to ${w} · ${p.signature}`);
    } catch (e) {
      log(`payout to ${w} failed: ${e.message}`);
      acct.pending -= lamports;
      acct.balance += lamports;           // back to balance; tried again next round
      p.status = 'queued';
    }
  }
  S.payouts.length = Math.min(S.payouts.length, 2000);
}

async function initTreasury() {
  if (SIMULATED) { log('browser pool in test mode: payouts booked, no SOL moves'); return; }
  const { Connection, Keypair } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const raw = CFG.secret.trim();
  const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  const keypair = Keypair.fromSecretKey(bytes);
  const connection = new Connection(CFG.rpc, 'confirmed');
  treasury = { keypair, connection, address: keypair.publicKey.toBase58(), balance: 0 };
  try { treasury.balance = await connection.getBalance(keypair.publicKey); } catch {}
  log(`treasury ${treasury.address} · ${treasury.balance / SOL} SOL`);
}

async function sendSol(to, lamports) {
  const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasury.keypair.publicKey, toPubkey: new PublicKey(to), lamports }));
  return sendAndConfirmTransaction(treasury.connection, tx, [treasury.keypair], { commitment: 'confirmed' });
}

// ---------- proof of work ----------
const sha256 = buf => createHash('sha256').update(buf).digest();
function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}
// Difficulty that gives about one proof every `seconds_per_proof` seconds at this hashrate.
const diffFor = hps => Math.max(CFG.min_difficulty, Math.min(CFG.max_difficulty, Math.round(Math.log2(Math.max(1, hps) * CFG.seconds_per_proof))));

function limited(key, perSec) {
  const now = Date.now();
  const list = (rate.get(key) ?? []).filter(t => t > now - 1000);
  rate.set(key, list);
  if (list.length >= perSec) return true;   // refused requests do not count, so a burst cannot lock a wallet out
  list.push(now);
  return false;
}

function challenge(body) {
  const w = String(body.wallet ?? '');
  if (!WALLET.test(w)) return [400, { error: 'bad_wallet' }];
  if (limited(`c:${w}`, 3)) return [429, { error: 'rate_limited' }, { 'retry-after': '1' }];
  const acct = wallet(w);
  // difficulty from the hashrate the client reports, or from what it actually proved lately
  const now = Date.now();
  const observed = recent.filter(p => p.wallet === w && p.at > now - 10_000).reduce((a, p) => a + p.credit, 0) / 10;
  acct.diff = diffFor(Math.max(Number(body.hashrate) || 0, observed));
  const id = randomBytes(12).toString('hex');
  const t = { wallet: w, seed: randomBytes(32).toString('hex'), difficulty: acct.diff, expires_at: Date.now() + CFG.ticket_ms, round: S.round.id };
  challenges.set(id, t);
  return [200, { challenge_id: id, seed: t.seed, difficulty: t.difficulty, expires_at: new Date(t.expires_at).toISOString(), round: t.round }];
}

function proof(body) {
  const id = String(body.challenge_id ?? ''), w = String(body.wallet ?? ''), nonce = String(body.nonce ?? '').toLowerCase();
  const t = challenges.get(id);
  if (!t) return [404, { error: 'unknown_challenge' }];
  if (t.wallet !== w) return [403, { error: 'wrong_wallet' }];
  if (Date.now() > t.expires_at) { challenges.delete(id); return [410, { error: 'expired' }]; }
  if (!/^[0-9a-f]{16}$/.test(nonce)) return [400, { error: 'bad_nonce' }];
  if (limited(`p:${w}`, 6)) return [429, { error: 'rate_limited' }, { 'retry-after': '1' }];
  const key = `${id}:${nonce}`;
  if (seenNonce.has(key)) return [409, { error: 'duplicate' }];
  const digest = sha256(Buffer.concat([Buffer.from(t.seed, 'hex'), Buffer.from(nonce, 'hex')]));
  if (leadingZeroBits(digest) < t.difficulty) return [422, { error: 'weak_proof' }];
  seenNonce.add(key);
  if (seenNonce.size > 200_000) seenNonce.clear();

  const credit = 2 ** t.difficulty;
  const acct = wallet(w);
  S.round.work[w] = (S.round.work[w] ?? 0) + credit;
  S.round.proofs++;
  const now = Date.now();
  recent.push({ at: now, wallet: w, credit });
  // vardiff: from the work this wallet proved in the last 10 s, pick the difficulty
  // that would give about one proof every 4 s. Only the newest ticket may retarget,
  // so a burst of proofs from an old, easier ticket does not keep raising it.
  const mine = recent.filter(p => p.wallet === w && p.at > now - 10_000);
  let retarget = false;
  if (mine.length >= 4 && t.difficulty >= acct.diff) {
    const observed = mine.reduce((a, p) => a + p.credit, 0) / 10;
    const want = diffFor(observed);
    if (want > acct.diff) { acct.diff = want; retarget = true; }
  }
  return [200, { hash: digest.toString('hex'), difficulty: t.difficulty, credit, retarget }];
}

// ---------- live numbers ----------
function live() {
  const now = Date.now();
  while (recent.length && recent[0].at < now - 60_000) recent.shift();
  const miners = new Set(recent.map(p => p.wallet));
  const hashrate = recent.reduce((a, p) => a + p.credit, 0) / 60;
  return { hashrate, active_miners: miners.size, proofs_per_min: recent.length };
}

function leaderboard() {
  const r = S.round;
  const total = Object.values(r.work).reduce((a, b) => a + b, 0) || 1;
  const round = Object.entries(r.work).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([w, work]) => ({ wallet: w, work, share: work / total }));
  const lastRound = S.rounds.at(-1);
  const last = lastRound ? { id: lastRound.id, shares: lastRound.shares.slice(0, 50) } : null;
  const all = Object.entries(S.wallets).filter(([, a]) => a.work > 0).sort((a, b) => b[1].work - a[1].work).slice(0, 50)
    .map(([w, a]) => ({ wallet: w, work: a.work, paid: a.paid }));
  return { round, last, all };
}

function state() {
  const r = S.round;
  return {
    live: live(),
    simulated: SIMULATED,
    config: { reward_per_round: CFG.reward_per_round, payout_threshold: CFG.payout_threshold, token_mint: CFG.token_mint, round_ms: CFG.round_ms, min_difficulty: CFG.min_difficulty },
    round: { id: r.id, started_at: r.started_at, closes_at: r.closes_at, miners: Object.keys(r.work).length, work: Object.values(r.work).reduce((a, b) => a + b, 0) },
    rounds: S.rounds.slice(-6).reverse().map(x => ({ id: x.id, miners: x.miners, reward: x.reward })),
    leaderboard: leaderboard(),
    treasury: treasury ? { address: treasury.address, balance: treasury.balance, cluster: CFG.cluster } : null,
    payouts: S.payouts.slice(0, 100),
  };
}

function walletView(w) {
  const a = S.wallets[w] ?? { balance: 0, pending: 0, paid: 0 };
  const total = Object.values(S.round.work).reduce((x, y) => x + y, 0);
  const mine = S.round.work[w] ?? 0;
  const share = total ? mine / total : 0;
  return { round_share: share, round_estimate: Math.floor(share * CFG.reward_per_round), balance: a.balance, pending: a.pending, paid: a.paid };
}

function stats() {
  const totals = {
    paid: S.payouts.filter(p => p.status === 'sent' || p.status === 'sim').reduce((a, p) => a + p.lamports, 0),
    rounds: S.rounds.filter(r => r.miners > 0).length,
    wallets: Object.values(S.wallets).filter(a => a.work > 0).length,
    work: S.rounds.reduce((a, r) => a + r.work, 0),
  };
  const days = {};
  for (const r of S.rounds) {
    const day = new Date(r.closed_at).toISOString().slice(0, 10);
    const d = (days[day] ??= { day, rounds: 0, proofs: 0, pot: 0, paid: 0 });
    d.rounds++; d.proofs += r.proofs; d.pot += r.reward;
  }
  for (const p of S.payouts) {
    const day = new Date(p.at).toISOString().slice(0, 10);
    if (days[day] && (p.status === 'sent' || p.status === 'sim')) days[day].paid += p.lamports;
  }
  return {
    totals,
    samples: S.samples.slice(-1440),
    rounds: S.rounds.filter(r => r.miners > 0).slice(-60).map(r => ({ id: r.id, reward: r.reward, miners: r.miners })),
    days: Object.values(days).sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
  };
}

function roundsList(q) {
  const limit = Math.min(100, Number(q.get('limit')) || 30);
  const before = Number(q.get('before')) || Infinity;
  const all = q.get('all') === '1';
  const list = [...S.rounds].reverse().filter(r => r.id < before && (all || r.miners > 0));
  const page = list.slice(0, limit).map(r => ({ id: r.id, started_at: r.started_at, closed_at: r.closed_at, miners: r.miners, work: r.work, reward: r.reward, payouts: r.payouts.length }));
  return { rounds: page, more: list.length > limit };
}

function roundDetail(id) {
  const i = S.rounds.findIndex(r => r.id === id);
  if (i < 0) return null;
  const r = S.rounds[i];
  return { ...r, prev: S.rounds[i - 1]?.id ?? null, next: S.rounds[i + 1]?.id ?? null };
}

function benchSave(body) {
  const device = String(body.device ?? '').slice(0, 60), gpu = body.gpu ? String(body.gpu).slice(0, 80) : null;
  const cpu = Number(body.cpu) || 0, gpu_rate = body.gpu_rate == null ? null : Number(body.gpu_rate) || 0;
  const threads = Math.max(1, Math.min(256, Number(body.threads) || 1));
  if (!device || cpu <= 0) return [400, { error: 'bad_result' }];
  const total = cpu + (gpu_rate ?? 0);
  const same = S.bench.find(b => b.device === device && b.gpu === gpu);
  if (same && same.cpu + (same.gpu_rate ?? 0) >= total) return [200, { saved: false }];
  if (same) S.bench.splice(S.bench.indexOf(same), 1);
  S.bench.push({ device, gpu, threads, cpu, gpu_rate, at: Date.now() });
  S.bench.sort((a, b) => (b.cpu + (b.gpu_rate ?? 0)) - (a.cpu + (a.gpu_rate ?? 0)));
  S.bench.length = Math.min(S.bench.length, 200);
  save();
  return [200, { saved: true, rank: S.bench.findIndex(b => b.device === device && b.gpu === gpu) + 1 }];
}

// ---------- SSE ----------
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { if (clients.size) broadcast('state', state()); }, 2000);
setInterval(() => {
  const l = live();
  S.samples.push({ at: Date.now(), hashrate: l.hashrate, miners: l.active_miners });
  if (S.samples.length > 1440) S.samples.shift();
  for (const [id, t] of challenges) if (t.expires_at < Date.now() - 60_000) challenges.delete(id);
}, 60_000);
setInterval(() => { if (S.round && Date.now() >= S.round.closes_at) settle().catch(e => log(`settle failed: ${e.message}`)); }, 1000);

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC = new URL('./public/', import.meta.url).pathname;
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(resolve => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 10_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {}, { 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type' });
  try {
    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state') return send(res, 200, state());
    if (p === '/api/engine') return send(res, 200, engine.view());
    if (p === '/api/stats') return send(res, 200, stats());
    if (p === '/api/rounds') return send(res, 200, roundsList(url.searchParams));
    if (p.startsWith('/api/rounds/')) { const r = roundDetail(Number(p.slice(12))); return r ? send(res, 200, r) : send(res, 404, { error: 'not_found' }); }
    if (p.startsWith('/api/wallet/')) { const w = p.slice(12); return WALLET.test(w) ? send(res, 200, walletView(w)) : send(res, 400, { error: 'bad_wallet' }); }
    if (p === '/api/bench' && req.method === 'GET') return send(res, 200, { results: S.bench });
    if (p === '/api/bench' && req.method === 'POST') { const [st, body] = benchSave(await readBody(req)); return send(res, st, body); }
    if (p === '/api/challenge' && req.method === 'POST') { const [st, body, h] = challenge(await readBody(req)); return send(res, st, body, h); }
    if (p === '/api/proof' && req.method === 'POST') { const [st, body, h] = proof(await readBody(req)); return send(res, st, body, h); }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not_found' });

    // static + SPA fallback
    let file = normalize(p).replace(/^(\.\.[/\\])+/, '');
    if (PAGES.includes(p) || /^\/rounds\/\d+$/.test(p)) file = '/index.html';
    const path = join(PUBLIC, file);
    if (!path.startsWith(PUBLIC) || !existsSync(path) || extname(path) === '') { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': file === '/index.html' || !CFG.static_cache ? 'no-cache' : `public, max-age=${CFG.static_cache}` });
    res.end(readFileSync(path));
  } catch (e) {
    log(`error ${req.method} ${p}: ${e.message}`);
    send(res, 500, { error: 'server_error' });
  }
}).listen(CFG.port, async () => {
  load();
  await initTreasury();
  openRound();
  engine.start();
  log(`sqft on :${CFG.port} · ${SIMULATED ? 'pool test mode' : 'live payouts'} · ${CFG.round_ms / 1000}s rounds · pot ${CFG.reward_per_round / SOL} SOL`);
});
