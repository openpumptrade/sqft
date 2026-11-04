// The land engine: pump.fun creator rewards → USDC on Solana → collateral on Parcl → square feet.
// Runs on a timer inside server.js.
//
// Every hop leaves a receipt somebody else can check:
//   1. claim     Solana tx (creator vault → engine wallet)                     solscan
//   2. convert   Solana tx (Jupiter, SOL → USDC, same wallet)                   solscan
//   3. bridge    Solana tx (USDC → the Parcl bridge, credited to the owner)     solscan + GET /v1/bridge/state?owner=
//   4. buy land  Parcl tx (IOC market order, long, 1x) on a city index          GET /v1/accounts/{id} on the validator
//   5. hold      positions marked daily by the Parcl Labs oracle                GET /api/engine here, GET /v1/accounts/{id} there
//
// The engine wallet's keypair is also the Parcl owner key (same ed25519 key), so one secret runs
// the whole loop. Without PRIVATE_KEY the engine reads the public side only (vault, markets, and the
// Parcl account of ENGINE_WALLET if one exists) so the page still works.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parcl, USDC_MINT, CITIES, LABELS } from './parcl.js';

const env = (k, d) => (process.env[k] ?? d);
const SOL = 1e9, USDC_DEC = 6;
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
let TOKEN_PROGRAM = null;

// PARCL_MARKETS: "USA,NYC,Miami" (equal weights) or "USA:40,NYC:30,Miami:30".
function parseTargets(s) {
  const parts = String(s).split(',').map(x => x.trim()).filter(Boolean).map(x => { const [name, w] = x.split(':'); return { name, weight: Number(w) || 1 }; });
  const total = parts.reduce((a, p) => a + p.weight, 0) || 1;
  return parts.map(p => ({ ...p, weight: p.weight / total }));
}

export const CFG = {
  enabled: env('ENGINE', '0') === '1',
  dry: env('ENGINE_DRY', '1') === '1',                       // dry by default: logs instead of moving funds
  every_ms: Number(env('ENGINE_EVERY_MS', 600_000)),
  rpc: env('RPC_URL', 'https://solana-rpc.publicnode.com'),
  secret: env('PRIVATE_KEY', ''),
  owner: env('ENGINE_WALLET', ''),                           // public key of the engine wallet, for read-only mode
  creator: env('CREATOR_WALLET', ''),                        // public key of the coin's creator; lets the page show the vault before the engine is armed
  keep_sol: Number(env('ENGINE_KEEP_SOL', 0.02)),
  min_claim_sol: Number(env('ENGINE_MIN_CLAIM_SOL', 0.01)),
  token_mint: env('TOKEN_MINT', ''),
  parcl_env: env('PARCL_ENV', 'mainnet'),
  targets: parseTargets(env('PARCL_MARKETS', 'USA,NYC,Chicago,LosAngeles,Miami,Austin,WashingtonDC,SanFrancisco')),
  leverage: Math.max(1, Number(env('PARCL_LEVERAGE', 1))),
  min_order_usd: Number(env('PARCL_MIN_ORDER_USD', 5)),
  min_bridge_usdc: Number(env('PARCL_MIN_BRIDGE_USDC', 5)),   // the bridge rejects deposits under $5
  slippage_bps: Number(env('PARCL_MAX_SLIPPAGE_BPS', 100)),
  referrer: env('PARCL_REFERRER', ''),                        // optional referrer account id for CreateFundedAccount
  reserve_usd: Number(env('PARCL_RESERVE_USD', 0.5)),         // collateral left idle so funding never liquidates a 1x book
  data_file: env('ENGINE_DATA_FILE', new URL('../data/engine.json', import.meta.url).pathname),
};

const log = (...a) => console.log(new Date().toISOString(), '[engine]', ...a);

export class LandEngine {
  constructor() {
    this.state = { claims: [], swaps: [], bridges: [], orders: [], errors: [], wallet: CFG.owner || null, account_id: null, lastRun: null, marks: [] };
    this.live = { markets: [], account: null, bridge: null, vault: null, wallet_usdc: 0, history: {}, at: 0 };
    this.parcl = new Parcl({ env: CFG.parcl_env, log });
    this.kit = null; this.ctx = null; this.walletKp = null;
    this.load();
  }

