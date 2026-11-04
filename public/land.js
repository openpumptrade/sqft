// The land: a surveyor's plat map drawn into a low-resolution buffer and scaled up
// with hard edges. Paper with a survey grid and contour lines, a river, roads, and
// eight lots (one per city index). Lots fill with houses as square feet are bought;
// dollars still on the way show as survey stakes. A surveyor walks the roads.
//
//   setLots([{ key, label, sqft, reserved }])   what each lot holds; drives houses and stakes
//   setActivity({ running, level })              how busy the surveyor is
//   allocate({ sqft, label })                    a purchase: the surveyor goes to that lot, a house is built, "+sqft" floats up
//   plant()                                      a stake somewhere (browser survey work)
//   sweep()                                      round close: a survey line runs across the map
//   setBackdrop(on)                              calmer motion while a page sits over the map
//   clicking the map sends the surveyor to a random lot

const hex = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const PAPER = ['#efe6d2', '#ece2cc', '#e8ddc5', '#f2eada'].map(hex);
const GRID = hex('#dccfae');
const CONTOUR = hex('#e0d4b6');
const ROAD = hex('#d8cba6'), ROAD_D = hex('#c9bb95'), DASH = hex('#f6efdf');
const WATER = hex('#8fbfd8'), WATER_D = hex('#6fa8c7'), BANK = hex('#cfc1a0');
const GRASS = ['#5d9a4a', '#559144', '#4f8a3f', '#67a352'].map(hex);
const GRASS_D = hex('#2f6a2b');
const INK = hex('#1c2a1e');
const ORANGE = hex('#e4571b'), ORANGE_D = hex('#b8410f');
const CREAM = hex('#fbf7ee');
const SPARK = hex('#ffd9a8');

const PAL = {
  K: INK, k: hex('#3c4a3e'), W: CREAM, w: hex('#e7dfcb'), O: ORANGE, o: ORANGE_D, G: GRASS[0], g: GRASS_D,
  R: hex('#c94a2b'), r: hex('#9d361c'), S: hex('#5a6b7a'), s: hex('#3e4b57'), T: hex('#3f7f8a'), t: hex('#2c5c65'),
  Y: hex('#f2c14e'), y: hex('#c99a2e'), B: hex('#8a5a2b'), b: hex('#5f3d1c'), D: hex('#2a3a2c'), L: hex('#9fd1e8'),
  V: ORANGE, H: hex('#f0e4c8'),
};
// houses: three roof colours, same body
const HOUSE = roof => [
  `..${roof}${roof}${roof}..`,
  `.${roof}${roof}${roof}${roof}${roof}.`,
  `${roof}${roof}${roof}${roof}${roof}${roof}${roof}`,
  'KWWWWWK',
  'KWLWDWK',
  'KWWWDWK',
  'KKKKKKK',
];
const HOUSES = [HOUSE('R'), HOUSE('O'), HOUSE('S'), HOUSE('T')];
const TOWER = [
  '.KKKKK.',
  'KWLWLWK',
  'KWWWWWK',
  'KWLWLWK',
  'KWWWWWK',
  'KWLWLWK',
  'KWWWWWK',
  'KWLWLWK',
  'KWWDWWK',
  'KKKKKKK',
];
const STAKE = ['KOO', 'KOO', 'K..', 'K..'];
const TREE = ['.GG.', 'GGGg', '.gg.', '..B.'];
const SIGN = ['KKKKKKKKKKKKKKKK', 'KHHHHHHHHHHHHHHK', 'KHHHHHHHHHHHHHHK', 'KHHHHHHHHHHHHHHK', 'KHHHHHHHHHHHHHHK', 'KHHHHHHHHHHHHHHK', 'KHHHHHHHHHHHHHHK', 'KKKKKKKKKKKKKKKK', '.......KK.......', '.......KK.......'];
// the surveyor: hard hat, vest, tripod beside them
const SURVEYOR = ['.YYY.', '.YYY.', '.WWW.', 'VVVVV', 'VOOOV', '.KKK.', '.K.K.', '.K.K.'];
const TRIPOD = ['..K..', '.KKK.', '..K..', '.K.K.', 'K...K'];

