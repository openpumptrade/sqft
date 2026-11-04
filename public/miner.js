// Survey crew controller (browser side quest): fetches tickets, runs CPU workers and the GPU filler,
// submits proofs and tracks hashrate. The UI subscribes with `onChange`.
import { API } from './config.js';
import { GpuMiner } from './gpu.js';

const RETRYABLE = new Set(['unknown_challenge', 'expired']);
const SECONDS_PER_PROOF = 4;      // matches the server's vardiff target
const MAX_SUBMITS_PER_SEC = 4;    // stays under the server's rate limit

export class Miner {
  constructor() {
    this.wallet = null;
    this.status = 'idle';          // idle | starting | mining | error
    this.error = null;
    this.ticket = null;            // current challenge from the server
    this.tickets = new Map();      // jobId -> ticket; older tickets still accept proofs until they expire
    this.threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    this.maxThreads = navigator.hardwareConcurrency || 4;
    this.cpuDuty = 0.7;
    this.gpuEnabled = false;
    this.gpuDuty = 0.7;
    this.gpu = null;
    this.gpuName = null;
    this.gpuError = null;
    this.workers = [];
    this.accepted = 0;
    this.rejected = 0;
    this.credited = 0;
    this.lastProof = null;
    this.samples = [];             // [{ at, cpu, gpu }] hashes per second, 1 Hz
    this.window = { cpu: 0, gpu: 0, since: performance.now() };
    this.log = [];
    this.jobId = 0;
    this.listeners = new Set();
    this.sampler = null;
    this.refresh = null;
    this.ticketRequest = null;
    this.submits = [];
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(this); }

  note(text, tone = '') {
    this.log.unshift({ at: new Date(), text, tone });
    this.log.length = Math.min(this.log.length, 60);
    this.changed();
  }

  get hashrate() {
    const last = this.samples.at(-1);
    return last ? last.cpu + last.gpu : 0;
  }

  async start(wallet) {
    if (this.status === 'mining' || this.status === 'starting') return;
    this.wallet = wallet;
    this.status = 'starting';
    this.error = null;
    this.changed();
    try {
      await this.newTicket();
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.note(`could not get a challenge: ${err.message}`, 'bad');
      return;
    }
    this.status = 'mining';
    this.resizeWorkers(this.threads);
    if (this.gpuEnabled) await this.startGpu();
    this.window = { cpu: 0, gpu: 0, since: performance.now() };
    this.sampler = setInterval(() => this.sample(), 1000);
    this.refresh = setInterval(() => this.maybeRefreshTicket(), 5000);
    this.note(`surveying as ${short(wallet)} · ${this.threads} CPU thread${this.threads > 1 ? 's' : ''}${this.gpu?.running ? ' + GPU' : ''}`);
  }

  stop() {
    if (this.status === 'idle') return;
    this.resizeWorkers(0);
    this.gpu?.stop();
    clearInterval(this.sampler);
    clearInterval(this.refresh);
    this.status = 'idle';
    this.ticket = null;
    this.tickets.clear();
    this.samples.push({ at: Date.now(), cpu: 0, gpu: 0 });
    this.note('stopped');
  }

