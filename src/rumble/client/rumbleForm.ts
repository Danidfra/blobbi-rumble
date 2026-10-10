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
import type { LookDeclaration } from '../net/looks';
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
    return { blobbi, look: { seed, algorithm: 1 }, derivation: b.stage === 'adult' ? 'native' : 'adult-stage', ownColors: false, key: keyOf(seed) };
  }
  const colors = [b.visual.baseColor, b.visual.secondaryColor, b.visual.eyeColor].map((c) => (typeof c === 'string' && HEX_COLOR.test(c) ? c.toLowerCase() : null));
  const own = colors.every((c): c is string => c !== null);
  const look: RumbleLook = own ? { seed, algorithm: 1, colors: { base: colors[0]!, secondary: colors[1]!, eye: colors[2]! } } : { seed, algorithm: 1 };
  return { blobbi, look, derivation: 'legacy', ownColors: own, key: keyOf(seed, look.colors) };
}

const HEX_SEED_KEY = /^[0-9a-f]{64}$/;

/** The look's key: the form version, the seed, and the colours when stated. The same on every client, so a fighter is rebuilt only for a different look. */
function keyOf(seed: string, colors?: { base: string; secondary: string; eye: string }): string {
  return `v${RUMBLE_FORM_VERSION}:${seed}${colors ? `:${colors.base}${colors.secondary}${colors.eye}` : ''}`;
}

/** What the page tells the server about its own form (M9C): the address, the generation, the worn colours and the name; never the seed (the server derives it). */
export function declarationOf(form: RumbleForm): LookDeclaration {
  return { v: 1, d: form.blobbi.d, gen: form.blobbi.generation, ...(form.ownColors && form.look.colors ? { colors: form.look.colors } : {}), ...(form.blobbi.name ? { name: form.blobbi.name } : {}) };
}

/**
 * A form as the roster carries it for any slot (M9C), re-checked here as
 * untrusted data: the version this page knows, a seed, hex colours only on
 * a V1 / V2 form. Null is the default fighter. The key matches the one the
 * owner's own page made for the same Blobbi.
 */
export function lookFromSlotForm(v: unknown): { look: RumbleLook; key: string; name: string | null } | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if (f.v !== RUMBLE_FORM_VERSION || typeof f.seed !== 'string' || !HEX_SEED_KEY.test(f.seed)) return null;
  const gen = f.gen;
  if (gen !== 'v1' && gen !== 'v2' && gen !== 'v3') return null;
  let colors: { base: string; secondary: string; eye: string } | undefined;
  if (f.colors !== undefined && gen !== 'v3') {
    const c = f.colors as Record<string, unknown>;
    const parts = ['base', 'secondary', 'eye'].map((k) => (c && typeof c[k] === 'string' && HEX_COLOR.test(c[k] as string) ? (c[k] as string).toLowerCase() : null));
    if (parts.every((x): x is string => x !== null)) colors = { base: parts[0], secondary: parts[1], eye: parts[2] };
  }
  const name = typeof f.name === 'string' && f.name.length <= 128 ? f.name : null;
  return { look: colors ? { seed: f.seed, algorithm: 1, colors } : { seed: f.seed, algorithm: 1 }, key: keyOf(f.seed, colors), name };
}

/**
 * Which fighter wears which look, as the page sees it (M9C: every slot,
 * from the roster): a slot whose wanted key differs from what it wears
 * changes; a slot that wanted something and now wants nothing goes back to
 * the default. Pure: the page keeps `prev` and applies the changes.
 */
export interface Wanted {
  key: string;
  look: RumbleLook;
}
export type LookChange = { slot: string; look: RumbleLook | null; key: string | null };

export function planLooks(prev: ReadonlyMap<string, string>, want: ReadonlyMap<string, Wanted>): { next: Map<string, string>; changes: LookChange[] } {
  const next = new Map<string, string>();
  const changes: LookChange[] = [];
  for (const [slot, w] of want) {
    next.set(slot, w.key);
    if (prev.get(slot) !== w.key) changes.push({ slot, look: w.look, key: w.key });
  }
  for (const slot of prev.keys()) if (!want.has(slot)) changes.push({ slot, look: null, key: null });
  return { next, changes };
}
