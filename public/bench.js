// Device benchmark: runs the real CPU workers and WebGPU shader on an
// unsolvable ticket (difficulty 64) and measures raw hashes per second.
// Nothing is sent to the pool while it runs.
import { GpuMiner } from './gpu.js';

const SECONDS = 5;   // per phase

function randomSeed() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// onTick({ phase, rate, progress }) is called ~10×/s.
export async function runBench({ threads, gpu, onTick }) {
  const result = { threads, cpu: 0, gpu_rate: null, gpu: null };

  // CPU: every thread at full load
  {
    const workers = [];
    let hashes = 0;
    const job = { type: 'job', jobId: 1, seed: randomSeed(), difficulty: 64 };
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => { if (data.type === 'hashes') hashes += data.count; };
      w.postMessage({ type: 'duty', duty: 1 });
      w.postMessage(job);
      w.postMessage({ type: 'start' });
      workers.push(w);
    }
    const t0 = performance.now();
    await ticking(SECONDS, p => onTick({ phase: 'cpu', progress: p, rate: hashes / Math.max(0.5, (performance.now() - t0) / 1000) }));
    result.cpu = hashes / ((performance.now() - t0) / 1000);
    workers.forEach(w => w.terminate());
  }

  // GPU
  if (gpu && navigator.gpu) {
    try {
      const miner = await GpuMiner.create();
      result.gpu = miner.name;
      let hashes = 0;
      miner.duty = 1;
      miner.onHashes = n => { hashes += n; };
      miner.setJob({ jobId: 1, seed: randomSeed(), difficulty: 64 });
      miner.start();
      const t0 = performance.now();
      await ticking(SECONDS, p => onTick({ phase: 'gpu', progress: p, rate: hashes / Math.max(0.5, (performance.now() - t0) / 1000) }));
      result.gpu_rate = hashes / ((performance.now() - t0) / 1000);
      miner.stop();
      setTimeout(() => miner.device.destroy(), 500);
    } catch (err) {
      result.gpuError = err.message;
    }
  }
  return result;
}

function ticking(seconds, tick) {
  return new Promise(resolve => {
    const start = performance.now();
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / (seconds * 1000));
      tick(p);
      if (p >= 1) { clearInterval(id); resolve(); }
    }, 100);
  });
}

// A short, human label for the device, e.g. "macOS · Chrome".
export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}
