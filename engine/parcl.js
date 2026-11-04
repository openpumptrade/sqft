// Parcl V4: perpetual futures on real estate price indices (USD per square foot),
// settled in USDC on Parcl Chain, funded through a Solana bridge.
//
// Three things live here:
//   reads    public validator endpoints (markets, oracle, accounts, bridge state); no key needed
//   writes   signed envelopes to POST /v1/tx: the engine's Solana keypair IS the Parcl owner key
//            (same 32-byte ed25519 key, hex-encoded on Parcl), so no API key or agent key is needed
//   bridge   the Solana instruction that moves USDC from the owner's wallet into Parcl collateral
//
// Units (from the docs): prices 8 decimals, sizes 6 decimals, USDC 6 decimals.
// One contract unit of a real estate market is one square foot of its index.
import { createHash, createPrivateKey, sign } from 'node:crypto';

export const ENVS = {
  mainnet: { validator: 'https://validator.v4.parcl.co', rest: 'https://api.v4.parcl.co', chain: 'parcl-v4:mainnet:chain-1', app: 'https://v4.parcl.co', bridge: '7zTa9mWU51PYzADhqaeEvzpnMTW9zxdjF8pFLZQPYtFP' },
  devnet: { validator: 'https://v4-api.dev.parcllabs.com', rest: 'https://v4-rest-api.dev.parcllabs.com', chain: 'parcl-v4:devnet:chain-2', app: 'https://devnet.v4.parcl.co', bridge: '' },
};
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const PRICE = 1e8, SIZE = 1e6, USDC = 1e6;
// Short labels for the lots on the map and in tables.
export const LABELS = { USA: 'USA', NYC: 'NYC', Chicago: 'CHI', LosAngeles: 'LA', Miami: 'MIA', Austin: 'ATX', WashingtonDC: 'DC', SanFrancisco: 'SF' };
export const CITIES = { USA: 'United States', NYC: 'New York City', Chicago: 'Chicago', LosAngeles: 'Los Angeles', Miami: 'Miami', Austin: 'Austin', WashingtonDC: 'Washington, DC', SanFrancisco: 'San Francisco' };

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const DEPOSIT_DISC = createHash('sha256').update('global:deposit').digest().subarray(0, 8);   // f223c68952e1f2b6
let lastNonce = 0;

export class Parcl {
  constructor({ env = 'mainnet', keypair = null, log = console.log } = {}) {
    this.env = ENVS[env] ?? ENVS.mainnet;
    this.envName = env in ENVS ? env : 'mainnet';
    this.keypair = keypair;     // @solana/web3.js Keypair (owner key) or null for reads only
    this.log = log;
    this.cache = new Map();
  }

  // ---------- public reads ----------
  async get(path, { ttl = 0 } = {}) {
    const hit = this.cache.get(path);
    if (ttl && hit && Date.now() - hit.at < ttl) return hit.value;
    const r = await fetch(this.env.validator + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) throw new Error(`parcl ${path} → ${r.status} ${(await r.text()).slice(0, 120)}`);
    const value = await r.json();
    if (ttl) this.cache.set(path, { at: Date.now(), value });
    return value;
  }
  async nodeInfo() { return this.get('/v1/node/info', { ttl: 60_000 }); }

  // Active markets, normalized to numbers: price in USD per square foot, sizes in square feet.
  async markets() {
    const raw = await this.get('/v1/markets', { ttl: 30_000 });
    return raw.filter(m => m.assetClass === 'RealEstate').map(m => ({
      id: m.marketId, name: m.name, label: LABELS[m.name] ?? m.name.slice(0, 3).toUpperCase(), city: CITIES[m.name] ?? m.name,
      price: Number(m.oraclePrice) / PRICE, mark: Number(m.markPrice) / PRICE,
      bid: m.bestBid != null ? Number(m.bestBid) / PRICE : null, ask: m.bestAsk != null ? Number(m.bestAsk) / PRICE : null,
      status: m.status, oracle_status: m.oracleStatus, oracle_at: m.lastOracleTimestamp, valid_until: m.oracleValidUntil * (m.oracleValidUntil < 1e11 ? 1000 : 1),
      funding_hourly: Number(m.fundingRate) / 1e9, max_leverage: m.marginTiers?.[0]?.maxLeverage ?? Math.floor(10000 / m.initialMarginRatioBps),
      oi_long: Number(m.openInterestLong) / SIZE, oi_short: Number(m.openInterestShort) / SIZE, max_oi: Number(m.maxOpenInterest) / SIZE,
      tick: Number(m.tickSize) / PRICE,
    }));
  }
  // Daily oracle points for one market: [{ time (ms), price }]
  async history(id) {
    const d = await this.get(`/v1/oracle/${id}/history`, { ttl: 10 * 60_000 });
    return (d.prices ?? []).map(p => ({ time: p.time * 1000, price: Number(p.price) / PRICE }));
  }
  async fees() { return this.get('/v1/fee-tiers', { ttl: 10 * 60_000 }); }
  async treasuryConfig() { return this.get('/v1/treasury-config', { ttl: 10 * 60_000 }); }