  load() {
    try { if (existsSync(CFG.data_file)) this.state = { ...this.state, ...JSON.parse(readFileSync(CFG.data_file, 'utf8')) }; } catch (e) { log(`load failed: ${e.message}`); }
    if (CFG.owner && !this.state.wallet) this.state.wallet = CFG.owner;
  }
  save() {
    try { mkdirSync(join(CFG.data_file, '..'), { recursive: true }); writeFileSync(CFG.data_file, JSON.stringify(this.state)); } catch (e) { log(`save failed: ${e.message}`); }
  }
  push(list, item) { this.state[list].unshift({ at: Date.now(), ...item }); this.state[list].length = Math.min(this.state[list].length, 500); this.save(); }
  fail(step, err) { log(`${step} failed: ${err.message}`); this.push('errors', { step, error: err.message.slice(0, 300) }); }

  get writes() { return CFG.enabled && !!CFG.secret; }

  // ---------- what the page reads ----------
  // Square feet on the books, by city, plus the dollars still on the way (wallet USDC and unclaimed bridge deposits).
  land() {
    const markets = this.live.markets, acct = this.live.account;
    const byId = new Map(markets.map(m => [m.id, m]));
    const lots = markets.map(m => {
      const t = CFG.targets.find(x => x.name === m.name);
      const p = acct?.positions.filter(x => x.market === m.id) ?? [];
      const sqft = p.reduce((a, x) => a + (x.side === 'Long' ? x.sqft : -x.sqft), 0);
      const entry = p.length ? p.reduce((a, x) => a + x.entry * x.sqft, 0) / p.reduce((a, x) => a + x.sqft, 0) : null;
      const h = this.live.history[m.id] ?? [];
      const last = h.at(-1)?.price ?? m.price, d1 = h.at(-2)?.price, d30 = h.at(-31)?.price ?? h[0]?.price;
      return {
        id: m.id, name: m.name, label: m.label, city: m.city, price: m.price, mark: m.mark, status: m.status, oracle_status: m.oracle_status, valid_until: m.valid_until, funding_hourly: m.funding_hourly,
        weight: t?.weight ?? 0, target: !!t, sqft: +sqft.toFixed(6), entry, notional: +(sqft * m.price).toFixed(2), upnl: +p.reduce((a, x) => a + x.upnl, 0).toFixed(4),
        change_1d: d1 ? last / d1 - 1 : 0, change_30d: d30 ? last / d30 - 1 : 0, spark: h.slice(-30).map(x => x.price),
      };
    });
    const sqft = lots.reduce((a, l) => a + l.sqft, 0), notional = lots.reduce((a, l) => a + l.notional, 0), upnl = lots.reduce((a, l) => a + l.upnl, 0);
    // dollars on the way: priced at today's index by target weight → "under contract" square feet
    const onway = (this.live.wallet_usdc ?? 0) + (this.live.bridge?.unclaimed_usdc ?? 0) + (acct?.available ?? 0);
    const reserved = CFG.targets.map(t => { const m = markets.find(x => x.name === t.name); return m ? { name: m.name, label: m.label, usd: onway * t.weight, sqft: (onway * t.weight * CFG.leverage) / m.price } : null; }).filter(Boolean);
    return {
      lots, sqft: +sqft.toFixed(6), notional: +notional.toFixed(2), upnl: +upnl.toFixed(4),
      collateral: acct?.collateral ?? 0, available: acct?.available ?? 0, equity: +((acct?.collateral ?? 0) + upnl).toFixed(4),
      cities: lots.filter(l => l.sqft > 0).length, on_the_way_usd: +onway.toFixed(2), reserved_sqft: +reserved.reduce((a, r) => a + r.sqft, 0).toFixed(6), reserved,
      index: byId.get(65536)?.price ?? markets[0]?.price ?? null,
    };
  }
  flow() {
    const L = this.land();
    const m = this.live.markets[0];
    return {
      sqft: L.sqft, notional: L.notional, equity: L.equity, cities: L.cities, reserved_sqft: L.reserved_sqft, on_the_way_usd: L.on_the_way_usd,
      next_run: this.state.lastRun ? this.state.lastRun + CFG.every_ms : null, cycle_ms: CFG.every_ms, armed: this.writes,
      oracle_valid_until: m?.valid_until ?? null, oracle_status: m?.oracle_status ?? null,
    };
  }
  view() {
    const sum = (l, k) => this.state[l].reduce((a, x) => a + (x[k] ?? 0), 0);
    return {
      flow: this.flow(),
      land: this.land(),
      config: {
        enabled: CFG.enabled, dry: CFG.dry, writes: this.writes, every_ms: CFG.every_ms, parcl_env: this.parcl.envName, chain: this.parcl.env.chain, app: this.parcl.env.app, validator: this.parcl.env.validator,
        wallet: this.state.wallet, owner_hex: this.ownerHex(), creator: CFG.creator || this.state.wallet || null, account_id: this.state.account_id, account_url: this.state.account_id ? this.parcl.accountUrl(this.state.account_id) : null,
        targets: CFG.targets.map(t => ({ ...t, label: LABELS[t.name] ?? t.name, city: CITIES[t.name] ?? t.name })), leverage: CFG.leverage, min_order_usd: CFG.min_order_usd, min_bridge_usdc: CFG.min_bridge_usdc, slippage_bps: CFG.slippage_bps,
        bridge_program: this.parcl.env.bridge, usdc_mint: USDC_MINT, token_mint: CFG.token_mint || null,
      },
      totals: {
        claimed_lamports: sum('claims', 'lamports'), swapped_lamports: sum('swaps', 'lamports'), swapped_usdc: sum('swaps', 'usdc'),
        bridged_usdc: sum('bridges', 'usdc'), bought_usd: this.state.orders.filter(o => o.kind === 'buy').reduce((a, o) => a + (o.usd ?? 0), 0), bought_sqft: this.state.orders.filter(o => o.kind === 'buy').reduce((a, o) => a + (o.sqft ?? 0), 0),
      },
      live: { account: this.live.account, bridge: this.live.bridge ? { unclaimed_usdc: this.live.bridge.unclaimed_usdc, deposits_halted: this.live.bridge.deposits_halted, paused: this.live.bridge.paused, total_bridged_usdc: Number(this.live.bridge.total_bridged_usdc ?? 0) / 1e6 } : null, vault: this.live.vault, wallet_usdc: this.live.wallet_usdc, at: this.live.at },
      ledger: { claims: this.state.claims.slice(0, 50), swaps: this.state.swaps.slice(0, 50), bridges: this.state.bridges.slice(0, 50), orders: this.state.orders.slice(0, 80), errors: this.state.errors.slice(0, 10) },
      marks: this.state.marks.slice(-240),
      last_run: this.state.lastRun,
    };
  }

