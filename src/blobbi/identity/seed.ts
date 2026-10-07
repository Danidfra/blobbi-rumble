/**
 * THE SEED. A Blobbi has one seed: `sha256("blobbi:v1|pubkey:d:created_at")`,
 * derived once by the domain kit (`@blobbi-kit/core`) and stored on its
 * event. It is 32 bytes written as 64 lower-case hexadecimal digits, and
 * that spelling is the only input the procedural algorithm is defined over:
 * the algorithm hashes the seed's CHARACTERS, so two spellings of the same
 * bytes would be two different individuals.
 *
 * This module mirrors `canonicalBlobbiV3Seed` from the kit: digits in any
 * letter case read as the same seed in lower case; anything else is not a
 * V3 seed and is never repaired (not trimmed, padded or hashed into shape).
 */

export const BLOBBI_SEED_LENGTH = 64;
const HEX_SEED = /^[0-9a-fA-F]{64}$/;

/** The canonical seed, or `undefined` when the value is not one. */
export function canonicalBlobbiSeed(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_SEED.test(value) ? value.toLowerCase() : undefined;
}

/**
 * THE SEED A LABEL STANDS FOR. Development tooling (the playground's preset
 * list) names Blobbis with short labels such as `pattern-0`. Each label
 * stands for one real 64-digit seed, derived exactly as the blobbi-procedural
 * lab derives it (`seedFor` in its `src/kit.ts`: FNV-1a over the label, eight
 * times from eight starting points), so `pattern-0` here is the same
 * individual as `pattern-0` in the 2D lab. A label that already is a seed
 * stands for itself.
 *
 * This is bookkeeping about WHICH Blobbi to show; it has no part in what a
 * Blobbi looks like.
 */
export function seedFromLabel(label: string): string {
  const own = canonicalBlobbiSeed(label);
  if (own) return own;
  let out = '';
  for (let word = 0; word < 8; word++) {
    let h = (0x811c9dc5 ^ (word * 0x9e3779b1)) >>> 0;
    for (let i = 0; i <= label.length; i++) {
      // The label's length closes it, so `a` and `a\0` are different labels.
      h = Math.imul(h ^ (i < label.length ? label.charCodeAt(i) : label.length + 0x10000), 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
