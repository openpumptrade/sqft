// Small UI animation helpers: rolling digits, hex scramble text, toasts,
// floating "+2^d" labels and button ripples.

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HEX = '0123456789abcdef';

// Odometer: each digit is a vertical reel of 0-9 that slides to its value.
// Other characters (., %, ^, letters) render as-is. Rebuilds only when the
// shape of the string changes, so reels animate between values.
export function roll(el, text) {
  text = String(text);
  if (!el || el.dataset.roll === text) return;
  el.dataset.roll = text;
  if (REDUCED) { el.textContent = text; return; }
  const shape = text.replace(/\d/g, '0');
  if (el.dataset.shape !== shape) {
    el.dataset.shape = shape;
    el.innerHTML = [...text].map(c => (/\d/.test(c)
      ? `<span class="reel"><span>${'0123456789'.split('').map(d => `<i>${d}</i>`).join('')}</span></span>`
      : `<span class="lit">${c === ' ' ? '&nbsp;' : c}</span>`)).join('');
    // start from 0 so the first value rolls in
    void el.offsetWidth;
  }
  let i = 0;
  for (const c of text) {
    const node = el.children[i++];
    if (/\d/.test(c)) node.firstChild.style.transform = `translateY(${-Number(c)}em)`;
    else if (node.textContent !== c) node.textContent = c;
  }
}

// Reveals text left to right through a churn of random hex glyphs.
const scrambling = new WeakMap();
export function scramble(el, text = el.dataset.text ?? el.textContent, ms = 520) {
  if (!el) return;
  el.dataset.text = text;
  if (REDUCED) { el.textContent = text; return; }
  cancelAnimationFrame(scrambling.get(el));
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / ms);
    const shown = Math.floor(t * text.length);
    let out = text.slice(0, shown);
    for (let i = shown; i < text.length; i++) out += text[i] === ' ' ? ' ' : HEX[(Math.random() * 16) | 0];
    el.textContent = out;
    if (t < 1) scrambling.set(el, requestAnimationFrame(step));
  };
  scrambling.set(el, requestAnimationFrame(step));
}

// Toasts stack in the corner and dismiss themselves.
let tray = null;
export function toast(title, body = '', tone = '') {
  tray ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts' });
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.innerHTML = `<span class="toast-mark"></span><div><b></b><p></p></div>`;
  t.querySelector('b').textContent = title;
  t.querySelector('p').textContent = body;
  tray.prepend(t);
  while (tray.children.length > 4) tray.lastChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 4200);
}

// A label that rises from an element and fades, e.g. "+2^32".
export function floatUp(anchor, text) {
  if (!anchor || REDUCED) return;
  const f = document.createElement('span');
  f.className = 'floater';
  f.textContent = text;
  anchor.appendChild(f);
  f.addEventListener('animationend', () => f.remove());
}

// Expanding circle from the press point on buttons.
export function ripples(selector) {
  document.addEventListener('pointerdown', e => {
    const btn = e.target.closest(selector);
    if (!btn || REDUCED) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    btn.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  });
}

// Re-triggers a CSS animation class.
export function pulse(el, cls = 'pulse') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