// 3x5 pixel font for lot signs
const F = {
  A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'], C: ['XXX', 'X..', 'X..', 'X..', 'XXX'], D: ['XX.', 'X.X', 'X.X', 'X.X', 'XX.'], F: ['XXX', 'X..', 'XX.', 'X..', 'X..'],
  H: ['X.X', 'X.X', 'XXX', 'X.X', 'X.X'], I: ['XXX', '.X.', '.X.', '.X.', 'XXX'], L: ['X..', 'X..', 'X..', 'X..', 'XXX'], M: ['X.X', 'XXX', 'XXX', 'X.X', 'X.X'],
  N: ['X.X', 'XXX', 'XXX', 'XXX', 'X.X'], S: ['XXX', 'X..', 'XXX', '..X', 'XXX'], T: ['XXX', '.X.', '.X.', '.X.', '.X.'], U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'],
  W: ['X.X', 'X.X', 'XXX', 'XXX', 'X.X'], X: ['X.X', 'X.X', '.X.', 'X.X', 'X.X'], Y: ['X.X', 'X.X', '.X.', '.X.', '.X.'], O: ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'],
  E: ['XXX', 'X..', 'XX.', 'X..', 'XXX'], R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'], B: ['XX.', 'X.X', 'XX.', 'X.X', 'XX.'], K: ['X.X', 'X.X', 'XX.', 'X.X', 'X.X'],
  G: ['XXX', 'X..', 'X.X', 'X.X', 'XXX'], P: ['XX.', 'X.X', 'XX.', 'X..', 'X..'], V: ['X.X', 'X.X', 'X.X', 'X.X', '.X.'], Q: ['XXX', 'X.X', 'X.X', 'XXX', '..X'], Z: ['XXX', '..X', '.X.', 'X..', 'XXX'],
};
const DEFAULT_LOTS = [['USA', 'USA'], ['NYC', 'NYC'], ['Chicago', 'CHI'], ['LosAngeles', 'LA'], ['Miami', 'MIA'], ['Austin', 'ATX'], ['WashingtonDC', 'DC'], ['SanFrancisco', 'SF']];

const clamp01 = t => Math.max(0, Math.min(1, t));
const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y, scale) {
  const fx = x / scale, fy = y / scale, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}
// houses to show for an amount of square feet: grows fast at the start, saturates around 10 sqft
const housesFor = sqft => (sqft > 0 ? Math.max(1, Math.round(2.2 * Math.log2(1 + sqft * 12))) : 0);

export class LandScene {
  constructor(canvas, { scale } = {}) {
    this.canvas = canvas;
    this.scale = scale;
    this.ctx = canvas.getContext('2d');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.backdrop = false;
    this.running = false; this.level = 0; this.activity = 0; this.time = 0;
    this.lotData = DEFAULT_LOTS.map(([key, label]) => ({ key, label, sqft: 0, reserved: 0 }));
    this.first = true;
    this.lots = [];
    this.queue = [];          // builds waiting for the surveyor: { lot, kind: 'house'|'stake', text }
    this.builds = [];         // houses under construction: { lot, cell, born }
    this.particles = []; this.labels = []; this.stakes = [];
    this.sweepAt = -9;
    this.surveyor = { x: 0, y: 0, tx: 0, ty: 0, walk: 0, job: null, idleAt: 0 };
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('pointerdown', () => { if (!this.backdrop && this.lots.length) this.queue.push({ lot: this.lots[(Math.random() * this.lots.length) | 0], kind: 'stake' }); });
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // ---------- public ----------
  setActivity({ running, level = 0 }) { this.running = running; this.level = running ? Math.max(0.12, clamp01(level)) : 0; }
  setLots(data) {
    if (!Array.isArray(data) || !data.length) return;
    this.lotData = data.map(d => ({ key: d.key ?? d.name, label: d.label ?? d.key, sqft: Number(d.sqft) || 0, reserved: Number(d.reserved) || 0 }));
    if (this.lots.length !== this.lotData.length) this.build();
    this.sync(this.first);
    this.first = false;
  }
  allocate({ sqft = 0, label = null } = {}) {
    if (!this.lots.length) return;
    const lot = this.lots.find(l => l.label === label || l.key === label) ?? this.lots[(Math.random() * this.lots.length) | 0];
    this.queue.push({ lot, kind: 'house', text: sqft ? `+${sqft < 1 ? sqft.toFixed(3) : sqft.toFixed(1)} sqft` : null });
  }
  plant() {
    if (!this.lots.length) return;
    const lot = this.lots[(Math.random() * this.lots.length) | 0];
    this.stake(lot, true);
  }
  sweep() { this.sweepAt = this.time; }
  setBackdrop(on) { this.backdrop = on; }

  // ---------- setup ----------
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (width === this.w && height === this.h && dpr === this.dpr && this.buf) return;
    this.w = width; this.h = height; this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    if (!width || !height) return;
    const P = this.scale ?? Math.max(2, Math.min(4, Math.round(Math.min(height / 60, width / 180))));
    const W = Math.ceil(width / P), H = Math.ceil(height / P);
    this.P = P; this.W = W; this.H = H;
    this.buf = Object.assign(document.createElement('canvas'), { width: W, height: H });
    this.bctx = this.buf.getContext('2d');
    this.img = this.bctx.createImageData(W, H);
    this.build();
    this.sync(true);
  }

