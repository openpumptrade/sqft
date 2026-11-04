// UI: routing, controls, live pool stream, wallet polling, the engine home and the land map.
import { deviceLabel, runBench } from './bench.js';
import { barChart, lineChart } from './charts.js';
import { API } from './config.js';
import { LandScene } from './land.js';
import { floatUp, pulse, ripples, roll, scramble, toast } from './fx.js';
import { Miner as Crew, short } from './miner.js';

const $ = id => document.getElementById(id);
const crew = new Crew();
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAGES = ['/', '/survey', '/stats', '/leaderboard', '/rounds', '/ledger', '/benchmark', '/land', '/rules'];

let pool = null;       // latest /api/state
let you = null;        // latest /api/wallet/:addr
let board = 'round';
let shownHash = null;
let seen = { accepted: 0, rejected: 0 };
let lastStatus = 'idle';
let earned = null;     // balance + pending + paid at the last poll, to spot new earnings
const R = (id, v) => roll($(id), v);

ripples('.go, .icon-btn, .tabs button');

const scene = new LandScene($('pit'));
globalThis.__land = scene;   // for debugging from the console

// ---------- formatting ----------
const sol = lamports => (lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
// Survey work is counted in points: one hash is one point.
function rate(ops) {
  let v = ops;
  const units = ['pts/s', 'K pts/s', 'M pts/s', 'G pts/s', 'T pts/s'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return [v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0), units[i]];
}
const points = n => {
  let v = Number(n);
  if (!v) return '0 pts';
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}${units[i]} pts`;
};
const num = (v, d = 2) => (+Number(v).toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const sqft = v => { v = Number(v) || 0; return v === 0 ? '0' : v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : num(v, 0); };
const usd = v => `${v < 0 ? '−' : ''}$${num(Math.abs(Number(v) || 0), Math.abs(v) < 100 ? 2 : 0)}`;
const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), 2)}`;
const pctS = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(Math.abs(v) < 0.001 ? 2 : 2)}%`;
const time = t => new Date(t).toLocaleTimeString([], { hour12: false });
const pct = x => `${(x * 100).toFixed(x < 0.1 ? 2 : 1)}%`;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function setText(id, v) { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; }

// Tick-row progress bar, lit up to `fraction`; the leading tick pulses.
function segments(el, fraction, n = 24) {
  if (el.children.length !== n) el.innerHTML = '<span></span>'.repeat(n);
  const f = Math.max(0, Math.min(1, fraction));
  const at = Math.min(n - 1, Math.floor(f * n));
  [...el.children].forEach((s, i) => { s.className = i < at ? 'on' : i === at && f > 0 ? 'at' : ''; });
}

// ---------- routing ----------
// On the engine and survey views the map is the stage; other pages open as a drawer over it.
function route() {
  const roundId = location.pathname.match(/^\/rounds\/(\d+)$/)?.[1];
  const path = roundId ? '/rounds' : PAGES.includes(location.pathname) ? location.pathname : '/';
  const stage = path === '/' || path === '/survey';
  document.querySelector('[data-view="/"]').hidden = path !== '/';
  document.querySelector('[data-view="/survey"]').hidden = path !== '/survey';
  document.querySelector('[data-view="page"]').hidden = stage;
  document.body.classList.toggle('backdrop', !stage);
  scene.setBackdrop(!stage);
  for (const a of document.querySelectorAll('.dock a')) a.classList.toggle('on', a.getAttribute('href') === path);
  if (!stage) {
    for (const s of document.querySelectorAll('[data-page]')) s.hidden = s.dataset.page !== path;
    document.querySelector('.view.page').scrollTop = 0;
    renderPool();
  }
  if (path === '/') loadHome();
  if (path === '/stats') loadStats();
  if (path === '/rounds') roundId ? loadRound(Number(roundId)) : loadRounds();
  if (path === '/benchmark') loadBench();
  if (path === '/land') loadLand();
  closeSettings();
  enter(document.querySelector(path === '/' ? '[data-view="/"]' : path === '/survey' ? '[data-view="/survey"]' : '[data-view="page"]'));
  requestAnimationFrame(placeMap);
}

// The map is a framed panel that sits between the hero's controls and the deeds (document coordinates, so it scrolls with the page).
const mapEl = $('pit'), hintEl = document.querySelector('.hint');
function placeMap() {
  const view = document.querySelector('.view.stage:not([hidden])');
  let top, bottom;
  if (view) {
    const ctl = view.querySelector('.control'), cards = ['.net', '.rig', '.earn'].map(c => view.querySelector(c)).filter(Boolean);
    top = ctl.getBoundingClientRect().bottom + scrollY + 12;
    bottom = Math.min(...cards.map(c => c.getBoundingClientRect().top)) + scrollY - 12;
  } else if (!mapEl.dataset.placed) { top = scrollY + innerHeight * 0.4; bottom = scrollY + innerHeight * 0.74; }
  else return;
  if (bottom - top < 100) bottom = top + 100;
  const pad = innerWidth < 720 ? 12 : 20, width = document.documentElement.clientWidth - pad * 2;
  const next = `${Math.round(top)}|${Math.round(bottom)}|${width}`;
  if (mapEl.dataset.rect === next) return;
  mapEl.dataset.rect = next;
  Object.assign(mapEl.style, { top: `${Math.round(top)}px`, left: `${pad}px`, width: `${width}px`, height: `${Math.round(bottom - top)}px` });
  mapEl.dataset.placed = '1';
  scene.resize();   // ResizeObserver only fires on render; a background tab would keep the old buffer
  if (hintEl) Object.assign(hintEl.style, { top: `${Math.round(top) + 8}px`, left: `${pad + 10}px` });
}
addEventListener('resize', placeMap);
setInterval(placeMap, 1500);

// Staggered entrance for the visible view, and scramble its static labels.
function enter(view) {
  pulse(view, 'enter');
  for (const el of view.querySelectorAll('.card-head .label, .sheet article:not([hidden]) h1')) {
    if (el.closest('[hidden]')) continue;
    scramble(el, el.dataset.text ?? el.textContent, el.tagName === 'H1' ? 700 : 480);
  }
}
function go(path) {
  history.pushState(null, '', path);
  route();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-nav]');
  if (!e.target.closest('.control')) closeSettings();
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
addEventListener('popstate', route);
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

// ---------- stats ----------
let statsTimer = null;
async function loadStats() {
  clearTimeout(statsTimer);
  if (location.pathname !== '/stats') return;
  let st, en;
  try { [st, en] = await Promise.all([getJson('/api/stats'), getJson('/api/engine')]); } catch { return; }
  const marks = en.marks ?? [];
  lineChart($('chSqft'), marks.map(m => ({ x: m.at, y: m.sqft })), { fmt: v => `${sqft(v)} sqft`, axis: v => sqft(v), xfmt: hhmm, label: 'square feet' });
  lineChart($('chValue'), marks.map(m => ({ x: m.at, y: m.notional })), { fmt: v => usd(v), axis: v => `$${num(v, 0)}`, xfmt: hhmm, label: 'land value' });
  R('stPaid', sol(st.totals.paid));
  R('stRounds', st.totals.rounds);
  R('stWallets', st.totals.wallets);
  setText('stWork', points(st.totals.work));
  const rateFmt = v => rate(v).join(' ');
  const shortRate = v => { const [n, u] = rate(v); return `${+Number(n).toFixed(1)}${u[0] === 'p' ? '' : u[0]}`; };
  lineChart($('chHash'), st.samples.map(p => ({ x: p.at, y: p.hashrate })), { fmt: rateFmt, axis: shortRate, xfmt: hhmm, label: 'survey rate' });
  lineChart($('chMiners'), st.samples.map(p => ({ x: p.at, y: p.miners })), { fmt: v => String(Math.round(v)), xfmt: hhmm, label: 'active surveyors', integer: true });
  barChart($('chPot'), st.rounds.map(r => ({ label: `#${r.id}`, value: r.reward / 1e9, sub: `${r.miners} surveyors` })), { fmt: v => `${+v.toFixed(4)}`, label: 'SOL', every: Math.ceil(st.rounds.length / 6) || 1 });
  barChart($('chDays'), st.days.map(d => ({ label: d.day.slice(5), value: d.paid / 1e9, sub: `${d.rounds} rounds` })), { fmt: v => `${+v.toFixed(4)}`, label: 'SOL paid', every: Math.ceil(st.days.length / 7) || 1 });
  $('daysTable').innerHTML = '<tr><th>Day</th><th class="num">Rounds</th><th class="num">Stakes</th><th class="num">Pot, SOL</th><th class="num">Paid, SOL</th></tr>' +
    ([...st.days].reverse().map(d => `<tr><td>${d.day}</td><td class="num">${d.rounds}</td><td class="num">${d.proofs}</td><td class="num">${sol(d.pot)}</td><td class="num">${sol(d.paid)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">No days recorded yet.</td></tr>');
  statsTimer = setTimeout(loadStats, 30_000);
}
addEventListener('resize', () => { if (location.pathname === '/stats') loadStats(); });

// ---------- rounds ----------
let roundsBefore = Infinity, roundsAll = false;
async function loadRounds(more = false) {
  $('roundsList').hidden = false; $('roundDetail').hidden = true;
  if (!more) roundsBefore = Infinity;
  const all = roundsAll ? '&all=1' : '';
  let data;
  try { data = await getJson(`/api/rounds?limit=30${all}${roundsBefore < Infinity ? `&before=${roundsBefore}` : ''}`); } catch { return; }
  const rows = data.rounds.map((r, i) => `<tr data-round="${r.id}" style="animation-delay:${i * 20}ms"><td>#${r.id}</td><td>${new Date(r.closed_at).toLocaleString([], { hour12: false })}</td><td class="num">${r.miners}</td><td class="num">${points(r.work)}</td><td class="num">${sol(r.reward)}</td><td class="num">${r.payouts}</td></tr>`).join('');
  const head = '<tr><th>Round</th><th>Closed</th><th class="num">Surveyors</th><th class="num">Surveyed</th><th class="num">Pot, SOL</th><th class="num">Payouts</th></tr>';
  if (more) $('roundsTable').insertAdjacentHTML('beforeend', rows);
  else $('roundsTable').innerHTML = head + (rows || '<tr><td colspan="6" class="empty">No rounds settled yet.</td></tr>');
  if (data.rounds.length) roundsBefore = data.rounds.at(-1).id;
  $('roundsMore').hidden = !data.more;
}
$('roundsMore').addEventListener('click', () => loadRounds(true));
$('roundsAll').addEventListener('change', e => { roundsAll = e.target.checked; loadRounds(); });
$('roundsTable').addEventListener('click', e => { const tr = e.target.closest('tr[data-round]'); if (tr) go(`/rounds/${tr.dataset.round}`); });
async function loadRound(id) {
  $('roundsList').hidden = true; $('roundDetail').hidden = false;
  let r;
  const res = await fetch(`${API}/api/rounds/${id}`);
  if (!res.ok) { $('rdTitle').textContent = `Round #${id}`; $('rdWhen').textContent = 'Not found.'; return; }
  r = await res.json();
  $('rdTitle').textContent = `Round #${r.id}`;
  $('rdWhen').textContent = `${new Date(r.started_at).toLocaleString([], { hour12: false })} → ${new Date(r.closed_at).toLocaleTimeString([], { hour12: false })} · ${Math.round((r.closed_at - r.started_at) / 1000)}s`;
  R('rdPot', sol(r.reward)); R('rdMiners', r.miners); setText('rdWork', points(r.work)); R('rdPayouts', r.payouts.length);
  $('rdPrev').hidden = r.prev == null; $('rdNext').hidden = r.next == null;
  if (r.prev != null) $('rdPrev').href = `/rounds/${r.prev}`;
  if (r.next != null) $('rdNext').href = `/rounds/${r.next}`;
  const me = walletInput.value.trim();
  $('rdShares').innerHTML = '<tr><th>#</th><th>Wallet</th><th class="num">Surveyed</th><th class="num">Share</th><th class="num">Reward, SOL</th></tr>' +
    (r.shares.map((s, i) => `<tr class="${s.wallet === me ? 'me' : ''}"><td>${i + 1}</td><td>${short(s.wallet)}</td><td class="num">${points(s.work)}</td><td class="num">${pct(s.share)}<div class="share-bar" style="width:${Math.max(2, s.share * 100)}%"></div></td><td class="num">${sol(s.lamports)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Nobody surveyed in this round.</td></tr>');
  $('rdPayoutTable').innerHTML = '<tr><th>Wallet</th><th class="num">Amount, SOL</th><th>Status</th><th>Signature</th></tr>' +
    (r.payouts.map(p => `<tr><td>${short(p.wallet)}</td><td class="num">${sol(p.lamports)}</td><td><span class="st st-${p.status ?? 'sim'}">${STATUS[p.status] ?? 'booked'}</span></td><td>${sigLink(p)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">No balance crossed the threshold at this close.</td></tr>');
}

// ---------- benchmark ----------
let benchResult = null, benching = false;
async function loadBench() {
  setText('bnDevice', deviceLabel());
  renderBenchButton();
  let data;
  try { data = await getJson('/api/bench'); } catch { return; }
  $('benchTable').innerHTML = '<tr><th>#</th><th>Device</th><th>GPU</th><th class="num">Threads</th><th class="num">CPU</th><th class="num">GPU</th><th class="num">Total</th></tr>' +
    (data.results.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.device)}</td><td>${esc(b.gpu ?? '–')}</td><td class="num">${b.threads}</td><td class="num">${rate(b.cpu).join(' ')}</td><td class="num">${b.gpu_rate == null ? '–' : rate(b.gpu_rate).join(' ')}</td><td class="num">${rate(b.cpu + (b.gpu_rate ?? 0)).join(' ')}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No devices tested yet. Run the benchmark and add yours.</td></tr>');
}
function renderBenchButton() {
  const running = crew.status === 'mining' || crew.status === 'starting';
  $('bnGo').disabled = benching || running;
  $('bnGo').textContent = benching ? 'Measuring…' : running ? 'Stop surveying to benchmark' : benchResult ? 'Run again' : 'Run benchmark';
}
$('bnGo').addEventListener('click', async () => {
  if (benching) return;
  benching = true; benchResult = null;
  $('bnResult').hidden = true; $('bnNote').textContent = '';
  renderBenchButton();
  try {
    const r = await runBench({
      threads: crew.maxThreads, gpu: !!navigator.gpu && !$('gpu').disabled,
      onTick: ({ phase, rate: v, progress }) => {
        setText('bnPhase', phase === 'cpu' ? `CPU · ${crew.maxThreads} threads` : phase === 'gpu' ? 'GPU · WebGPU' : phase);
        const [n, u] = rate(v); R('bnRate', n); setText('bnUnit', u);
        segments($('bnProgress'), progress);
        calc(v, true);
      },
    });
    benchResult = r;
    setText('bnPhase', 'Done');
    const [n, u] = rate(r.cpu + (r.gpu ?? 0)); R('bnRate', n); setText('bnUnit', u);
    R('bnCpu', rate(r.cpu).join(' ')); setText('bnCpuSub', `${r.threads} threads`);
    R('bnGpu', r.gpu == null ? '–' : rate(r.gpu).join(' ')); setText('bnGpuSub', r.gpu == null ? (r.gpuError ?? 'not available') : (r.gpuName ?? 'WebGPU'));
    $('bnResult').hidden = false;
    calc();
  } catch (e) {
    setText('bnPhase', 'Failed'); setText('bnNote', e.message);
  }
  benching = false;
  renderBenchButton();
});
$('bnSave').addEventListener('click', async () => {
  if (!benchResult) return;
  const body = { device: deviceLabel(), gpu: benchResult.gpuName ?? null, threads: benchResult.threads, cpu: benchResult.cpu, gpu_rate: benchResult.gpu ?? null };
  const r = await fetch(`${API}/api/bench`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  toast(d.saved ? `Saved · #${d.rank} on the table` : 'Already on the table', d.saved ? 'Your device is listed for comparison.' : 'A faster result for this device is already there.');
  loadBench();
});
for (const id of ['cPot', 'cMiners', 'cRate']) $(id).addEventListener('input', () => calc());
function calc(liveRate = null, measuring = false) {
  const mine = liveRate ?? (benchResult ? benchResult.cpu + (benchResult.gpu ?? 0) : 0);
  const pot = Number($('cPot').value) || 0, others = Number($('cMiners').value) || 0, each = (Number($('cRate').value) || 0) * 1e6;
  const total = mine + others * each;
  const share = total ? mine / total : 0;
  const earn = share * pot;
  $('cSteps').className = `calc-steps ${measuring ? 'live' : ''}`;
  $('cSteps').innerHTML =
    `<li>Your rate <b>${rate(mine).join(' ')}</b></li>` +
    `<li>Everyone else: ${others} × ${rate(each).join(' ')} = <b>${rate(others * each).join(' ')}</b></li>` +
    `<li>Your share: ${rate(mine).join(' ')} ÷ ${rate(total).join(' ')} = <b>${pct(share)}</b></li>` +
    `<li>Of a ${pot} SOL pot: <b>${earn.toLocaleString(undefined, { maximumFractionDigits: 5 })} SOL</b> per round</li>`;
  R('bnEarn', earn.toLocaleString(undefined, { maximumFractionDigits: 4 }));
  setText('bnEarnSub', `SOL per round at ${pct(share)}`);
}

// ---------- the land page ----------
let landTimer = null;
function lotName(x) { return esc(x.city ?? x.name ?? ''); }
async function loadLand() {
  clearTimeout(landTimer);
  if (location.pathname !== '/land') return;
  let d;
  try { d = await getJson('/api/engine'); } catch { return; }
  const { config: c, live: l, totals: t, ledger: L, land: Ld } = d;
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  R('ldSqft', sqft(Ld.sqft)); setText('ldSqftSub', `across ${Ld.cities} ${Ld.cities === 1 ? 'city' : 'cities'}${Ld.reserved_sqft > 0 ? ` · ${sqft(Ld.reserved_sqft)} sqft under contract` : ''}`);
  R('ldValue', usd(Ld.notional)); setText('ldValueSub', `at today's index · ${usd(Ld.equity)} equity on Parcl`);
  R('ldPnl', (Ld.upnl < 0 ? '−' : '') + usd(Math.abs(Ld.upnl)).replace('−', '')); setText('ldPnlSub', Ld.notional ? `${pctS(Ld.upnl / Math.max(1e-9, Ld.notional - Ld.upnl))} since entry` : 'since entry');
  R('ldUsd', usd(t.bridged_usdc)); setText('ldUsdSub', `bridged to Parcl · ${sol(t.claimed_lamports)} SOL claimed`);
  setText('ldEvery', `Every ${Math.round(c.every_ms / 60000)} minutes. Target book: ${c.targets.map(x => `${x.label} ${Math.round(x.weight * 100)}%`).join(', ')}. Orders go to the lot furthest under its weight first; a deposit needs ${c.min_bridge_usdc} USDC, an order ${c.min_order_usd} USD. Leverage ${c.leverage}x${c.leverage === 1 ? ': notional equals collateral, nothing borrowed' : ''}.`);
  const A = l.account;
  $('ldLinks').innerHTML =
    row('Engine wallet · Parcl owner key', c.wallet ? `${acct(c.wallet)}${c.owner_hex ? `<br><span class="muted">0x${esc(c.owner_hex)}</span>` : ''}` : '<span class="muted">not armed yet</span>') +
    row('Parcl account', A ? `#${A.id} · ${ext(c.account_url, 'read it on the validator ↗')} · ${esc(A.mode)} margin${A.pending ? ' · pending activation' : ''}` : c.wallet ? '<span class="muted">none yet: created from the first bridge deposit (≥ 5 USDC + 1 USDC activation)</span>' : '<span class="muted">–</span>') +
    row('Collateral', A ? `${usd(A.collateral)} USDC · ${usd(A.available)} free · ${usd(Ld.upnl)} unrealized` : '<span class="muted">–</span>') +
    row('On the way', `${usd(l.wallet_usdc ?? 0)} USDC in the wallet · ${usd(l.bridge?.unclaimed_usdc ?? 0)} unclaimed on the bridge${l.bridge?.deposits_halted ? ' · <span class="muted">deposits halted</span>' : ''}`) +
    row('Bridge program (Solana)', c.bridge_program ? acct(c.bridge_program) : '<span class="muted">–</span>') +
    row('Chain', `${esc(c.chain)} · ${ext(c.validator + '/v1/markets', 'markets ↗')} · ${ext(c.app, 'trading app ↗')}`);
  const lots = Ld.lots ?? [];
  $('ldLots').innerHTML = '<tr><th>Lot</th><th class="num">Index, $/sqft</th><th class="num">1d</th><th class="num">30d</th><th>Trend</th><th class="num">Weight</th><th class="num">Held, sqft</th><th class="num">Value</th><th class="num">PnL</th><th class="num">Funding /h</th></tr>' +
    (lots.map((x, i) => `<tr style="animation-delay:${i * 15}ms"><td><span class="lot ${x.target ? '' : 'off'}">${esc(x.label)}</span>${lotName(x)}${x.oracle_status !== 'Active' ? ` <span class="st">${esc(x.oracle_status)}</span>` : ''}</td><td class="num">${num(x.price, 2)}</td><td class="num ${x.change_1d > 0 ? 'up' : x.change_1d < 0 ? 'down' : ''}">${pctS(x.change_1d)}</td><td class="num ${x.change_30d > 0 ? 'up' : x.change_30d < 0 ? 'down' : ''}">${pctS(x.change_30d)}</td><td><canvas class="spark" data-spark="${x.spark.join(',')}" width="144" height="40"></canvas></td><td class="num">${Math.round(x.weight * 100)}%</td><td class="num">${sqft(x.sqft)}</td><td class="num">${usd(x.notional)}</td><td class="num ${x.upnl > 0 ? 'up' : x.upnl < 0 ? 'down' : ''}">${x.sqft ? signed(x.upnl) : '–'}</td><td class="num">${(x.funding_hourly * 100).toFixed(4)}%</td></tr>`).join('')
      || '<tr><td colspan="10" class="empty">Reading the markets…</td></tr>');
  drawSparks($('ldLots'));
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
    ctx.strokeStyle = v.at(-1) >= v[0] ? '#2f7d3a' : '#b8321f'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  }
}

// ---------- engine home ----------
let homeTimer = null, homeData = null, seenOrders = null;
async function loadHome() {
  clearTimeout(homeTimer);
  if (location.pathname !== '/') return;
  try { homeData = await getJson('/api/engine'); } catch { homeTimer = setTimeout(loadHome, 15_000); return; }
  renderHome();
  homeTimer = setTimeout(loadHome, 15_000);
}
function renderHome() {
  const d = homeData; if (!d || location.pathname !== '/') return;
  const { config: c, live: l, totals: t, ledger: L, flow: f, land: Ld } = d;
  const now = Date.now();
  const holding = Ld.sqft > 0;
  R('hmSqft', sqft(Ld.sqft));
  setText('hmSqftSub', holding ? `across ${Ld.cities} ${Ld.cities === 1 ? 'city' : 'cities'}${Ld.reserved_sqft > 0 ? ` · ${sqft(Ld.reserved_sqft)} under contract` : ''}` : Ld.reserved_sqft > 0 ? `${sqft(Ld.reserved_sqft)} sqft under contract` : 'no lots yet');
  R('hmValue', usd(Ld.notional));
  setText('hmValueSub', holding ? `at today's index · ${signed(Ld.upnl)} unrealized` : Ld.index ? `USA index $${num(Ld.index, 2)}/sqft` : "at today's index");
  R('hmEquity', usd(Ld.equity));
  setText('hmEquitySub', l.account ? `USDC collateral + PnL · ${usd(l.account.available)} free` : Ld.on_the_way_usd > 0 ? `${usd(Ld.on_the_way_usd)} on the way to Parcl` : 'USDC collateral + PnL');
  R('hmSol', sol(t.claimed_lamports));
  setText('hmSolSub', `SOL claimed · ${usd(t.bridged_usdc)} bridged`);
  $('hmState').textContent = f.armed ? (c.dry ? 'dry run' : 'live') : holding ? 'live' : 'standby';
  $('hmState').style.color = (f.armed && !c.dry) || holding ? '' : 'var(--accent)';
  if (f.next_run) { setText('hmLeft', until(f.next_run)); segments($('hmRuler'), 1 - Math.max(0, f.next_run - now) / f.cycle_ms); }
  else { setText('hmLeft', `every ${Math.round(f.cycle_ms / 60000)} min`); segments($('hmRuler'), 0); }
  const vault = l.vault;
  setText('hmVault', vault ? `vault: ${vault.claimable_sol.toFixed(4)} SOL claimable${f.oracle_valid_until ? ` · index valid ${until(f.oracle_valid_until)}` : ''}` : c.creator ? 'vault: reading…' : 'vault: creator wallet not set');
  // the loop
  const swaps = L.swaps ?? [], claims = L.claims ?? [], bridges = L.bridges ?? [], orders = (L.orders ?? []).filter(o => o.kind === 'buy');
  const lastSwap = swaps[0], lastClaim = claims[0], lastBridge = bridges[0], lastBuy = orders[0];
  const step = (n, name, what, state, cls) => `<li class="${cls}"><b>${n}</b><span>${name}<small>${what}</small></span><em>${state}</em></li>`;
  const ready = vault && vault.claimable_sol >= 0.01;
  const A = l.account;
  $('hmLoop').innerHTML =
    step('01', 'Claim creator rewards', lastClaim ? `${sol(lastClaim.lamports)} SOL · ${ago(lastClaim.at)}` : vault ? `${vault.claimable_sol.toFixed(4)} SOL waiting in the vault` : 'pump.fun creator vault → engine wallet', ready ? 'ready' : lastClaim ? 'done' : 'waiting', ready ? 'wait' : lastClaim ? 'on' : '') +
    step('02', 'Convert to USDC', lastSwap ? `${sol(lastSwap.lamports)} SOL → ${usd(lastSwap.usdc)} · ${ago(lastSwap.at)}` : 'everything above the gas reserve, through Jupiter', lastSwap ? 'done' : 'waiting', lastSwap ? 'on' : '') +
    step('03', 'Bridge to Parcl', lastBridge ? `${usd(lastBridge.usdc)} USDC · ${ago(lastBridge.at)}` : (l.wallet_usdc ?? 0) > 0 ? `${usd(l.wallet_usdc)} USDC in the wallet, minimum ${c.min_bridge_usdc} per deposit` : 'USDC → the bridge program, credited to this key', lastBridge ? 'done' : (l.wallet_usdc ?? 0) >= c.min_bridge_usdc ? 'ready' : 'waiting', lastBridge ? 'on' : (l.wallet_usdc ?? 0) >= c.min_bridge_usdc ? 'wait' : '') +
    step('04', 'Buy land', lastBuy ? `${sqft(lastBuy.sqft)} sqft of ${esc(lastBuy.name)} · ${usd(lastBuy.usd)} · ${ago(lastBuy.at)}` : A ? `${usd(A.available)} USDC free on account #${A.id}` : `long ${c.targets.length} city indices at ${c.leverage}x, IOC market orders`, lastBuy ? 'done' : A && A.available >= c.min_order_usd ? 'ready' : 'waiting', lastBuy ? 'on' : A && A.available >= c.min_order_usd ? 'wait' : '') +
    step('05', 'Hold', holding ? `${sqft(Ld.sqft)} sqft · ${usd(Ld.notional)} marked daily by the Parcl Labs index` : 'positions marked once a day at 7:50 AM ET', holding ? 'holding' : 'idle', holding ? 'on' : '');
  $('hmLoopState').className = `state ${holding ? 'mining' : ''}`;
  $('hmLoopState').querySelector('b').textContent = holding ? 'holding' : f.armed ? 'armed' : 'standby';
  // lots
  const lots = (Ld.lots ?? []).filter(x => x.target || x.sqft > 0);
  $('hmLots').innerHTML = lots.map(x => `<li class="${x.sqft > 0 ? '' : 'empty'}"><span>${esc(x.label)}</span><em>${sqft(x.sqft)} sqft<small>$${num(x.price, 0)}/sqft</small></em><b class="${x.change_1d > 0 ? 'up' : x.change_1d < 0 ? 'down' : ''}">${pctS(x.change_1d)}</b></li>`).join('')
    || '<li class="empty"><span>–</span><em>reading the markets…</em><b></b></li>';
  // receipts
  const items = [
    ...claims.map(x => ({ at: x.at, k: 'claim', what: `${sol(x.lamports)} SOL`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...swaps.map(x => ({ at: x.at, k: 'convert', what: `${sol(x.lamports)} SOL → ${usd(x.usdc)}`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...bridges.map(x => ({ at: x.at, k: 'bridge', what: `${usd(x.usdc)} USDC → Parcl`, link: ext(`https://solscan.io/tx/${x.sig}`, 'solscan ↗') })),
    ...orders.map(x => ({ at: x.at, k: 'buy', what: `${sqft(x.sqft)} sqft ${esc(x.label ?? x.name)} · ${usd(x.usd)}`, link: `<span class="mono">${esc(String(x.hash ?? '')).slice(0, 10)}</span>` })),
  ].sort((a, b) => b.at - a.at).slice(0, 5);
  $('hmReceipts').innerHTML = items.map(x => `<li><span>${esc(x.k)}</span><em>${x.what}</em><b>${x.link}</b></li>`).join('') || '<li class="empty">No receipts yet. The first claim starts the loop.</li>';
  $('hmAccount').innerHTML = A ? ext(c.account_url, `parcl account #${A.id} ↗`) : c.wallet ? `owner ${ext(`https://solscan.io/account/${c.wallet}`, `${c.wallet.slice(0, 4)}…${c.wallet.slice(-4)} ↗`)}` : 'parcl account –';
  // caption + the map follows the book
  setText('figCap', `${sqft(Ld.sqft)} sqft`);
  setText('figSlots', holding ? `${Ld.cities} ${Ld.cities === 1 ? 'lot' : 'lots'} · ${usd(Ld.notional)}` : Ld.reserved_sqft > 0 ? `${sqft(Ld.reserved_sqft)} sqft under contract` : 'no lots yet');
  setText('figIndex', Ld.index ? `USA index $${num(Ld.index, 2)}/sqft` : 'USA index –');
  scene.setLots((Ld.lots ?? []).map(x => ({ key: x.name, label: x.label, sqft: x.sqft, reserved: (Ld.reserved.find(r => r.name === x.name)?.sqft ?? 0) })));
  scene.setActivity({ running: holding || f.armed, level: Math.min(1, Math.log2(1 + Ld.sqft * 4) / 8) });
  // a new buy since the last render sends the surveyor out
  const newest = orders[0]?.at ?? 0;
  if (seenOrders != null && newest > seenOrders) for (const o of orders.filter(o => o.at > seenOrders).slice(0, 3)) scene.allocate({ sqft: o.sqft, label: o.label ?? o.name });
  seenOrders = newest;
}
setInterval(() => { if (location.pathname === '/' && homeData) renderHome(); }, 1000);

// ---------- controls ----------
const walletInput = $('wallet');
walletInput.value = load('wallet') ?? '';
walletInput.addEventListener('input', () => {
  const v = walletInput.value.trim();
  walletInput.classList.toggle('invalid', v !== '' && !WALLET.test(v));
  earned = null;
  if (WALLET.test(v)) { store('wallet', v); pollWallet(); }
});

function slider(id, value, onInput) {
  const el = $(id);
  const paint = () => el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  el.value = value;
  paint();
  el.addEventListener('input', () => { paint(); onInput(Number(el.value)); });
}
$('threads').max = crew.maxThreads;
slider('threads', crew.threads, v => crew.setThreads(v));
slider('cpuDuty', crew.cpuDuty * 100, v => crew.setCpuDuty(v / 100));
slider('gpuDuty', crew.gpuDuty * 100, v => crew.setGpuDuty(v / 100));
$('gpu').addEventListener('change', e => crew.setGpu(e.target.checked));
setText('cores', `${navigator.hardwareConcurrency || '?'} cores`);
if (!navigator.gpu) {
  $('gpu').disabled = true;
  setText('gpuInfo', 'WebGPU is not available in this browser. Try a recent Chrome, Edge or Safari.');
}

const COMING_SOON = true;
function toggleSurvey() {
  if (COMING_SOON) return;
  if (crew.status === 'mining' || crew.status === 'starting') return crew.stop();
  const v = walletInput.value.trim();
  if (!WALLET.test(v)) {
    walletInput.classList.remove('invalid');
    void walletInput.offsetWidth;
    walletInput.classList.add('invalid');
    walletInput.focus();
    return;
  }
  crew.start(v);
}
$('go').addEventListener('click', toggleSurvey);
walletInput.addEventListener('keydown', e => { if (e.key === 'Enter') toggleSurvey(); });
function closeSettings() {
  $('settings').hidden = true;
  $('settingsBtn').setAttribute('aria-expanded', 'false');
}
$('settingsBtn').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
});
addEventListener('keydown', e => { if (e.key === 'Escape') { closeSettings(); if (document.body.classList.contains('backdrop')) go('/'); } });

document.querySelectorAll('[data-board]').forEach(b => b.addEventListener('click', () => {
  board = b.dataset.board;
  document.querySelectorAll('[data-board]').forEach(x => x.classList.toggle('on', x === b));
  renderBoard();
}));

// ---------- the crew (browser side quest) ----------
crew.onChange(renderCrew);

function renderCrew() {
  const running = crew.status === 'mining' || crew.status === 'starting';
  if (crew.status !== lastStatus) {
    if (crew.status === 'mining') toast('Survey started', `${crew.threads} CPU thread${crew.threads > 1 ? 's' : ''}${crew.gpuEnabled ? ' + GPU' : ''} · ${short(crew.wallet)}`);
    if (crew.status === 'idle' && lastStatus === 'mining') toast('Survey stopped', `${crew.accepted} stakes accepted this session`);
    if (crew.status === 'error') toast('Could not start', crew.error ?? '', 'bad');
    lastStatus = crew.status;
  }
  document.body.classList.toggle('is-lending', crew.status === 'mining');
  $('go').textContent = COMING_SOON ? 'Coming soon' : running ? 'Stop surveying' : 'Start surveying';
  $('go').classList.toggle('stop', running);
  walletInput.disabled = running;
  if (location.pathname === '/benchmark') renderBenchButton();
  const st = $('status');
  st.className = `state ${crew.status === 'mining' ? 'on' : crew.status === 'error' ? 'err' : ''}`;
  st.querySelector('b').textContent = crew.status === 'mining' ? 'surveying' : crew.status;

  setText('threadsVal', crew.threads);
  setText('cpuDutyVal', `${Math.round(crew.cpuDuty * 100)}%`);
  setText('gpuDutyVal', `${Math.round(crew.gpuDuty * 100)}%`);
  $('gpu').checked = crew.gpuEnabled;
  setText('gpuState', crew.gpuEnabled ? 'on' : 'off');
  if (crew.gpuName && $('gpuInfo').textContent.indexOf(crew.gpuName) < 0) toast('GPU ready', `${crew.gpuName} · self-test passed`);
  if (crew.gpuName) setText('gpuInfo', `GPU: ${crew.gpuName} · self-test passed`);
  if (crew.gpuError) setText('gpuInfo', crew.gpuError);

  const [r, u] = rate(crew.hashrate);
  R('rate', r);
  setText('rateUnit', u);
  R('diff', crew.ticket?.difficulty ?? '–');
  R('proofs', crew.accepted);
  setText('rej', `${crew.rejected} rejected`);

  $('log').innerHTML = crew.log.slice(0, 4)
    .map(l => `<li class="${l.tone}">${time(l.at)}  ${esc(l.text)}</li>`).join('');

  // the map: every accepted stake plants one on a lot.
  if (location.pathname !== '/') scene.setActivity({ running: crew.status === 'mining', level: Math.min(1, (Math.log10(Math.max(1, crew.hashrate)) - 3) / 6) });
  for (; seen.accepted < crew.accepted; seen.accepted++) {
    scene.plant();
    floatUp($('proofs').parentElement, `+${points(2 ** (crew.lastProof?.difficulty ?? 0))}`);
    pulse($('proofs').parentElement);
  }
  seen.rejected = crew.rejected;

  if (crew.lastProof && crew.lastProof.hash !== shownHash) {
    shownHash = crew.lastProof.hash;
    const hex = crew.lastProof.hash;
    let i = 0;
    while (i < hex.length && hex[i] === '0') i++;
    const el = $('digest');
    scramble(el, hex, 420);
    setTimeout(() => {
      if (shownHash !== hex) return;
      el.innerHTML = `<span class="z">${hex.slice(0, i + 1)}</span>${hex.slice(i + 1)}`;
      pulse(el, 'flash');
    }, 450);
  }
  drawSpark();
}

function drawSpark() {
  const c = $('spark');
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = crew.samples;
  if (s.length < 2) return;
  const max = Math.max(...s.map(x => x.cpu + x.gpu), 1);
  const x = i => w - ((s.length - 1 - i) / 89) * w;
  const y = v => h - 2 - (v / max) * (h - 6);
  ctx.beginPath();
  s.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.cpu + p.gpu)) : ctx.moveTo(x(i), y(p.cpu + p.gpu))));
  ctx.strokeStyle = '#e4571b';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineTo(x(s.length - 1), h);
  ctx.lineTo(x(0), h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#e4571b33');
  g.addColorStop(1, '#e4571b00');
  ctx.fillStyle = g;
  ctx.fill();
}

// ---------- pool stream ----------
function connect() {
  const es = new EventSource(`${API}/api/stream`);
  const conn = $('conn');
  es.addEventListener('open', () => { conn.className = 'conn live'; conn.title = 'live'; });
  es.addEventListener('error', () => { conn.className = 'conn down'; conn.title = 'reconnecting'; });
  es.addEventListener('state', e => { pool = JSON.parse(e.data); renderPool(); });
  es.addEventListener('settled', e => {
    const { round, reward } = JSON.parse(e.data);
    scene.sweep();
    pulse(document.querySelector('.view:not([hidden])'), 'sweep');
    if (reward) toast(`Round #${round} settled`, `${sol(reward)} SOL split by verified survey work`);
    pollWallet();
  });
  es.addEventListener('payout', e => {
    const p = JSON.parse(e.data);
    if (p.wallet === walletInput.value.trim()) toast('Payout confirmed', `${sol(p.lamports)} SOL sent to ${short(p.wallet)}`, 'good');
  });
}

function renderPool() {
  if (!pool) return;
  const [r, u] = rate(pool.live.hashrate);
  R('poolRate', r); setText('poolRateUnit', u);
  R('lbRate', r); setText('lbRateUnit', u);
  R('miners', pool.live.active_miners); R('lbMiners', pool.live.active_miners);
  R('ppm', pool.live.proofs_per_min); R('lbProofs', pool.live.proofs_per_min);
  R('reward', sol(pool.config.reward_per_round));
  setText('roundLabel', `round #${pool.round.id}`);
  setText('lbRound', `#${pool.round.id}`);
  setText('roundMiners', `${pool.round.miners} surveyor${pool.round.miners === 1 ? '' : 's'} · ${points(pool.round.work)} surveyed`);
  for (const el of document.querySelectorAll('.threshold')) el.textContent = sol(pool.config.payout_threshold);
  renderCA(pool.config.token_mint);

  const funding = pool.simulated
    ? 'Test mode: each round books a fixed pot into the ledger; payouts open with the crew.'
    : 'Creator fees reach the reward wallet. Each round, the new fees are split by verified survey work.';
  setText('fundingText', funding);
  setText('fundingRule', `${funding} Balances over the threshold are paid out and logged in the ledger.`);
  setText('rulesConfig',
    `Current settings: ${pool.config.round_ms / 1000}s rounds · pot ${sol(pool.config.reward_per_round)} SOL · ` +
    `payout threshold ${sol(pool.config.payout_threshold)} SOL · minimum grid size ${pool.config.min_difficulty} bits.`);

  $('rounds').innerHTML = (pool.rounds ?? []).map(r =>
    `<li><span>#${r.id}</span><em>${r.miners} surveyor${r.miners === 1 ? '' : 's'}</em><b>${r.reward ? sol(r.reward) : '–'}</b></li>`).join('')
    || '<li class="empty">No rounds settled yet.</li>';
  renderBoard();
  renderLedger();
}

// Contract address: a placeholder until TOKEN_MINT is set on the server.
let shownMint;
function renderCA(mint) {
  if (mint === shownMint) return;
  shownMint = mint;
  $('ca').classList.toggle('set', !!mint);
  $('caCopy').hidden = $('caLink').hidden = !mint;
  if (mint) {
    scramble($('caValue'), mint, 600);
    $('caLink').href = `https://pump.fun/coin/${mint}`;
  } else {
    $('caValue').textContent = 'dropping at launch';
  }
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

function tickRound() {
  if (!pool) return;
  const { started_at, closes_at } = pool.round;
  const left = Math.max(0, closes_at - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
  const label = left ? `${m}:${String(s).padStart(2, '0')} left` : 'settling';
  setText('roundLeft', label);
  $('roundLeft').classList.toggle('urgent', left > 0 && left < 10_000);
  setText('lbLeft', label);
  segments($('roundRuler'), 1 - left / (closes_at - started_at));
}

function renderBoard() {
  if (!pool) return;
  const me = walletInput.value.trim();
  let rows, head;
  if (board === 'all') {
    head = '<tr><th>#</th><th>Wallet</th><th class="num">Surveyed</th><th class="num">Paid</th></tr>';
    rows = pool.leaderboard.all.map((r, i) =>
      `<tr class="${r.wallet === me ? 'me' : ''}" style="animation-delay:${i * 25}ms"><td>${i + 1}</td><td>${short(r.wallet)}</td><td class="num">${points(r.work)}</td><td class="num">${sol(r.paid)} SOL</td></tr>`);
  } else {
    const list = board === 'round' ? pool.leaderboard.round : pool.leaderboard.last?.shares ?? [];
    head = `<tr><th>#</th><th>Wallet</th><th class="num">Surveyed</th><th class="num">Share</th>${board === 'last' ? '<th class="num">Reward</th>' : ''}</tr>`;
    rows = list.map((r, i) =>
      `<tr class="${r.wallet === me ? 'me' : ''}" style="animation-delay:${i * 25}ms"><td>${i + 1}</td><td>${short(r.wallet)}</td><td class="num">${points(r.work)}</td>` +
      `<td class="num">${pct(r.share)}<div class="share-bar" style="width:${Math.max(2, r.share * 100)}%"></div></td>` +
      `${board === 'last' ? `<td class="num">${sol(r.lamports)} SOL</td>` : ''}</tr>`);
  }
  const html = head + (rows.join('') || '<tr><td colspan="5" class="empty">No work in this period yet.</td></tr>');
  if ($('board').dataset.html !== html) { $('board').innerHTML = html; $('board').dataset.html = html; }
}

function explorer(kind, id) {
  const c = pool?.treasury?.cluster;
  const q = !c || c === 'mainnet-beta' ? '' : c === 'localnet' ? '?cluster=custom' : `?cluster=${c}`;
  return `https://solscan.io/${kind}/${id}${q}`;
}

const STATUS = { sim: 'booked', queued: 'queued', submitted: 'sending', sent: 'confirmed' };
function sigLink(p) {
  if (!p.signature) return '–';
  if (p.status === 'sim' || !p.status) return `<span class="muted">${p.signature.slice(0, 12)}…</span>`;
  return `<a href="${explorer('tx', p.signature)}" target="_blank" rel="noopener">${p.signature.slice(0, 12)}…</a>`;
}

function renderLedger() {
  const t = pool.treasury;
  $('treasury').innerHTML = t
    ? `<div><span>Reward wallet</span><b><a href="${explorer('account', t.address)}" target="_blank" rel="noopener">${esc(t.address)}</a></b></div>` +
      `<div><span>Balance</span><b>${sol(t.balance)} SOL</b></div><div><span>Cluster</span><b>${esc(t.cluster)}</b></div>`
    : '';
  const rows = pool.payouts.map((p, i) => {
    return `<tr style="animation-delay:${i * 20}ms"><td>${time(p.at)}</td><td>${short(p.wallet)}</td><td>#${p.round}</td>` +
      `<td class="num">${sol(p.lamports)} SOL</td><td><span class="st st-${p.status ?? 'sim'}">${STATUS[p.status] ?? 'booked'}</span></td><td>${sigLink(p)}</td></tr>`;
  });
  const html = '<tr><th>Time</th><th>Wallet</th><th>Round</th><th class="num">Amount</th><th>Status</th><th>Signature</th></tr>' +
    (rows.join('') || '<tr><td colspan="6" class="empty">No payouts yet.</td></tr>');
  if ($('ledger').dataset.html !== html) { $('ledger').innerHTML = html; $('ledger').dataset.html = html; }
}

// ---------- wallet ----------
async function pollWallet() {
  const v = walletInput.value.trim();
  if (!WALLET.test(v)) return;
  try {
    you = await (await fetch(`${API}/api/wallet/${v}`)).json();
  } catch { return; }
  setText('youAddr', short(v));
  R('share', pct(you.round_share));
  setText('est', `≈ ${sol(you.round_estimate)} SOL`);
  R('balance', sol(you.balance));
  setText('pendingNote', you.pending ? `SOL · ${sol(you.pending)} sending` : 'SOL · not sent');
  R('paid', sol(you.paid));
  const total = you.balance + (you.pending ?? 0) + you.paid;
  if (earned !== null && total > earned) {
    toast('You earned', `+${sol(total - earned)} SOL from the last round`, 'good');
    floatUp($('balance').parentElement, `+${sol(total - earned)}`);
  }
  earned = total;
  if (pool) {
    const t = pool.config.payout_threshold;
    segments($('thresholdRuler'), you.balance / t);
    setText('thresholdText', `${pct(Math.min(1, you.balance / t))} of ${sol(t)} SOL, sent on its own`);
  }
}

route();
renderCrew();
connect();
segments($('roundRuler'), 0);
segments($('thresholdRuler'), 0);
setInterval(tickRound, 1000);
setInterval(pollWallet, 4000);
pollWallet();
addEventListener('resize', drawSpark);