  start() {
    this.poll().catch(e => log(`poll: ${e.message}`));
    setInterval(() => this.poll().catch(e => log(`poll: ${e.message}`)), 60_000);
    setInterval(() => this.mark(), 15 * 60_000);
    if (!CFG.enabled) { log(`engine off (ENGINE=0) · public reads only · parcl ${this.parcl.envName}`); return; }
    if (!this.writes) log('engine on but not armed: needs PRIVATE_KEY');
    const tick = () => this.round().catch(e => this.fail('round', e));
    setTimeout(tick, 5000);
    setInterval(tick, CFG.every_ms);
  }

  // ---------- public reads ----------
  ownerHex() {
    if (!this.state.wallet) return null;
    try { const { PublicKey } = this.web3 ?? {}; return PublicKey ? Parcl.ownerHex(new PublicKey(this.state.wallet)) : null; } catch { return null; }
  }
  async poll() {
    await this.ctxLoad();
    const [markets, vault] = await Promise.all([
      this.parcl.markets().catch(e => { log(`markets: ${e.message}`); return this.live.markets; }),
      this.vaultStats().catch(() => this.live.vault),
    ]);
    // daily oracle history per market, cached 10 min inside the client
    const history = {};
    await Promise.all(markets.map(async m => { history[m.id] = await this.parcl.history(m.id).catch(() => this.live.history[m.id] ?? []); }));
    let account = this.live.account, bridge = this.live.bridge, wallet_usdc = this.live.wallet_usdc;
    const hex = this.ownerHex();
    if (hex) {
      try {
        const id = this.state.account_id ?? (await this.parcl.accountsOf(hex)).find(a => !a.vault && a.master == null)?.id ?? null;
        if (id && id !== this.state.account_id) { this.state.account_id = id; this.save(); }
        account = id ? await this.parcl.account(id) : null;
      } catch (e) { log(`account: ${e.message}`); }
      bridge = await this.parcl.bridgeState(hex).catch(() => bridge);
      wallet_usdc = await this.stableBalance(this.state.wallet, USDC_MINT).catch(() => wallet_usdc);
    }
    this.live = { markets, account, bridge, vault, wallet_usdc, history, at: Date.now() };
    if (!this.state.marks.length) this.mark();
  }
  // A mark every 15 minutes: square feet, notional, equity. Feeds the equity curve on /stats.
  mark() {
    const L = this.land();
    if (!this.live.markets.length) return;
    this.state.marks.push({ at: Date.now(), sqft: L.sqft, notional: L.notional, equity: L.equity, index: L.index });
    if (this.state.marks.length > 2000) this.state.marks.shift();
    this.save();
  }
  async stableBalance(owner, mintAddr) {
    const { PublicKey } = this.web3;
    const conn = this.ctx.connection, mint = new PublicKey(mintAddr), who = new PublicKey(owner);
    try {
      const r = await conn.getParsedTokenAccountsByOwner(who, { mint }, 'confirmed');
      return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0) / 10 ** USDC_DEC;
    } catch {}
    const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const [ata] = PublicKey.findProgramAddressSync([who.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA);
    const info = await conn.getAccountInfo(ata, 'confirmed');
    if (!info || info.data.length < 72) return 0;
    return Number(info.data.readBigUInt64LE(64)) / 10 ** USDC_DEC;
  }
  // Creator rewards waiting in the pump.fun vault (public read; needs only the creator's address).
  async vaultStats() {
    const creator = CFG.creator || this.state.wallet;
    if (!creator) return null;
    const v = await this.kit.creatorVaultBalances(this.ctx, { creator });
    let shared = 0, sharing = null;
    if (CFG.token_mint) {
      sharing = await this.kit.readSharingConfig(this.ctx, CFG.token_mint).catch(() => null);
      if (sharing) shared = await this.kit.sharedFeesWaiting(this.ctx, CFG.token_mint).catch(() => 0);
    }
    return { creator, claimable_sol: v.sol + shared, creator_vault_sol: v.sol, shared_vault_sol: shared, sharing: sharing ? { shareholders: sharing.shareholders } : null, at: Date.now() };
  }