  // The static map: paper, grid, contours, a river, roads and the lot outlines.
  build() {
    const { W, H } = this;
    if (!W) return;
    const base = new Uint8ClampedArray(W * H * 3);
    const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) base.set(c, (y * W + x) * 3); };
    // river: a gentle sine band from the top-right to the bottom-left
    const riverX = y => W * 0.86 - y * 0.42 + Math.sin(y / 17) * 6 + Math.sin(y / 5.3) * 1.5;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const n = vnoise(x, y, 23), n2 = vnoise(x + 300, y + 300, 7);
      let c = PAPER[((n * 3) | 0) % 3];
      if (n2 > 0.72) c = PAPER[3];
      if (x % 8 === 0 && y % 8 === 0) c = GRID;
      const ct = vnoise(x + 900, y + 100, 31);
      for (const L of [0.36, 0.5, 0.64]) if (Math.abs(ct - L) < 0.006) c = CONTOUR;
      const rx = riverX(y), d = Math.abs(x - rx);
      if (d < 4.2) c = d < 3 ? (hash(x, y) > 0.9 ? WATER : WATER_D) : BANK;
      set(x, y, c);
    }
    // lots: a block of 8 in the free band, roads between; rows picked from the space available
    const n = this.lotData.length;
    const mx = Math.max(4, Math.round(W * 0.02)), road = 5;
    const top = 4, bottom = H - 4;
    const fit = (rows) => { const cols = Math.ceil(n / rows); return { rows, cols, lotW: Math.floor((W - 2 * mx - road * (cols - 1)) / cols), lotH: Math.floor((bottom - top - road * (rows - 1)) / rows) }; };
    // two rows when they fit; one long row on short bands; four rows only on narrow screens with room
    const ok = f => f.lotW >= 20 && f.lotH >= 22;
    const score = f => Math.min(f.lotW, f.lotH * 1.3);
    const pick = [fit(2), fit(1), fit(4)].filter(ok).sort((a, b) => score(b) - score(a))[0] ?? fit(2);
    const { cols, rows, lotW, lotH } = pick;
    const lots = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (k >= this.lotData.length) break;
      const x = mx + c * (lotW + road), y = top + r * (lotH + road);
      const cells = [];
      for (let cy = y + 12; cy + 8 <= y + lotH - 1; cy += 9) for (let cx = x + 3; cx + 8 <= x + lotW - 2; cx += 9) cells.push({ x: cx + ((hash(cx, cy) * 2) | 0), y: cy + ((hash(cy, cx) * 2) | 0) });
      if (!cells.length) cells.push({ x: x + 3, y: y + Math.max(2, lotH - 9) });
      // shuffle deterministically so houses scatter instead of filling left to right
      cells.sort((a, b) => hash(a.x, a.y * 3) - hash(b.x, b.y * 3));
      lots.push({ ...this.lotData[k], x, y, w: lotW, h: lotH, cells, houses: [], stakes: 0, door: { x: x + Math.round(lotW / 2), y: y + lotH + 2 } });
    }
    // roads around and between the lots
    const roadRect = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, (x + y) % 9 === 0 ? ROAD_D : ROAD); };
    roadRect(mx - road, top - road, W - mx + road, top);
    roadRect(mx - road, bottom, W - mx + road, bottom + road);
    roadRect(mx - road, top - road, mx, bottom + road);
    roadRect(W - mx, top - road, W - mx + road, bottom + road);
    for (let c = 1; c < cols; c++) roadRect(mx + c * (lotW + road) - road, top, mx + c * (lotW + road), bottom);
    for (let r = 1; r < rows; r++) roadRect(mx, top + r * (lotH + road) - road, W - mx, top + r * (lotH + road));
    // dashed centre lines
    for (let x = mx - road; x < W - mx + road; x++) if ((x >> 1) % 3 === 0) { set(x, top - 3, DASH); set(x, bottom + 2, DASH); }
    for (let r = 1; r < rows; r++) for (let x = mx; x < W - mx; x++) if ((x >> 1) % 3 === 0) set(x, top + r * (lotH + road) - 3, DASH);
    for (let y = top - road; y < bottom + road; y++) if ((y >> 1) % 3 === 0) { set(mx - 3, y, DASH); set(W - mx + 2, y, DASH); }
    for (let c = 1; c < cols; c++) for (let y = top; y < bottom; y++) if ((y >> 1) % 3 === 0) set(mx + c * (lotW + road) - 3, y, DASH);
    // grass and a dashed ink boundary per lot
    for (const l of lots) {
      for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) {
        const g = vnoise(x + 50, y + 50, 6);
        let c = GRASS[(g * 4) | 0];
        if (hash(x * 7, y * 3) > 0.985) c = GRASS[3];
        if (x === l.x || y === l.y || x === l.x + l.w - 1 || y === l.y + l.h - 1) c = ((x + y) >> 1) % 2 ? INK : GRASS_D;
        set(x, y, c);
      }
      // a path from the road to the sign
      for (let y = l.y + l.h - 1; y > l.y + l.h - 5; y--) set(l.door.x, y, ROAD);
    }
    // trees on the paper, away from the lots and the river
    const trees = [];
    for (let k = 0; k < Math.round(W * H / 420); k++) {
      const x = 2 + ((hash(k, 1) * (W - 6)) | 0), y = 2 + ((hash(k, 2) * (H - 8)) | 0);
      const inLot = lots.some(l => x >= l.x - 4 && x <= l.x + l.w + 4 && y >= l.y - 6 && y <= l.y + l.h + 6) || Math.abs(x - riverX(y)) < 7;
      if (!inLot && hash(k, 3) > 0.35) trees.push({ x, y });
    }
    for (const t of trees) TREE.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.') set(t.x + i, t.y + j, PAL[row[i]]); });
    this.base = base;
    this.lots = lots;
    this.riverX = riverX;
    if (!this.surveyor.placed) { this.surveyor = { ...this.surveyor, x: mx - 3, y: bottom + 1, tx: mx - 3, ty: bottom + 1, placed: true }; }
  }

  // Match houses and stakes to the data. Instant on the first fill; queued through the surveyor afterwards.
  sync(instant) {
    for (const l of this.lots) {
      const d = this.lotData.find(x => x.key === l.key) ?? { sqft: 0, reserved: 0 };
      l.sqft = d.sqft; l.reserved = d.reserved; l.label = d.label ?? l.label;
      const want = Math.min(l.cells.length, housesFor(l.sqft));
      const have = l.houses.length + this.builds.filter(b => b.lot === l).length + this.queue.filter(q => q.lot === l && q.kind === 'house').length;
      if (want > have) {
        for (let k = have; k < want; k++) {
          if (instant || k - have > 2) l.houses.push({ cell: l.cells[l.houses.length + this.builds.filter(b => b.lot === l).length], kind: (hash(l.x + k, l.y) * HOUSES.length) | 0, born: -9 });
          else this.queue.push({ lot: l, kind: 'house' });
        }
      } else if (want < l.houses.length) l.houses.length = want;
      l.stakes = Math.min(6, housesFor(l.reserved));
    }
  }
  stake(lot, temp = false) {
    const x = lot.x + 3 + ((Math.random() * (lot.w - 7)) | 0), y = lot.y + 10 + ((Math.random() * Math.max(1, lot.h - 16)) | 0);
    this.stakes.push({ x, y, born: this.time, life: temp ? 8 : 1e9 });
    if (this.stakes.length > 40) this.stakes.shift();
    for (let k = 0; k < 6; k++) this.particles.push({ x: x + 1, y: y + 3, vx: (Math.random() - 0.5) * 30, vy: -15 - Math.random() * 20, life: 0.5, born: this.time, c: SPARK });
  }

  // ---------- frame ----------
  frame(now) {
    requestAnimationFrame(this.frame);
    if (!this.w || !this.buf || document.hidden) { this.last = now; return; }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    const t = this.time, calm = this.backdrop ? 0.5 : 1;
    this.activity += (this.level - this.activity) * Math.min(1, dt * 1.5);
    const s = this.surveyor;
    // take the next job: walk to the lot's gate, then do the work
    if (!s.job && this.queue.length) {
      s.job = this.queue.shift();
      s.tx = s.job.lot.door.x - 2; s.ty = s.job.lot.door.y - 4; s.arrived = false;
    }
    if (!s.job && !this.queue.length && t > s.idleAt && !this.reduced) {
      // wander along the outer road while idle
      const l = this.lots[(Math.random() * this.lots.length) | 0];
      if (l && Math.random() < 0.5) { s.tx = l.door.x + 4; s.ty = l.door.y - 4; }
      s.idleAt = t + 6 + Math.random() * 8;
    }
    const dx = s.tx - s.x, dy = s.ty - s.y, dist = Math.hypot(dx, dy);
    const speed = (s.job ? 26 : 10) * calm * (1 + this.activity);
    if (dist > 0.5) { const k = Math.min(1, speed * dt / dist); s.x += dx * k; s.y += dy * k; s.walk += dt * speed * 0.6; s.face = dx < 0 ? -1 : 1; }
    else if (s.job && !s.arrived) {
      s.arrived = true; s.workAt = t;
    }
    if (s.job && s.arrived && t - s.workAt > 0.6) {
      const { lot, kind, text } = s.job;
      if (kind === 'house') {
        const used = new Set([...lot.houses.map(h => h.cell), ...this.builds.filter(b => b.lot === lot).map(b => b.cell)]);
        const cell = lot.cells.find(c => !used.has(c)) ?? lot.cells[(Math.random() * lot.cells.length) | 0];
        this.builds.push({ lot, cell, born: t, kind: (Math.random() * HOUSES.length) | 0 });
        if (text) this.labels.push({ x: cell.x + 3, y: cell.y - 2, born: t, text });
        if (this.labels.length > 4) this.labels.shift();
      } else this.stake(lot, true);
      s.job = null;
    }
    // construction finishes after 1.4 s
    for (const b of this.builds) if (!b.done && t - b.born > 1.4) {
      b.done = true;
      b.lot.houses.push({ cell: b.cell, kind: b.kind, born: t });
      for (let k = 0; k < 10; k++) this.particles.push({ x: b.cell.x + Math.random() * 7, y: b.cell.y + 5, vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 30, life: 0.6, born: t, c: SPARK });
    }
    this.builds = this.builds.filter(b => !b.done);
    for (const p of this.particles) { p.vy += 120 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    this.particles = this.particles.filter(p => t - p.born < p.life).slice(-200);
    this.labels = this.labels.filter(l => t - l.born < 1.8);
    this.stakes = this.stakes.filter(k => t - k.born < k.life);
  }

  // ---------- drawing ----------
  draw() {
    const { W, H, img, base } = this, d = img.data, t = this.time;
    const sweepK = clamp01((t - this.sweepAt) / 1.4);
    const sweepY = sweepK < 1 ? sweepK * H : -1;
    // paper + a slow cloud shadow + water shimmer
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      let r = base[i * 3], g = base[i * 3 + 1], b = base[i * 3 + 2];
      if (!this.reduced) {
        const cl = vnoise(x + t * 3.5, y + t * 0.8, 34);
        if (cl > 0.66) { const k = 1 - Math.min(0.09, (cl - 0.66) * 0.6); r *= k; g *= k; b *= k; }
      }
      if (b > r + 30 && g > r && ((x + ((t * 6) | 0)) % 11 === 0) && (y % 3 === 0)) { r += 40; g += 30; b += 20; }
      if (sweepY >= 0 && Math.abs(y - sweepY) < 1.5) { r = (r + ORANGE[0] * 2) / 3; g = (g + ORANGE[1] * 2) / 3; b = (b + ORANGE[2] * 2) / 3; }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    for (const l of this.lots) this.drawLot(l);
    for (const k of this.stakes) this.sprite(STAKE, k.x, k.y);
    for (const b of this.builds) this.drawBuild(b);
    this.drawSurveyor();
    for (const p of this.particles) this.px(p.x, p.y, p.c);
    this.bctx.putImageData(img, 0, 0);
    const { ctx, dpr, w, h, P } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.buf, 0, 0, W * P, H * P);
    this.drawLabels();
  }

  px(x, y, c, a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const o = (y * this.W + x) * 4, d = this.img.data;
    d[o] += (c[0] - d[o]) * a; d[o + 1] += (c[1] - d[o + 1]) * a; d[o + 2] += (c[2] - d[o + 2]) * a;
  }
  sprite(rows, x, y, colors = PAL) {
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] !== '.' && colors[row[i]]) this.px(x + i, y + j, colors[row[i]]); });
  }
  text(s, x, y, c = INK) {
    for (const ch of s) {
      const g = F[ch];
      if (g) g.forEach((row, j) => { for (let i = 0; i < 3; i++) if (row[i] === 'X') this.px(x + i, y + j, c); });
      x += 4;
    }
  }

  drawLot(l) {
    const t = this.time;
    // the sign with the lot's label
    const sx = l.x + 2, sy = l.y + 2;
    this.sprite(SIGN.map(r => r.slice(0, Math.min(16, l.w - 4))), sx, sy);
    this.text(l.label.slice(0, 3), sx + 2, sy + 2);
    // reserved square feet: stakes along the lot's right edge
    for (let k = 0; k < l.stakes; k++) this.sprite(STAKE, l.x + l.w - 5, l.y + 4 + k * 5);
    // houses
    for (const h of l.houses) {
      const age = clamp01((t - h.born) / 0.5);
      const rows = h.cell && l.sqft > 40 && hash(h.cell.x, h.cell.y) > 0.6 ? TOWER : HOUSES[h.kind % HOUSES.length];
      this.sprite(rows, h.cell.x, h.cell.y - (rows.length - 7));
      if (age < 1) for (let i = 0; i < 7; i++) this.px(h.cell.x + i, h.cell.y - 1 - (rows.length - 7), SPARK, 1 - age);
      // a lit window at night-ish rhythm
      if (Math.sin(t * 1.3 + h.cell.x) > 0.95) this.px(h.cell.x + 2, h.cell.y + 4 - (rows.length - 7), PAL.Y);
    }
  }
  drawBuild(b) {
    const k = clamp01((this.time - b.born) / 1.4), rows = HOUSES[b.kind % HOUSES.length];
    const n = Math.ceil(k * rows.length);
    // built bottom-up: foundation first, roof last
    this.sprite(rows.slice(rows.length - n), b.cell.x, b.cell.y + (rows.length - n));
    if (k < 1 && ((this.time * 8) | 0) % 2) this.px(b.cell.x + 3, b.cell.y - 1 + (rows.length - n), ORANGE);
  }
  drawSurveyor() {
    const s = this.surveyor, t = this.time;
    const bob = Math.abs(Math.sin(s.walk)) > 0.5 && Math.hypot(s.tx - s.x, s.ty - s.y) > 0.5 ? 1 : 0;
    this.sprite(SURVEYOR, s.x, s.y - bob);
    if (s.job && s.arrived) this.sprite(TRIPOD, s.x + (s.face < 0 ? -6 : 6), s.y + 3);
    // the hat glints while working
    if (s.job && s.arrived && Math.sin(t * 10) > 0) this.px(s.x + 2, s.y - bob, CREAM);
  }
  drawLabels() {
    if (this.backdrop || !this.labels.length) return;
    const { ctx, P } = this;
    ctx.font = `600 ${P * 4}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    for (const l of this.labels) {
      const k = (this.time - l.born) / 1.8;
      const a = k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9;
      const x = l.x * P, y = (l.y - easeOut(k) * 14) * P;
      ctx.fillStyle = `rgba(251,247,238,${a})`;
      ctx.fillText(l.text, x + 1, y + 1);
      ctx.fillStyle = `rgba(184,65,15,${a})`;
      ctx.fillText(l.text, x, y);
    }
    ctx.textAlign = 'start';
  }
}
