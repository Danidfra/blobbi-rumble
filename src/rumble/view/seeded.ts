/** A small seeded sequence in [0, 1) for deterministic decoration and scenery: the same look on every reload. */
export function seeded(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