  // ---------- the round ----------
  async ctxLoad() {
    if (this.kit) return;
    const [kit, fees, jup, transfer, token, wallet, web3] = await Promise.all([import('pumpkit'), import('pumpkit/pumpfun/fees'), import('pumpkit/jupiter'), import('pumpkit/transfer'), import('pumpkit/token'), import('pumpkit/wallet'), import('@solana/web3.js')]);
    this.kit = { ...kit, ...fees, ...jup, ...transfer, ...token, ...wallet };
    this.web3 = web3;
    this.ctx = this.kit.createContext({ rpcUrl: CFG.rpc, slippagePct: 1, log: { log, warn: log, error: log } });
    TOKEN_PROGRAM = new web3.PublicKey(TOKEN_PROGRAM_ID);
    if (CFG.secret) {
      this.walletKp = this.kit.keypairFromSecret(CFG.secret);
      this.state.wallet = this.walletKp.publicKey.toBase58();
      this.parcl.keypair = this.walletKp;
      this.save();
    }
  }

  async round() {
    if (!this.writes) return;
    await this.ctxLoad();
    this.state.lastRun = Date.now();
    log(`round · wallet ${this.state.wallet} · parcl ${this.parcl.envName}${CFG.dry ? ' · DRY' : ''}`);
    await this.claim();
    await this.swapUsdc();
    await this.bridge();
    await this.ensureAccount();
    await this.buy();
    await this.poll().catch(() => {});
    this.mark();
  }

