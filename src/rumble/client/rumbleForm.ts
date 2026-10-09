/**
 * THE RUMBLE FORM (M9B): what a Blobbi looks like while it plays here.
 *
 *   Blobbi identity ≠ Blobbi form
 *
 * A Blobbi is a formless creature: its identity (kind 31124 at its owner's
 * address) persists; the form it takes depends on where it is. In Rumble
 * every fighter is an ADULT PROCEDURAL BLOBBI (the kit's 3D model, the
 * only body this game animates), so a visiting Blobbi temporarily takes
 * that form. Nothing about the Blobbi changes: not its event, its stage,
 * its generation or its 2D look; nothing is published.
 *
 * One transformation, canonical Blobbi → adult Rumble form:
 *
 *   V3, adult            its own identity as it is                 native
 *   V3, egg or baby      the same identity, adult body             adult-stage
 *   V1 / V2, any stage   the V3 identity of the SAME ADDRESS       legacy
 *                        (the kit's own seed rule, Algorithm 1),
 *                        wearing the Blobbi's own colours
 *   unknown generation   no form: the default fighter
 *
 * The legacy derivation reuses `deriveBlobbiV3Seed(owner, d)`: the exact
 * function a V3 Blobbi at that address would be drawn from. No second hash,
 * no RNG, no clock, no event id (a replaceable event's id changes; its
 * address does not), so the same Blobbi has the same form on every device
 * and after every care, rename, hatch or evolution.
 */
import { deriveBlobbiV3Seed, type BlobbiStage, type BlobbiVisualGeneration } from '@blobbi-kit/core';
import type { OwnedBlobbi } from './blobbis';

/** The rule above, as a version: bump only with a reason, and keep the old forms drawable. */
export const RUMBLE_FORM_VERSION = 1;

export type FormDerivation = 'native' | 'adult-stage' | 'legacy';

/** What the 3D kit takes (its own `BlobbiV3Visual`): the seed under Algorithm 1, plus stated colours for a legacy Blobbi. */
export interface RumbleLook {
  seed: string;
  algorithm: 1;
  colors?: { base: string; secondary: string; eye: string };
}

export interface RumbleForm {
  /** The canonical Blobbi this form stands in for (unchanged by it). */
  blobbi: { owner: string; d: string; name: string; stage: BlobbiStage; generation: BlobbiVisualGeneration };
  look: RumbleLook;
  derivation: FormDerivation;
  /** Whether the Blobbi's own V1 / V2 colours are worn (a legacy form with valid colours). */
  ownColors: boolean;
  /** The same look has the same key: what built geometry may be cached and compared by. */
  key: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const HEX_SEED = /^[0-9a-f]{64}$/;

/** The Rumble form of an owned Blobbi, or null when it has none (an unknown generation, or no address to derive from). Pure. */
export function rumbleFormOf(b: OwnedBlobbi, owner: string): RumbleForm | null {
  if (!b || b.unsupported || typeof b.d !== 'string' || !b.d) return null;
  let seed: string;
  try {
    seed = deriveBlobbiV3Seed(owner, b.d);
  } catch {
    return null;
  }
  if (!HEX_SEED.test(seed)) return null;
  const blobbi = { owner, d: b.d, name: b.name, stage: b.stage, generation: b.generation } as const;
  if (b.generation === 'v3') {
    // Its own identity: the kit derived the same seed from the same address (checked, not trusted).
    const own = b.visual.v3?.seed;
    if (own !== undefined && own !== seed) return null;
    return { blobbi, look: { seed, algorithm: 1 }, derivation: b.stage === 'adult' ? 'native' : 'adult-stage', ownColors: false, key: `v${RUMBLE_FORM_VERSION}:${seed}` };
  }
  const colors = [b.visual.baseColor, b.visual.secondaryColor, b.visual.eyeColor].map((c) => (typeof c === 'string' && HEX_COLOR.test(c) ? c.toLowerCase() : null));
  const own = colors.every((c): c is string => c !== null);
  const look: RumbleLook = own ? { seed, algorithm: 1, colors: { base: colors[0]!, secondary: colors[1]!, eye: colors[2]! } } : { seed, algorithm: 1 };
  return { blobbi, look, derivation: 'legacy', ownColors: own, key: `v${RUMBLE_FORM_VERSION}:${seed}${own ? `:${colors.join('')}` : ''}` };
}

/**
 * Which fighter wears which look, as the page sees it: the player's slot
 * gets the chosen form; any slot that had a form and should not any more
 * (the player moved slot, chose the default, disconnected) goes back to the
 * default. Pure: the page keeps `prev` and applies the changes in order.
 */
export interface Worn {
  slot: string;
  key: string;
}
export type LookChange = { slot: string; form: RumbleForm | null };

export function planLook(prev: Worn | null, slot: string | null, form: RumbleForm | null): { next: Worn | null; changes: LookChange[] } {
  const want: Worn | null = slot && form ? { slot, key: form.key } : null;
  if (prev?.slot === want?.slot && prev?.key === want?.key) return { next: prev, changes: [] };
  const changes: LookChange[] = [];
  if (prev && prev.slot !== want?.slot) changes.push({ slot: prev.slot, form: null });
  if (want) changes.push({ slot: want.slot, form });
  return { next: want, changes };
}
