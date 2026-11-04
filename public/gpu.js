// WebGPU miner: the same puzzle as sha.js, run as a compute shader.
import { compress, hexToWords, midstate, nonceHex } from './sha.js';

const WORKGROUP = 256;
const MAX_FOUND = 8;

const K_WGSL = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map(k => `0x${k.toString(16).padStart(8, '0')}u`).join(', ');

// Params layout (u32): mid[0..7], seed[8..15], hi 16, base 17, difficulty 18, iters 19, probe 20.
// Output layout (u32): count 0, probe h0 1, probe h1 2, unused 3, found lo[4..11].
const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> p: array<u32, 21>;
@group(0) @binding(1) var<storage, read_write> o: array<atomic<u32>, ${4 + MAX_FOUND}>;

var<private> K: array<u32, 64> = array<u32, 64>(${K_WGSL});

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  var w: array<u32, 64>;
  for (var i = 0u; i < 8u; i++) { w[i] = p[8u + i]; }
  w[8] = p[16];
  w[10] = 0x80000000u;
  w[11] = 0u; w[12] = 0u; w[13] = 0u; w[14] = 0u;
  w[15] = 320u;

  let iters = p[19];
  for (var it = 0u; it < iters; it++) {
    let lo = p[17] + gid.x * iters + it;
    w[9] = lo;
    for (var i = 16u; i < 64u; i++) {
      let x = w[i - 15u];
      let y = w[i - 2u];
      let s0 = rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u);
      let s1 = rotr(y, 17u) ^ rotr(y, 19u) ^ (y >> 10u);
      w[i] = s1 + w[i - 7u] + s0 + w[i - 16u];
    }
    var a = p[0]; var b = p[1]; var c = p[2]; var d = p[3];
    var e = p[4]; var f = p[5]; var g = p[6]; var h = p[7];
    for (var i = 8u; i < 64u; i++) {
      let t1 = h + (rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      let t2 = (rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    let h0 = 0x6a09e667u + a;
    let h1 = 0xbb67ae85u + b;
    var zeros = countLeadingZeros(h0);
    if (h0 == 0u) { zeros = 32u + countLeadingZeros(h1); }
    if (zeros >= p[18]) {
      let slot = atomicAdd(&o[0], 1u);
      if (slot < ${MAX_FOUND}u) { atomicStore(&o[4u + slot], lo); }
    }
    if (p[20] == 1u && lo == p[17]) {
      atomicStore(&o[1], h0);
      atomicStore(&o[2], h1);
    }
  }
}`;

export class GpuMiner {
  static async create() {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');
    if (adapter.info?.isFallbackAdapter) throw new Error('Only a software GPU is available');
    const device = await adapter.requestDevice();
    const miner = new GpuMiner(device, adapter.info);
    await miner.selfTest();
    return miner;
  }

  constructor(device, info) {
    this.device = device;
    this.name = [info?.vendor, info?.architecture || info?.description].filter(Boolean).join(' ') || 'GPU';
    this.module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: this.module, entryPoint: 'main' } });
    this.params = device.createBuffer({ size: 21 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.out = device.createBuffer({ size: (4 + MAX_FOUND) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.read = device.createBuffer({ size: (4 + MAX_FOUND) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.params } }, { binding: 1, resource: { buffer: this.out } }],
    });
    this.workgroups = 128;
    this.iters = 16;
    this.duty = 1;
    this.running = false;
    this.job = null;
    this.onFound = () => {};
    this.onHashes = () => {};
    this.onError = () => {};
  }

  async dispatch(mid, seed, hi, base, difficulty, iters, workgroups, probe) {
    const params = new Uint32Array(21);
    params.set(new Uint32Array(mid.buffer), 0);
    params.set(new Uint32Array(seed.buffer), 8);
    params[16] = hi; params[17] = base; params[18] = difficulty; params[19] = iters; params[20] = probe ? 1 : 0;
    this.device.queue.writeBuffer(this.params, 0, params);
    this.device.queue.writeBuffer(this.out, 0, new Uint32Array(4 + MAX_FOUND));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, this.read, 0, (4 + MAX_FOUND) * 4);
    this.device.queue.submit([enc.finish()]);
    await this.read.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(this.read.getMappedRange().slice(0));
    this.read.unmap();
    return result;
  }

  // Hashes one known nonce on the GPU and compares it with the JS kernel, so a
  // driver or shader bug can't silently waste work on bad proofs.
  async selfTest() {
    const seed = crypto.getRandomValues(new Int32Array(8));
    const mid = midstate(seed);
    const hi = 0x01234567, base = 0x89abcdef;
    const r = await this.dispatch(mid, seed, hi, base, 64, 1, 1, true);
    const expected = new Int32Array(8);
    compress(mid, seed, hi, base | 0, new Int32Array(64), expected);
    if (r[1] !== expected[0] >>> 0 || r[2] !== expected[1] >>> 0) throw new Error('GPU self-test failed: hashes do not match');
  }

  setJob({ jobId, seed, difficulty }) {
    const s = hexToWords(seed);
    this.job = { jobId, seed: s, mid: midstate(s), difficulty };
    this.hi = crypto.getRandomValues(new Uint32Array(1))[0];
    this.base = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch(err => {
      this.running = false;
      this.onError(err);
    });
  }

  stop() { this.running = false; }

  async loop() {
    while (this.running) {
      const job = this.job;
      if (!job) { await sleep(100); continue; }
      const count = this.workgroups * WORKGROUP * this.iters;
      const t0 = performance.now();
      const r = await this.dispatch(job.mid, job.seed, this.hi, this.base, job.difficulty, this.iters, this.workgroups, false);
      const ms = performance.now() - t0;
      if (job === this.job) {
        for (let i = 0; i < Math.min(r[0], MAX_FOUND); i++) this.onFound(job.jobId, nonceHex(this.hi, r[4 + i]));
        this.base += count;
        if (this.base >= 2 ** 32 - count) {
          this.hi = crypto.getRandomValues(new Uint32Array(1))[0];
          this.base = 0;
        }
      }
      this.onHashes(count, ms);
      // Aim for ~50 ms per dispatch: long enough to keep the GPU busy, short
      // enough to stay clear of driver watchdogs and keep the page responsive.
      if (ms < 30 && this.iters < 1024) this.iters *= 2;
      else if (ms > 90 && this.iters > 1) this.iters /= 2;
      if (this.duty < 1) await sleep(ms * (1 - this.duty) / this.duty);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