  // 1. claim creator rewards (shared-fee vault first, then the creator vault)
  async claim() {
    const { kit, ctx, walletKp: w } = this;
    try {
      if (CFG.token_mint) {
        const cfg = await kit.readSharingConfig(ctx, CFG.token_mint).catch(() => null);
        if (cfg) {
          const waiting = await kit.sharedFeesWaiting(ctx, CFG.token_mint).catch(() => 0);
          if (waiting >= CFG.min_claim_sol) {
            if (CFG.dry) log(`would distribute ${waiting} SOL of shared fees`);
            else {
              const r = await kit.distributeSharedFees(ctx, { mint: CFG.token_mint, wallet: w });
              this.push('claims', { sig: r.sig, lamports: Math.round(r.gainedSol * SOL), shared: true });
              log(`distributed ${waiting} SOL of shared fees · got ${r.gainedSol} SOL · ${r.sig}`);
            }
          }
        }
      }
      const claimable = await kit.creatorVaultBalances(ctx, { creator: w.publicKey });
      if (claimable.sol < CFG.min_claim_sol) return;
      if (CFG.dry) return log(`would claim ${claimable.sol} SOL`);
      const r = await kit.claimCreatorFees(ctx, { wallet: w });
      if (r.sig) { this.push('claims', { sig: r.sig, lamports: Number(r.claimedRaw) }); log(`claimed ${Number(r.claimedRaw) / SOL} SOL · ${r.sig}`); }
    } catch (e) { this.fail('claim', e); }
  }

  // 2. SOL above the gas reserve → USDC through Jupiter (USDC is the only stable the bridge takes)
  async swapUsdc() {
    const { kit, ctx, walletKp: w } = this;
    try {
      const bal = await ctx.connection.getBalance(w.publicKey);
      const spend = bal - Math.round(CFG.keep_sol * SOL);
      if (spend <= 0.005 * SOL) return;
      if (CFG.dry) return log(`would swap ${spend / SOL} SOL → USDC`);
      const r = await kit.swapSolFor(ctx, { wallet: w, mint: USDC_MINT, lamports: BigInt(spend), slippageBps: 100 });
      this.push('swaps', { sig: r.sig, lamports: spend, usdc: Number(r.outAmount) / 10 ** USDC_DEC });
      log(`swapped ${spend / SOL} SOL → ${Number(r.outAmount) / 1e6} USDC · ${r.sig}`);
    } catch (e) { this.fail('swap', e); }
  }

  // 3. USDC in the engine wallet → the Parcl bridge (credited to this very key as Parcl collateral)
  async bridge() {
    const { kit, ctx, walletKp: w } = this;
    try {
      const raw = await kit.tokenBalanceRaw(ctx, { owner: w.publicKey, mint: USDC_MINT, programId: TOKEN_PROGRAM });
      const usdc = Number(raw) / 10 ** USDC_DEC;
      if (usdc < CFG.min_bridge_usdc) return usdc > 0 ? log(`holding ${usdc.toFixed(2)} USDC until the ${CFG.min_bridge_usdc} USDC bridge minimum`) : undefined;
      const st = await this.parcl.bridgeState().catch(() => null);
      if (st?.deposits_halted || st?.paused) return log('bridge deposits are halted right now; holding the USDC');
      if (CFG.dry) return log(`would bridge ${usdc} USDC to Parcl (${this.parcl.env.bridge})`);
      const sig = await this.parcl.deposit(ctx.connection, { amountRaw: raw });
      this.push('bridges', { sig, usdc, program: this.parcl.env.bridge });
      log(`bridged ${usdc} USDC → Parcl · ${sig}`);
    } catch (e) { this.fail('bridge', e); }
  }

  // 3b. first time only: turn the unclaimed deposit into a personal cross-margin account
  async ensureAccount() {
    try {
      const hex = Parcl.ownerHex(this.walletKp.publicKey);
      if (!this.state.account_id) {
        const have = (await this.parcl.accountsOf(hex)).find(a => !a.vault && a.master == null);
        if (have) { this.state.account_id = have.id; this.save(); }
      }
      if (this.state.account_id) return;
      const st = await this.parcl.bridgeState(hex);
      const tc = await this.parcl.treasuryConfig().catch(() => ({}));
      const fee = Number(tc.account_activation_fee_usdc ?? 1_000_000) / 1e6;
      if (st.unclaimed_usdc < 5 + fee) return st.unclaimed_usdc > 0 ? log(`unclaimed ${st.unclaimed_usdc} USDC on the bridge; an account needs ${5 + fee} USDC`) : undefined;
      if (CFG.dry) return log(`would create a Parcl account from ${st.unclaimed_usdc} USDC unclaimed (fee ${fee} USDC)`);
      const r = await this.parcl.createAccount({ referredBy: CFG.referrer || null });
      log(`CreateFundedAccount submitted · ${r.hash}`);
      for (let i = 0; i < 10; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const acct = (await this.parcl.accountsOf(hex).catch(() => [])).find(a => !a.vault && a.master == null);
        if (acct) { this.state.account_id = acct.id; this.push('orders', { kind: 'account', hash: r.hash, account_id: acct.id, usd: st.unclaimed_usdc }); log(`parcl account #${acct.id}`); return; }
      }
      this.push('orders', { kind: 'account', hash: r.hash, account_id: null, usd: st.unclaimed_usdc });
    } catch (e) { this.fail('account', e); }
  }

