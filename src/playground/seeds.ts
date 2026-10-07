/**
 * THE SEED A LABEL STANDS FOR. Development bookkeeping: the playground names
 * Blobbis with short labels such as `pattern-0`, and each label stands for
 * one real 64-digit seed, derived exactly as the blobbi-procedural lab
 * derives it (`seedFor` in its `src/kit.ts`), so `pattern-0` here is the
 * same individual as `pattern-0` in the 2D lab. A label that already is a
 * seed stands for itself. This has no part in what a Blobbi looks like.
 */
import { canonicalBlobbiSeed } from '@blobbi-kit/3d';

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
