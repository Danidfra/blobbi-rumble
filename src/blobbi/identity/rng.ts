/**
 * Deterministic, seeded randomness: a faithful port of the blobbi-kit
 * procedural engine's `rng.ts` (`@blobbi-kit/renderer`, procedural V3,
 * algorithm 1). It must stay bit-for-bit identical to the kit's, because a
 * gene's value IS the first draws of its keyed stream: a 3D Blobbi only is
 * the same Blobbi as its 2D drawing while these numbers agree.
 *
 *  - PURE INTEGER MATH (`Math.imul`, 32-bit shifts): every JS engine
 *    produces the same stream.
 *  - KEYED STREAMS: a gene is drawn from `geneRng(seed, 'morphology.bodyWidth')`,
 *    a stream of its own, never "the next value of one shared generator".
 *    Adding genes for 3D (say, a depth gene) never changes an existing one.
 *
 * Nothing here, or downstream of it, calls `Math.random()`.
 */

/** cyrb128: four well-mixed 32-bit words from a string. */
export function hashSeed(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A value in [-1, 1] concentrated around 0 (the mean of two uniforms). This is what a gene is. */
  centered(): number;
  pick<T>(items: readonly T[]): T;
}

/** sfc32 over a hashed seed: small, fast, 32-bit only. */
export function createRng(seed: string): Rng {
  let [a, b, c, d] = hashSeed(seed);
  const next = (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Warm up: the first outputs of sfc32 correlate with the seed words.
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    centered: () => next() + next() - 1,
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}

/** The stream that belongs to one named gene of one seed. */
export function geneRng(seed: string, key: string): Rng {
  return createRng(`${seed}\u0000${key}`);
}
