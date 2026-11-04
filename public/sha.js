// SHA-256 kernel for the proof-of-work puzzle.
//
// The message is always 40 bytes: seed (32 bytes) || nonce (8 bytes, big-endian),
// so it fits in a single 64-byte block. The nonce is split into two 32-bit words,
// `hi` and `lo`. Words are stored as signed int32 (JS bitwise ops), which is
// bit-identical to uint32.

export const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

export function hexToWords(hex) {
  const w = new Int32Array(hex.length / 8);
  for (let i = 0; i < w.length; i++) w[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) | 0;
  return w;
}

export function wordsToHex(words) {
  let s = '';
  for (const x of words) s += (x >>> 0).toString(16).padStart(8, '0');
  return s;
}

export function nonceHex(hi, lo) {
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

// Rounds 0-7 only read the seed words, so their result is the same for every
// nonce. Computing them once per job saves 1/8 of the work per hash.
export function midstate(seed) {
  let a = IV[0], b = IV[1], c = IV[2], d = IV[3], e = IV[4], f = IV[5], g = IV[6], h = IV[7];
  for (let i = 0; i < 8; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + seed[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  return Int32Array.of(a, b, c, d, e, f, g, h);
}

// Finishes rounds 8-63 for one nonce and writes the 8 digest words into `out`.
// `w` is a 64-word scratch buffer owned by the caller.
export function compress(mid, seed, hi, lo, w, out) {
  for (let i = 0; i < 8; i++) w[i] = seed[i];
  w[8] = hi; w[9] = lo; w[10] = 0x80000000 | 0;
  w[11] = 0; w[12] = 0; w[13] = 0; w[14] = 0; w[15] = 320;
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (s1 + w[i - 7] + s0 + w[i - 16]) | 0;
  }
  let a = mid[0], b = mid[1], c = mid[2], d = mid[3], e = mid[4], f = mid[5], g = mid[6], h = mid[7];
  for (let i = 8; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  out[0] = (IV[0] + a) | 0; out[1] = (IV[1] + b) | 0; out[2] = (IV[2] + c) | 0; out[3] = (IV[3] + d) | 0;
  out[4] = (IV[4] + e) | 0; out[5] = (IV[5] + f) | 0; out[6] = (IV[6] + g) | 0; out[7] = (IV[7] + h) | 0;
}

export function leadingZeroBits(digest) {
  const z = Math.clz32(digest[0]);
  return z < 32 ? z : 32 + Math.clz32(digest[1]);
}

// Tries nonces (hi, lo), (hi, lo+1), ... for `count` steps. Returns the offset of
// the first nonce whose digest has at least `difficulty` leading zero bits, or -1.
export function search(mid, seed, hi, lo, count, difficulty, w, out) {
  for (let i = 0; i < count; i++) {
    compress(mid, seed, hi, (lo + i) | 0, w, out);
    if (Math.clz32(out[0]) >= difficulty || (out[0] === 0 && leadingZeroBits(out) >= difficulty)) return i;
  }
  return -1;
}