  // 4. free collateral → square feet, city by city, toward the target weights
  async buy() {
    try {
      if (!this.state.account_id) return;
      const [acct, markets] = await Promise.all([this.parcl.account(this.state.account_id), this.parcl.markets()]);
      const deployable = acct.available - CFG.reserve_usd;
      if (deployable < CFG.min_order_usd) return log(`parcl #${acct.id}: ${acct.available.toFixed(2)} USDC free, under the ${CFG.min_order_usd} USD order minimum`);
      const notionalNow = m => acct.positions.filter(p => p.market === m.id).reduce((a, p) => a + (p.side === 'Long' ? p.sqft : -p.sqft) * m.price, 0);
      const total = acct.positions.reduce((a, p) => a + p.sqft * (markets.find(m => m.id === p.market)?.price ?? 0), 0) + deployable * CFG.leverage;
      // deficits against the target book, largest first
      const plan = CFG.targets.map(t => {
        const m = markets.find(x => x.name === t.name);
        if (!m || m.status !== 'Active' || m.oracle_status !== 'Active') return null;
        return { m, deficit: t.weight * total - notionalNow(m) };
      }).filter(p => p && p.deficit > 0).sort((a, b) => b.deficit - a.deficit);
      if (!plan.length) return log('book already at target weights');
      let budget = deployable * CFG.leverage;
      const sumDef = plan.reduce((a, p) => a + p.deficit, 0);
      const orders = [];
      for (const p of plan) {
        let usd = Math.min(p.deficit, budget * (p.deficit / sumDef));
        if (usd < CFG.min_order_usd) continue;
        orders.push({ m: p.m, usd });
      }
      if (!orders.length) { const p = plan[0]; orders.push({ m: p.m, usd: Math.min(budget, p.deficit) }); }
      const before = new Map(acct.positions.map(p => [p.market, p.sqft]));
      for (const o of orders) {
        const sqft = o.usd / o.m.price;
        if (sqft * 1e6 < 1) continue;
        if (CFG.dry) { log(`would buy ${sqft.toFixed(4)} sqft of ${o.m.name} at ~$${o.m.price.toFixed(2)}/sqft ($${o.usd.toFixed(2)}, ${CFG.leverage}x)`); continue; }
        try {
          const r = await this.parcl.marketOrder({ accountId: acct.id, marketId: o.m.id, side: 'Long', sqft, leverage: CFG.leverage, slippageBps: CFG.slippage_bps });
          const fills = (r.events ?? []).filter(e => /fill/i.test(JSON.stringify(Object.keys(e)[0] ?? e.type ?? '')));
          this.push('orders', { kind: 'buy', hash: r.hash, market: o.m.id, name: o.m.name, label: o.m.label, sqft: +sqft.toFixed(6), price: o.m.price, usd: +o.usd.toFixed(2), fills: fills.length, events: (r.events ?? []).length });
          log(`bought ~${sqft.toFixed(4)} sqft of ${o.m.name} · $${o.usd.toFixed(2)} · ${r.hash}`);
        } catch (e) { this.fail(`buy ${o.m.name}`, e); }
      }
      if (CFG.dry) return;
      // what actually filled, from the positions
      const after = await this.parcl.account(acct.id).catch(() => null);
      if (after) for (const p of after.positions) {
        const d = p.sqft - (before.get(p.market) ?? 0);
        if (d > 1e-6) log(`${markets.find(m => m.id === p.market)?.name ?? p.market}: +${d.toFixed(6)} sqft on the books (${p.sqft.toFixed(6)} total)`);
      }
    } catch (e) { this.fail('buy', e); }
  }
}
