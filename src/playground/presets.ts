/**
 * WHICH Blobbis the playground shows. Labels stand for real seeds exactly
 * as the 2D lab's do (`seedFromLabel`), so `pattern-0` here is `pattern-0`
 * there; the hex entries are real dev seeds from nostr-pet. The canonical
 * Blobbi (every gene at zero, the authored purple) is the comparison point.
 */
import { seedFromLabel } from '../blobbi/identity/seed';

export interface Preset {
  label: string;
  /** A real 64-digit seed, or `null` for the canonical Blobbi. */
  seed: string | null;
  note: string;
}

export const PRESETS: Preset[] = [
  { label: 'canonical', seed: null, note: 'every gene at 0, the authored purple' },
  { label: 'abc123', seed: seedFromLabel('abc123'), note: 'yellow, pointed ears, nub tail, sparkle, freckles' },
  { label: 'blobbi-0', seed: seedFromLabel('blobbi-0'), note: 'blue, side horns, leaf tail, spotted, sparkle' },
  { label: 'blobbi-1', seed: seedFromLabel('blobbi-1'), note: 'pink, double antenna, side horns, heart, freckles' },
  { label: 'blobbi-2', seed: seedFromLabel('blobbi-2'), note: 'indigo, double antenna, sparkle' },
  { label: 'pattern-0', seed: seedFromLabel('pattern-0'), note: 'orange, forehead horn, striped, sparkle' },
  { label: 'pattern-1', seed: seedFromLabel('pattern-1'), note: 'lime, top horns, gradient, freckles' },
  { label: 'mark-0', seed: seedFromLabel('mark-0'), note: 'rose, curl tail, sparkle' },
  { label: 'dev 0211d6…', seed: '0211d6400d3adb66bb5571fbdd4a2ed5c0f085989e9eec759d8edb9bccafccf7', note: 'a real nostr-pet dev seed' },
  { label: 'dev 0e7fed…', seed: '0e7fed6ddf4931589f0811a5cbf98f50d69c39f663940965e4c382acee280e1f', note: 'a real nostr-pet dev seed' },
  { label: 'dev 17a290…', seed: '17a290405d91d3b78724d1b6c96f9be415f3b5abfc88618049424681814ecb28', note: 'a real nostr-pet dev seed' },
  { label: 'dev 3157f1…', seed: '3157f17cae76b9e062dd3eda81561af0d0cb48e0b51c049fd0bae94881518b3e', note: 'a real nostr-pet dev seed' },
];
