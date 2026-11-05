// SQFT server: mounts the land engine, serves its state at /api/engine and hosts ./public.
// No framework. The frontend is static and can be hosted apart (see <meta name="sqft-api">).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { LandEngine } from './engine/engine.js';

const env = (k, d) => (process.env[k] ?? d);
const CFG = {
  port: Number(env('PORT', 8787)),
  static_cache: Number(env('STATIC_CACHE', 300)),
};
const PAGES = ['/', '/land', '/stats', '/rules'];
const engine = new LandEngine();
const log = (...a) => console.log(new Date().toISOString(), ...a);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const PUBLIC = new URL('./public/', import.meta.url).pathname;
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {}, { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'content-type' });
  try {
    if (p === '/api/engine') return send(res, 200, engine.view());
    if (p === '/api/health') return send(res, 200, { ok: true, at: Date.now(), last_poll: engine.live.at });
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not_found' });

    // static + SPA fallback
    let file = normalize(p).replace(/^(\.\.[/\\])+/, '');
    if (PAGES.includes(p)) file = '/index.html';
    const path = join(PUBLIC, file);
    if (!path.startsWith(PUBLIC) || !existsSync(path) || extname(path) === '') { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': file === '/index.html' || !CFG.static_cache ? 'no-cache' : `public, max-age=${CFG.static_cache}` });
    res.end(readFileSync(path));
  } catch (e) {
    log(`error ${req.method} ${p}: ${e.message}`);
    send(res, 500, { error: 'server_error' });
  }
}).listen(CFG.port, () => {
  engine.start();
  log(`sqft on :${CFG.port}`);
});
