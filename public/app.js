// UI: routing, the engine home, the land page, stats and the market cards.
import { lineChart } from './charts.js';
import { API } from './config.js';
import { LotStrip } from './lots.js';
import { pulse, ripples, scramble, toast } from './fx.js';

const $ = id => document.getElementById(id);
const PAGES = ['/', '/land', '/stats', '/rules'];

ripples('.btn');
if (new URLSearchParams(location.search).has('still')) document.body.classList.add('still');   // ?still=1: no motion, for screenshots

const scene = new LotStrip($('lotWrap'));
globalThis.__lots = scene;   // for debugging from the console

// ---------- formatting ----------
const sol = lamports => (lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
const num = (v, d = 2) => (+Number(v).toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const sqft = v => { v = Number(v) || 0; return v === 0 ? '0' : v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : num(v, 0); };
const usd = v => `${v < 0 ? '−' : ''}$${num(Math.abs(Number(v) || 0), Math.abs(v) < 100 ? 2 : 0)}`;
const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), 2)}`;
const pctS = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(2)}%`;
const time = t => new Date(t).toLocaleTimeString([], { hour12: false });
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function setText(id, v) { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; }
const getJson = async path => (await fetch(API + path)).json();
const ago = t => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const until = t => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const solLink = sig => `<a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(sig.slice(0, 10))}…</a>`;
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
const acct = a => ext(`https://solscan.io/account/${a}`, esc(a));

// Tick-row progress bar, lit up to `fraction`; the leading tick pulses.
function segments(el, fraction, n = 24) {
  if (el.children.length !== n) el.innerHTML = '<span></span>'.repeat(n);
  const f = Math.max(0, Math.min(1, fraction));
  const at = Math.min(n - 1, Math.floor(f * n));
  [...el.children].forEach((s, i) => { s.className = i < at ? 'on' : i === at && f > 0 ? 'at' : ''; });
}

// ---------- routing ----------
function route() {
  const path = PAGES.includes(location.pathname) ? location.pathname : '/';
  const kind = path === '/' ? '/' : 'page';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== kind;
  for (const a of document.querySelectorAll('.top nav a')) a.classList.toggle('on', a.getAttribute('href') === path);
  if (kind === 'page') for (const el of document.querySelectorAll('[data-page]')) el.hidden = el.dataset.page !== path;
  scrollTo(0, 0);
  if (path === '/') loadHome();
  if (path === '/land') loadLand();
  if (path === '/stats') loadStats();
  if (path === '/rules') { loadRules(); loadCredits(); }
  enter(document.querySelector(`[data-view="${kind}"]`));
}
function enter(view) {
  pulse(view, 'enter');
  for (const el of view.querySelectorAll('article:not([hidden]) h1')) if (!el.querySelector('*')) scramble(el, el.dataset.text ?? el.textContent, 700);
}
function go(path) {
  history.pushState(null, '', path);
  route();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
addEventListener('popstate', route);

// ---------- shared engine state ----------
let engineData = null, engineAt = 0;
async function engineState(maxAge = 10_000) {
  if (engineData && Date.now() - engineAt < maxAge) return engineData;
  try {
    engineData = await getJson('/api/engine'); engineAt = Date.now();
    $('conn').className = 'conn live'; $('conn').title = 'live';
  } catch {
    $('conn').className = 'conn down'; $('conn').title = 'api unreachable';
    throw new Error('api');
  }
  renderCA(engineData.config.token_mint);
  return engineData;
}

// Contract address: a placeholder until TOKEN_MINT is set on the server.
let shownMint;
function renderCA(mint) {
  if (mint === shownMint) return;
  shownMint = mint;
  $('ca').classList.toggle('set', !!mint);
  $('caCopy').hidden = $('caLink').hidden = !mint;
  if (mint) { scramble($('caValue'), mint, 600); $('caLink').href = `https://pump.fun/coin/${mint}`; }
  else $('caValue').textContent = 'dropping at launch';
}
$('caCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownMint);
    $('caCopy').textContent = 'Copied';
    toast('CA copied', `${shownMint.slice(0, 6)}…${shownMint.slice(-6)}`, 'good');
  } catch {
    toast('Copy failed', 'Select the address and copy it manually.', 'bad');
  }
  setTimeout(() => { $('caCopy').textContent = 'Copy'; }, 1600);
});