  async post(path, body) {
    const res = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.code = data.error;
      err.retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
      throw err;
    }
    return data;
  }

  // Coalesces concurrent requests into one.
  newTicket() {
    this.ticketRequest ??= this.fetchTicket().finally(() => { this.ticketRequest = null; });
    return this.ticketRequest;
  }

  async fetchTicket() {
    const t = await this.post('/api/challenge', { wallet: this.wallet, hashrate: this.hashrate });
    this.ticket = { ...t, jobId: ++this.jobId, expiresAt: Date.parse(t.expires_at) };
    this.tickets.set(this.ticket.jobId, this.ticket);
    for (const id of this.tickets.keys()) if (id < this.jobId - 3) this.tickets.delete(id);
    const job = { type: 'job', jobId: this.ticket.jobId, seed: t.seed, difficulty: t.difficulty };
    for (const w of this.workers) w.postMessage(job);
    this.gpu?.setJob(job);
    this.note(`ticket ${t.challenge_id.slice(0, 8)} · difficulty ${t.difficulty} bits · round ${t.round}`);
  }

  maybeRefreshTicket() {
    if (this.status === 'mining' && this.ticket && this.ticket.expiresAt - Date.now() < 20_000) {
      this.newTicket().catch(err => this.note(`ticket refresh failed: ${err.message}`, 'bad'));
    }
  }

  resizeWorkers(n) {
    while (this.workers.length > n) this.workers.pop().terminate();
    while (this.workers.length < n) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => this.fromWorker(data);
      w.postMessage({ type: 'duty', duty: this.cpuDuty });
      if (this.ticket) w.postMessage({ type: 'job', jobId: this.ticket.jobId, seed: this.ticket.seed, difficulty: this.ticket.difficulty });
      w.postMessage({ type: 'start' });
      this.workers.push(w);
    }
  }

  fromWorker(msg) {
    if (msg.type === 'hashes') this.window.cpu += msg.count;
    if (msg.type === 'found') this.submit(msg.jobId, msg.nonce);
  }

  setThreads(n) {
    this.threads = n;
    if (this.status === 'mining') this.resizeWorkers(n);
    this.changed();
  }

  setCpuDuty(d) {
    this.cpuDuty = d;
    for (const w of this.workers) w.postMessage({ type: 'duty', duty: d });
    this.changed();
  }

  setGpuDuty(d) {
    this.gpuDuty = d;
    if (this.gpu) this.gpu.duty = d;
    this.changed();
  }

  async setGpu(on) {
    this.gpuEnabled = on;
    if (!on) this.gpu?.stop();
    else if (this.status === 'mining') await this.startGpu();
    this.changed();
  }

  async startGpu() {
    try {
      if (!this.gpu) {
        this.note('starting GPU · running self-test');
        this.gpu = await GpuMiner.create();
        this.gpuName = this.gpu.name;
        this.gpu.onFound = (jobId, nonce) => this.submit(jobId, nonce);
        this.gpu.onHashes = n => { this.window.gpu += n; };
        this.gpu.onError = err => { this.gpuError = err.message; this.note(`GPU stopped: ${err.message}`, 'bad'); };
        this.note(`GPU ready · ${this.gpuName} · self-test passed`, 'good');
      }
      this.gpu.duty = this.gpuDuty;
      if (this.ticket) this.gpu.setJob({ jobId: this.ticket.jobId, seed: this.ticket.seed, difficulty: this.ticket.difficulty });
      this.gpu.start();
      this.gpuError = null;
    } catch (err) {
      this.gpuEnabled = false;
      this.gpuError = err.message;
      this.note(`GPU unavailable: ${err.message}. CPU survey continues.`, 'bad');
    }
    this.changed();
  }

  async submit(jobId, nonce) {
    const t = this.tickets.get(jobId);
    if (this.status !== 'mining' || !t) return;
    // Finding proofs faster than we may submit them means the ticket is too
    // easy for this device: drop the extra and ask for a harder one.
    const now = Date.now();
    this.submits = this.submits.filter(at => at > now - 1000);
    if (this.submits.length >= MAX_SUBMITS_PER_SEC) {
      if (this.ticket === t) this.newTicket().catch(() => {});
      return;
    }
    this.submits.push(now);
    try {
      const r = await this.post('/api/proof', { challenge_id: t.challenge_id, wallet: this.wallet, nonce });
      this.accepted++;
      this.credited += r.credit;
      this.lastProof = { hash: r.hash, difficulty: r.difficulty };
      this.note(`proof accepted · ${r.hash.slice(0, 16)}… · +2^${r.difficulty} hashes`, 'good');
      if (r.retarget && this.ticket === t) await this.newTicket();
    } catch (err) {
      if (RETRYABLE.has(err.code)) {
        this.tickets.delete(jobId);
        if (this.ticket === t) await this.newTicket().catch(() => {});
        return;
      }
      if (err.code === 'duplicate') return;
      if (err.code === 'rate_limited') {
        if (this.ticket === t) this.newTicket().catch(() => {});
        return;
      }
      this.rejected++;
      this.note(`proof rejected · ${err.message}`, 'bad');
    }
  }

  sample() {
    const now = performance.now();
    const secs = (now - this.window.since) / 1000;
    this.samples.push({ at: Date.now(), cpu: this.window.cpu / secs, gpu: this.window.gpu / secs });
    this.samples = this.samples.slice(-90);
    this.window = { cpu: 0, gpu: 0, since: now };
    const fits = Math.round(Math.log2(Math.max(1, this.hashrate * SECONDS_PER_PROOF)));
    if (this.status === 'mining' && this.ticket && fits > this.ticket.difficulty + 1) this.newTicket().catch(() => {});
    this.changed();
  }
}

export function short(addr) {
  return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '';
}