  // The owner key as Parcl writes it: 64 lowercase hex characters of the 32-byte public key.
  static ownerHex(pubkey) { return Buffer.from(pubkey.toBytes()).toString('hex'); }
  // Personal accounts of an owner (the root, non-vault one is the trading account).
  async accountsOf(ownerHex) {
    const list = await this.get(`/v1/accounts/by-owner/${ownerHex}/list`);
    const arr = Array.isArray(list) ? list : (list.accounts ?? []);
    return arr.map(a => ({ id: Number(a.accountId ?? a.id), master: a.masterAccountId ?? null, vault: !!a.isVault, pending: !!a.pendingActivation }));
  }
  async account(id) {
    const a = await this.get(`/v1/accounts/${id}`);
    return {
      id: Number(a.accountId), owner: a.owner, mode: a.mode, pending: !!a.pendingActivation,
      collateral: Number(a.collateral ?? 0) / USDC, available: Number(a.availableCollateral ?? 0) / USDC,
      volume_30d: Number(a.volume30d ?? 0) / USDC, lifetime_volume: Number(a.lifetimeVolume ?? 0) / USDC, created_at: a.createdAt ?? null,
      positions: (a.positions ?? []).map(p => ({
        market: Number(p.marketId), side: p.side, sqft: Number(p.size) / SIZE, entry: Number(p.entryPrice) / PRICE,
        upnl: Number(p.unrealizedPnl ?? 0) / USDC, leverage: p.leverage ?? null, opened_at: p.openedAt ?? null, mode: p.margin_mode ?? p.marginMode ?? 'Cross',
      })),
      open_orders: (a.openOrders ?? []).length,
    };
  }
  async bridgeState(ownerHex) {
    const d = await this.get(`/v1/bridge/state${ownerHex ? `?owner=${ownerHex}` : ''}`);
    return { ...d, unclaimed_usdc: Number(d.unclaimed_usdc ?? 0) / USDC, deposits_halted: !!d.deposits_halted, paused: !!d.paused };
  }

  // ---------- signed writes (owner key, straight to the validator) ----------
  get canSign() { return !!this.keypair; }
  nonce() { const n = Math.max(Date.now(), lastNonce + 1); lastNonce = n; return n; }
  signBytes(msg) {
    const seed = Buffer.from(this.keypair.secretKey.subarray(0, 32));
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
    return sign(null, Buffer.from(msg, 'utf8'), key);
  }
  // Signs JSON.stringify([chainId, transaction, nonce, timestamp]) and submits the envelope with the SAME transaction object,
  // so the bytes the validator verifies are the bytes it executes.
  async submit(transaction) {
    if (!this.keypair) throw new Error('parcl: no owner key to sign with');
    const nonce = this.nonce(), timestamp = Math.floor(Date.now() / 1000);
    const msg = JSON.stringify([this.env.chain, transaction, nonce, timestamp]);
    const signature = this.signBytes(msg);
    const envelope = { transaction, chain_id: this.env.chain, signer: [...this.keypair.publicKey.toBytes()], signature: [...signature], nonce, timestamp };
    const r = await fetch(`${this.env.validator}/v1/tx`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { status: r.ok ? 'success' : 'failed', error: text.slice(0, 200) }; }
    if (!r.ok || body.status === 'failed') throw new Error(`parcl tx ${Object.keys(transaction)[0]} → ${r.status} ${body.error ?? text.slice(0, 160)}`);
    return body;   // { status, hash, events }
  }
  // A personal cross-margin account funded from the owner's unclaimed bridge deposit.
  async createAccount({ referredBy = null } = {}) {
    const tx = { CreateFundedAccount: referredBy ? { mode: 'Cross', referred_by: Number(referredBy) } : { mode: 'Cross' } };
    return this.submit(tx);
  }
  // IOC market order. size in square feet, leverage 1 = no borrowing (notional == collateral used).
  async marketOrder({ accountId, marketId, side = 'Long', sqft, leverage = 1, slippageBps = 100, reduceOnly = false }) {
    const size = Math.floor(sqft * SIZE);
    if (size <= 0) throw new Error('parcl: order size rounds to zero');
    const tx = { PlaceOrder: { account_id: Number(accountId), market_id: Number(marketId), side, order_type: 'Market', price: 0, size, trigger_price: null, reduce_only: reduceOnly, post_only: false, time_in_force: 'IOC', take_profit: null, stop_loss: null, max_slippage_bps: slippageBps, leverage: Math.max(1, Math.round(leverage)) } };
    return this.submit(tx);
  }

  // ---------- the Solana bridge deposit ----------
  // One top-level instruction: [bridge config PDA (w), owner USDC ATA (w), custody PDA (w), owner (signer), token program]
  // data = sha256("global:deposit")[0..8] ‖ u64 LE amount ‖ u8 0 (USDC). The deposit credits the Parcl account whose owner
  // bytes equal the signer, so it must be signed by the wallet that owns (or will own) the Parcl account.
  async depositInstruction({ owner, amountRaw }) {
    if (!this.env.bridge) throw new Error(`parcl: no bridge program known for ${this.envName}`);
    const { PublicKey, TransactionInstruction } = await import('@solana/web3.js');
    const program = new PublicKey(this.env.bridge), mint = new PublicKey(USDC_MINT), TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const [config] = PublicKey.findProgramAddressSync([Buffer.from('bridge')], program);
    const [custody] = PublicKey.findProgramAddressSync([Buffer.from('custody_usdc'), config.toBuffer()], program);
    const [ata] = PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA);
    const data = Buffer.alloc(17);
    DEPOSIT_DISC.copy(data, 0); data.writeBigUInt64LE(BigInt(amountRaw), 8); data.writeUInt8(0, 16);
    return new TransactionInstruction({
      programId: program, data,
      keys: [
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: custody, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        { pubkey: TOKEN, isSigner: false, isWritable: false },
      ],
    });
  }
  async deposit(connection, { amountRaw }) {
    const { Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } = await import('@solana/web3.js');
    const ix = await this.depositInstruction({ owner: this.keypair.publicKey, amountRaw });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ix);
    return sendAndConfirmTransaction(connection, tx, [this.keypair], { commitment: 'confirmed' });
  }

  // Links a reader can open.
  accountUrl(id) { return `${this.env.validator}/v1/accounts/${id}`; }
  marketUrl(name) { return `${this.env.app}/trade/${name}`; }
}
