// CPU mining worker. Hashes in short bursts so it can be throttled with a duty
// cycle and so new jobs take effect within ~100 ms.
import { hexToWords, midstate, nonceHex, search } from './sha.js';

const SLICE_MS = 100;
const BATCH = 4096;
const w = new Int32Array(64);
const out = new Int32Array(8);

let job = null;   // { jobId, seed, mid, difficulty }
let hi = 0, lo = 0;
let used = 0;    // nonces tried under the current high word
let duty = 1;
let running = false;
let pending = 0;  // hashes not yet reported

function setJob(j) {
  const seed = hexToWords(j.seed);
  job = { jobId: j.jobId, seed, mid: midstate(seed), difficulty: j.difficulty };
  freshHi();
}

function freshHi() {
  hi = crypto.getRandomValues(new Int32Array(1))[0];
  lo = 0;
  used = 0;
}

async function loop() {
  let lastReport = performance.now();
  while (running) {
    const start = performance.now();
    while (job && performance.now() - start < SLICE_MS * duty) {
      const i = search(job.mid, job.seed, hi, lo, BATCH, job.difficulty, w, out);
      if (i >= 0) {
        postMessage({ type: 'found', jobId: job.jobId, nonce: nonceHex(hi, lo + i) });
        pending += i + 1;
        used += i + 1;
        lo = (lo + i + 1) | 0;
      } else {
        pending += BATCH;
        used += BATCH;
        lo = (lo + BATCH) | 0;
      }
      // About to wrap the low word: move to a fresh, random high word.
      if (used > 2 ** 32 - 2 * BATCH) freshHi();
    }
    const now = performance.now();
    if (now - lastReport >= 500) {
      postMessage({ type: 'hashes', count: pending, ms: now - lastReport });
      pending = 0;
      lastReport = now;
    }
    const rest = job ? SLICE_MS * (1 - duty) : SLICE_MS;
    await new Promise(r => setTimeout(r, Math.max(0, rest)));
  }
}

onmessage = ({ data }) => {
  if (data.type === 'job') setJob(data);
  if (data.type === 'duty') duty = Math.min(1, Math.max(0.05, data.duty));
  if (data.type === 'start' && !running) { running = true; loop(); }
  if (data.type === 'stop') { running = false; job = null; }
};
