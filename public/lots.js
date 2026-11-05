// The market cards: one per city index. A real photo of the city, the ticker,
// today's move, the index in dollars per square foot, the square feet the coin
// holds there and a 30-day sparkline.
//
//   setLots([{ key, label, city, price, change_1d, change_30d, sqft, notional, reserved, spark }])
//   allocate({ sqft, label })   a purchase: the card flashes and "+sqft" floats up
//   plant() / sweep()           small flashes for the survey crew and round close
//   setActivity / setBackdrop / resize   kept for compatibility (no-ops)

const CITY = { USA: 'United States', NYC: 'New York City', Chicago: 'Chicago', LosAngeles: 'Los Angeles', Miami: 'Miami', Austin: 'Austin', WashingtonDC: 'Washington, DC', SanFrancisco: 'San Francisco' };
const LABEL = { USA: 'USA', NYC: 'NYC', Chicago: 'CHI', LosAngeles: 'LA', Miami: 'MIA', Austin: 'ATX', WashingtonDC: 'DC', SanFrancisco: 'SF' };
const ORDER = Object.keys(CITY);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const num = (v, d = 2) => (+Number(v).toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
const sqftFmt = v => { v = Number(v) || 0; return v === 0 ? '0' : v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : num(v, 0); };
const pctFmt = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v || 0) * 100).toFixed(2)}%`;

function sparkline(points, w = 64, h = 16) {
  const v = (points ?? []).filter(x => x > 0);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const d = v.map((p, i) => `${(i / (v.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - (p - min) / span * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export class LotStrip {
  constructor(root) {
    this.root = root;
    this.grid = root.querySelector('.lotgrid') ?? root.appendChild(Object.assign(document.createElement('div'), { className: 'lotgrid' }));
    this.cards = new Map();
    this.setLots(ORDER.map(key => ({ key, label: LABEL[key], city: CITY[key] })));
  }

  setLots(data) {
    if (!Array.isArray(data) || !data.length) return;
    const keys = new Set();
    for (const d of data) {
      const key = d.key ?? d.name;
      keys.add(key);
      let card = this.cards.get(key);
      if (!card) {
        card = document.createElement('article');
        card.className = 'lotcard empty';
        card.dataset.key = key;
        card.innerHTML = `
          <div class="photo-wrap">
            <img class="photo" alt="" decoding="async" src="/cities/${esc(key.toLowerCase())}.jpg">
            <div class="shade"></div>
            <span class="country">USA</span>
            <b class="tag"></b>
            <span class="move"></span>
          </div>
          <footer>
            <span class="price"></span>
            <span class="held"><b></b><span class="trend"></span></span>
          </footer>
          <div class="flash"></div>`;
        this.grid.appendChild(card);
        this.cards.set(key, card);
      }
      card.querySelector('.tag').textContent = d.label ?? LABEL[key] ?? key;
      card.querySelector('.photo').alt = d.city ?? CITY[key] ?? key;
      card.title = d.city ?? CITY[key] ?? key;
      const mv = card.querySelector('.move');
      const ch = Number(d.change_1d) || 0;
      mv.textContent = d.price != null ? pctFmt(ch) : '';
      mv.className = `move ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}`;
      card.querySelector('.price').textContent = d.price != null ? `$${num(d.price, 2)} / sqft` : '–';
      const held = Number(d.sqft) || 0, reserved = Number(d.reserved) || 0;
      card.querySelector('.held b').textContent = held > 0 ? `${sqftFmt(held)} sqft · $${num(d.notional ?? held * (d.price ?? 0), 0)}` : reserved > 0 ? `${sqftFmt(reserved)} sqft under contract` : 'No position yet';
      card.classList.toggle('empty', held <= 0);
      const trend = card.querySelector('.trend');
      const svg = sparkline(d.spark);
      if (trend.dataset.svg !== svg) { trend.innerHTML = svg; trend.dataset.svg = svg; }
      trend.className = `trend ${d.change_30d > 0 ? 'up' : d.change_30d < 0 ? 'down' : ''}`;
    }
    for (const [key, card] of this.cards) if (!keys.has(key)) { card.remove(); this.cards.delete(key); }
    for (const key of ORDER) { const c = this.cards.get(key); if (c) this.grid.appendChild(c); }
  }

  allocate({ sqft = 0, label = null } = {}) {
    const card = [...this.cards.values()].find(c => c.querySelector('.tag').textContent === label || c.dataset.key === label) ?? [...this.cards.values()][0];
    if (!card) return;
    this.pulse(card);
    if (sqft) {
      const f = document.createElement('span');
      f.className = 'floater';
      f.textContent = `+${sqftFmt(sqft)} sqft`;
      card.appendChild(f);
      setTimeout(() => f.remove(), 1500);
    }
  }
  pulse(card) { card.classList.remove('bought'); void card.offsetWidth; card.classList.add('bought'); }
  plant() { const all = [...this.cards.values()]; if (all.length) this.pulse(all[(Math.random() * all.length) | 0]); }
  sweep() { this.root.classList.remove('sweep'); void this.root.offsetWidth; this.root.classList.add('sweep'); }
  setBackdrop() {}
  setActivity() {}
  resize() {}
}