// ---------- the market cards ----------
function feedStrip(Ld) {
  scene.setLots((Ld.lots ?? []).map(x => ({ key: x.name, label: x.label, city: x.city, price: x.price, change_1d: x.change_1d, change_30d: x.change_30d, spark: x.spark, sqft: x.sqft, notional: x.notional, reserved: (Ld.reserved ?? []).find(r => r.name === x.name)?.sqft ?? 0 })));
}

// ---------- engine home ----------
let homeTimer = null, seenOrders = null;
async function loadHome() {
  clearTimeout(homeTimer);
  if (location.pathname !== '/') return;
  try { await engineState(0); renderHome(); } catch {}
  homeTimer = setTimeout(loadHome, 15_000);
}
function renderHome() {
  const d = engineData; if (!d || location.pathname !== '/') return;
  const { config: c, live: l, totals: t, ledger: L, flow: f, land: Ld } = d;
  const now = Date.now();
  const holding = Ld.sqft > 0;
  setText('kpSqft', `${sqft(Ld.sqft)} sqft`);
  setText('kpValue', usd(Ld.notional));
  setText('kpColl', usd(Ld.collateral ?? 0));
  setText('kpStatus', holding ? 'Holding' : f.armed ? (c.dry ? 'Dry run' : 'Armed') : 'Standby');
  if (f.next_run) { setText('hmLeft', until(f.next_run)); segments($('hmRuler'), 1 - Math.max(0, f.next_run - now) / f.cycle_ms); }
  else { setText('hmLeft', `every ${Math.round(f.cycle_ms / 60000)} min`); segments($('hmRuler'), 0); }
  const vault = l.vault;
  setText('hmVault', vault ? `Creator vault: ${vault.claimable_sol.toFixed(4)} SOL claimable · ${sol(t.claimed_lamports)} SOL claimed so far · ${usd(t.bridged_usdc)} bridged` : c.creator ? 'Creator vault: reading…' : 'Creator vault: wallet not set');
  const swaps = L.swaps ?? [], claims = L.claims ?? [], bridges = L.bridges ?? [], orders = (L.orders ?? []).filter(o => o.kind === 'buy');
  const lastSwap = swaps[0], lastClaim = claims[0], lastBridge = bridges[0], lastBuy = orders[0];
  const A = l.account;
  const ready = vault && vault.claimable_sol >= 0.01;
  const step = (name, text, cls) => { const li = document.querySelector(`#hmSteps li[data-step="${name}"]`); li.className = cls; li.querySelector('small').textContent = text; };
  step('claim', lastClaim ? `${sol(lastClaim.lamports)} SOL · ${ago(lastClaim.at)}` : vault ? `${vault.claimable_sol.toFixed(4)} SOL waiting` : '', ready ? 'wait' : lastClaim ? 'on' : '');
  step('convert', lastSwap ? `${usd(lastSwap.usdc)} · ${ago(lastSwap.at)}` : '', lastSwap ? 'on' : '');
  step('bridge', lastBridge ? `${usd(lastBridge.usdc)} · ${ago(lastBridge.at)}` : (l.wallet_usdc ?? 0) > 0 ? `${usd(l.wallet_usdc)} waiting` : '', lastBridge ? 'on' : (l.wallet_usdc ?? 0) >= c.min_bridge_usdc ? 'wait' : '');
  step('buy', lastBuy ? `${sqft(lastBuy.sqft)} sqft ${esc(lastBuy.label ?? lastBuy.name)} · ${ago(lastBuy.at)}` : A ? `${usd(A.available)} free` : '', lastBuy ? 'on' : A && A.available >= c.min_order_usd ? 'wait' : '');
  $('hmLoopState').className = `state ${holding ? 'on' : ''}`;
  $('hmLoopState').querySelector('b').textContent = holding ? 'holding' : f.armed ? 'armed' : 'standby';
  const items = [
    ...claims.map(x => ({ at: x.at, k: 'claim', what: `${sol(x.lamports)} SOL from the creator vault`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...swaps.map(x => ({ at: x.at, k: 'convert', what: `${sol(x.lamports)} SOL → ${usd(x.usdc)} USDC`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...bridges.map(x => ({ at: x.at, k: 'bridge', what: `${usd(x.usdc)} USDC → Parcl`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...orders.map(x => ({ at: x.at, k: 'buy', what: `${sqft(x.sqft)} sqft ${esc(x.city ?? x.name)} · ${usd(x.usd)}`, link: `<span class="mono">${esc(String(x.hash ?? '')).slice(0, 10)}</span>` })),
  ].sort((a, b) => b.at - a.at).slice(0, 7);
  $('hmActivity').innerHTML = items.map(x => `<li><span>${esc(x.k)}</span><em>${x.what}</em><b>${x.link} · ${ago(x.at)}</b></li>`).join('')
    || '<li class="empty"><svg viewBox="0 0 24 24"><path d="M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5"/></svg>Waiting for the first cycle.</li>';
  $('hmAccount').innerHTML = A ? ext(c.account_url, `parcl account #${A.id} ↗`) : c.wallet ? `owner ${ext(`https://solscan.io/account/${c.wallet}`, `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)} ↗`)}` : 'parcl account –';
  feedStrip(Ld);
  const newest = orders[0]?.at ?? 0;
  if (seenOrders != null && newest > seenOrders) for (const o of orders.filter(o => o.at > seenOrders).slice(0, 3)) scene.allocate({ sqft: o.sqft, label: o.label ?? o.name });
  seenOrders = newest;
}
setInterval(() => { if (location.pathname === '/' && engineData) renderHome(); }, 1000);

// ---------- the land page ----------
let landTimer = null;
const thumb = x => `<img class="thumb" src="/cities/${esc(String(x.name).toLowerCase())}.jpg" alt="" loading="lazy">`;
async function loadLand() {
  clearTimeout(landTimer);
  if (location.pathname !== '/land') return;
  let d;
  try { d = await engineState(0); } catch { landTimer = setTimeout(loadLand, 20_000); return; }
  const { config: c, live: l, ledger: L, land: Ld } = d;
  feedStrip(Ld);
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const holding = Ld.sqft > 0;
  setText('ldSqft', `${sqft(Ld.sqft)} sqft`);
  setText('ldValue', usd(Ld.notional));
  setText('ldColl', usd(Ld.collateral ?? 0));
  setText('ldMarkets', String((Ld.lots ?? []).length || 8));
  const st = $('ldStatus');
  st.innerHTML = holding ? `<b>Live</b> · ${Ld.cities} ${Ld.cities === 1 ? 'city' : 'cities'} · ${signed(Ld.upnl)} unrealized` : c.writes ? `<b>Armed${c.dry ? ' · dry run' : ''}</b> · No positions yet` : `<b>Pre-launch</b> · No positions yet`;
  st.classList.toggle('live', holding);
  const m0 = (Ld.lots ?? [])[0];
  setText('ldOracle', m0?.valid_until ? `Parcl Labs index · daily · next print in ${until(m0.valid_until)}` : 'Parcl Labs index · daily');
  setText('ldSideTitle', holding ? 'A footprint, marked daily.' : 'A footprint starts with the first cycle.');
  setText('ldSideText', holding
    ? `${sqft(Ld.sqft)} square feet across ${Ld.cities} ${Ld.cities === 1 ? 'city' : 'cities'}, worth ${usd(Ld.notional)} at today's index. Every position is long at ${c.leverage}x and marked once a day at the Parcl Labs print; the engine only ever buys.`
    : `No positions yet. When the engine runs a cycle, rewards are converted to USDC, bridged to Parcl, and the first city index positions open here${Ld.on_the_way_usd > 0 ? ` (${usd(Ld.on_the_way_usd)} already on the way)` : ''}.`);
  const lots = Ld.lots ?? [];
  $('ldLots').innerHTML = '<tr><th colspan="2">Market</th><th>Ticker</th><th class="num">Index price</th><th class="num">Today</th><th>30d</th><th class="num">Exposure</th></tr>' +
    (lots.map((x, i) => `<tr style="animation-delay:${i * 15}ms"><td style="width:76px">${thumb(x)}</td><td class="name">${esc(x.city)}${x.oracle_status !== 'Active' ? ` <span class="st">${esc(x.oracle_status)}</span>` : ''}</td><td><span class="ticker ${x.target ? '' : 'off'}">${esc(x.label)}</span></td><td class="num">$${num(x.price, 2)}</td><td class="num ${x.change_1d > 0 ? 'up' : x.change_1d < 0 ? 'down' : ''}">${pctS(x.change_1d)}</td><td><canvas class="spark" data-spark="${x.spark.join(',')}" width="144" height="40"></canvas></td><td class="num">${sqft(x.sqft)} sqft${x.sqft ? `<br><span class="muted">${usd(x.notional)} · ${signed(x.upnl)}</span>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Reading the markets…</td></tr>');
  drawSparks($('ldLots'));
  const A = l.account;
  $('ldLinks').innerHTML =
    row('Engine wallet · Parcl owner key', c.wallet ? `${acct(c.wallet)}${c.owner_hex ? `<br><span class="muted">0x${esc(c.owner_hex)}</span>` : ''}` : '<span class="muted">not armed yet</span>') +
    row('Parcl account', A ? `#${A.id} · ${ext(c.account_url, 'read it on the validator ↗')} · ${esc(A.mode)} margin${A.pending ? ' · pending activation' : ''}` : c.wallet ? '<span class="muted">none yet: created from the first bridge deposit (≥ 5 USDC + 1 USDC activation)</span>' : '<span class="muted">–</span>') +
    row('Collateral', A ? `${usd(A.collateral)} USDC · ${usd(A.available)} free · ${signed(Ld.upnl)} unrealized` : '<span class="muted">–</span>') +
    row('On the way', `${usd(l.wallet_usdc ?? 0)} USDC in the wallet · ${usd(l.bridge?.unclaimed_usdc ?? 0)} unclaimed on the bridge${l.bridge?.deposits_halted ? ' · <span class="muted">deposits halted</span>' : ''}`) +
    row('Bridge program (Solana)', c.bridge_program ? acct(c.bridge_program) : '<span class="muted">–</span>') +
    row('Target book', c.targets.map(x => `${esc(x.label)} ${Math.round(x.weight * 100)}%`).join(' · ') + ` · ${c.leverage}x · every ${Math.round(c.every_ms / 60000)} min`) +
    row('Chain', `${esc(c.chain)} · ${ext(c.validator + '/v1/markets', 'markets ↗')} · ${ext(c.app, 'trading app ↗')}`);
  const items = [
    ...L.claims.map(x => ({ at: x.at, step: 'claim', what: `${sol(x.lamports)} SOL from the creator vault`, link: solLink(x.sig) })),
    ...L.swaps.map(x => ({ at: x.at, step: 'convert', what: `${sol(x.lamports)} SOL → ${usd(x.usdc)} USDC`, link: solLink(x.sig) })),
    ...L.bridges.map(x => ({ at: x.at, step: 'bridge', what: `${usd(x.usdc)} USDC → Parcl bridge`, link: solLink(x.sig) })),
    ...L.orders.map(x => ({ at: x.at, step: x.kind === 'account' ? 'account' : 'buy', what: x.kind === 'account' ? `Parcl account ${x.account_id ? `#${x.account_id}` : ''} funded with ${usd(x.usd)}` : `${sqft(x.sqft)} sqft of ${esc(x.name)} at ~$${num(x.price, 2)}/sqft · ${usd(x.usd)}`, link: `<span class="mono" title="${esc(x.hash ?? '')}">${esc(String(x.hash ?? '').slice(0, 12))}…</span>` })),
    ...L.errors.map(x => ({ at: x.at, step: 'error', what: `${esc(x.step)}: ${esc(x.error)}`, link: '–', bad: true })),
  ].sort((a, b) => b.at - a.at).slice(0, 80);
  $('ldLedger').innerHTML = '<tr><th>Time</th><th>Step</th><th>What</th><th>Receipt</th></tr>' +
    (items.map((x, i) => `<tr style="animation-delay:${i * 15}ms"><td>${time(x.at)}</td><td><span class="st ${x.bad ? 'st-queued' : 'st-sent'}">${x.step}</span></td><td>${x.what}</td><td>${x.link}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No receipts yet. The first claim starts the loop.</td></tr>');
  setText('ldNote', c.writes
    ? `Armed${c.dry ? ' · dry run (logs only, nothing moves)' : ''}. The Parcl account is owned by the engine wallet's key; its positions are public on the validator, nothing is held by this site.`
    : `Not armed: the server has no engine key, so only the public side (vault, indices${A ? ', the Parcl account' : ''}) is live.`);
  landTimer = setTimeout(loadLand, 20_000);
}
function drawSparks(root) {
  for (const c of root.querySelectorAll('canvas[data-spark]')) {
    const v = c.dataset.spark.split(',').map(Number).filter(x => x > 0);
    const ctx = c.getContext('2d'), w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (v.length < 2) continue;
    const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
    ctx.beginPath();
    v.forEach((p, i) => { const x = (i / (v.length - 1)) * (w - 4) + 2, y = h - 4 - ((p - min) / span) * (h - 8); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = v.at(-1) >= v[0] ? '#2e7d4a' : '#c0392b'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  }
}

// ---------- stats ----------
let statsTimer = null;
async function loadStats() {
  clearTimeout(statsTimer);
  if (location.pathname !== '/stats') return;
  let d;
  try { d = await engineState(0); } catch { statsTimer = setTimeout(loadStats, 30_000); return; }
  const { totals: t, land: Ld, marks } = d;
  setText('stSqft', `${sqft(Ld.sqft)} sqft`);
  setText('stValue', usd(Ld.notional));
  setText('stClaimed', `${sol(t.claimed_lamports)} SOL`);
  setText('stBridged', usd(t.bridged_usdc));
  const m = marks ?? [];
  lineChart($('chSqft'), m.map(x => ({ x: x.at, y: x.sqft })), { fmt: v => `${sqft(v)} sqft`, axis: v => sqft(v), xfmt: hhmm, label: 'square feet' });
  lineChart($('chValue'), m.map(x => ({ x: x.at, y: x.notional })), { fmt: v => usd(v), axis: v => `$${num(v, 0)}`, xfmt: hhmm, label: 'position value' });
  lineChart($('chIndex'), m.map(x => ({ x: x.at, y: x.index })), { fmt: v => `$${num(v, 2)}/sqft`, axis: v => `$${num(v, 0)}`, xfmt: hhmm, label: 'USA index' });
  const lots = Ld.lots ?? [];
  $('stMarkets').innerHTML = '<tr><th>Market</th><th class="num">Index, $/sqft</th><th class="num">1d</th><th class="num">30d</th><th class="num">Funding /h</th><th class="num">Weight</th><th class="num">Held, sqft</th><th class="num">PnL</th></tr>' +
    (lots.map(x => `<tr><td><span class="ticker ${x.target ? '' : 'off'}">${esc(x.label)}</span> ${esc(x.city)}</td><td class="num">${num(x.price, 2)}</td><td class="num ${x.change_1d > 0 ? 'up' : x.change_1d < 0 ? 'down' : ''}">${pctS(x.change_1d)}</td><td class="num ${x.change_30d > 0 ? 'up' : x.change_30d < 0 ? 'down' : ''}">${pctS(x.change_30d)}</td><td class="num">${(x.funding_hourly * 100).toFixed(4)}%</td><td class="num">${Math.round(x.weight * 100)}%</td><td class="num">${sqft(x.sqft)}</td><td class="num ${x.upnl > 0 ? 'up' : x.upnl < 0 ? 'down' : ''}">${x.sqft ? signed(x.upnl) : '–'}</td></tr>`).join('')
      || '<tr><td colspan="8" class="empty">Reading the markets…</td></tr>');
  statsTimer = setTimeout(loadStats, 30_000);
}
addEventListener('resize', () => { if (location.pathname === '/stats') loadStats(); });

// ---------- rules ----------
async function loadRules() {
  try {
    const { config: c } = await engineState();
    setText('ldEvery', `Every ${Math.round(c.every_ms / 60000)} minutes. Target book: ${c.targets.map(x => `${x.label} ${Math.round(x.weight * 100)}%`).join(', ')}. Orders go to the market furthest under its weight first; a deposit needs ${c.min_bridge_usdc} USDC, an order ${c.min_order_usd} USD. Leverage ${c.leverage}x${c.leverage === 1 ? ': notional equals collateral, nothing borrowed' : ''}.`);
  } catch {}
}
let creditsLoaded = false;
async function loadCredits() {
  if (creditsLoaded) return;
  try {
    const c = await (await fetch('/cities/credits.json')).json();
    const names = { usa: 'USA', nyc: 'New York City', chicago: 'Chicago', losangeles: 'Los Angeles', miami: 'Miami', austin: 'Austin', washingtondc: 'Washington, DC', sanfrancisco: 'San Francisco' };
    $('credits').innerHTML = Object.entries(c).map(([k, v]) => `<li><b>${esc(names[k] ?? k)}</b> · ${ext(v.page, esc(v.title.replace('File:', '')))} · ${esc(v.artist || 'unknown')} · ${esc(v.license)}</li>`).join('');
    creditsLoaded = true;
  } catch {}
}

route();
engineState().catch(() => {});
