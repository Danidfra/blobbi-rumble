/**
 * BLOBBI IDENTITY, as the 3D renderer takes it: the same shape the domain
 * kit (`@blobbi-kit/core`, `BlobbiV3Identity`) stores on a kind 31124 event
 * and the 2D renderer (`@blobbi-kit/renderer`) draws from. A host that has a
 * Blobbi's parsed identity hands it straight in; nothing here is 3D-specific.
 *
 * ```
 *   identity ──► genome ──► 3D morphology ──► meshes, materials, rig
 *   (explicit    (seed,     (metres, bounded)
 *    colours     micro-
 *    + traits)   geometry)
 * ```
 *
 *  - EXPLICIT fields (colours, the kind of each trait) are decided ONCE by
 *    the seed at creation (`createBlobbiIdentity`) and then stored; a stated
 *    value always wins over what the seed would give today.
 *  - DERIVED micro-geometry (every proportion, every trait's exact size and
 *    place) is re-derived from the seed under the frozen algorithm version
 *    and never stored.
 *
 * This file is a port of the kit's `artwork/v3/identity.ts` contract. It is
 * what a future `@blobbi-kit/3d` would import from `@blobbi-kit/core` instead.
 */
import { canonicalBlobbiSeed } from './seed';
import {
  EAR_KINDS,
  HORN_KINDS,
  MARK_KINDS,
  PATTERN_KINDS,
  PROCEDURAL_ALGORITHM_VERSION,
  TAIL_KINDS,
  generateGenome,
  type BlobbiGenome,
  type EarKind,
  type HornKind,
  type MarkKind,
  type PatternKind,
  type TailKind,
} from './genome';
import { sanitizeHex } from './colors';

export const BLOBBI_ANTENNA_KINDS = ['none', 'single', 'double'] as const;
export type BlobbiAntennaKind = (typeof BLOBBI_ANTENNA_KINDS)[number];

export interface BlobbiIdentityColors {
  /** The body. */
  base: string;
  /** The pattern (spots, stripes, the deepening of a gradient). */
  secondary: string;
  /** The iris. */
  eye: string;
  /** Small details (antenna tips, a curled tail's tip, the special mark). Absent: no accent colour. */
  accent?: string;
}

export interface BlobbiIdentityTraits {
  antenna: BlobbiAntennaKind;
  horns: HornKind;
  ears: EarKind;
  tail: TailKind;
  pattern: PatternKind;
  specialMark: MarkKind;
  belly: boolean;
  freckles: boolean;
}

/** A complete identity: every explicit field stated. What creation produces and an event carries. */
export interface BlobbiIdentity {
  /** 64 lower-case hexadecimal digits. */
  seed: string;
  /** The procedural algorithm version the micro-geometry derives under. */
  algorithm: number;
  colors: BlobbiIdentityColors;
  traits: BlobbiIdentityTraits;
}

/** What a host may pass: an identity, possibly incomplete. Gaps are filled from the seed, deterministically. */
export interface BlobbiIdentityInput {
  seed: string;
  algorithm?: number;
  colors?: Partial<BlobbiIdentityColors>;
  traits?: Partial<BlobbiIdentityTraits>;
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

function identityOf(genome: BlobbiGenome): BlobbiIdentity {
  const { colors, traits } = genome;
  const out: BlobbiIdentity = {
    seed: genome.seed,
    algorithm: PROCEDURAL_ALGORITHM_VERSION,
    colors: { base: colors.base ?? '#8749ef', secondary: colors.secondary ?? colors.base ?? '#481696', eye: colors.eye ?? '#201538' },
    traits: {
      antenna: BLOBBI_ANTENNA_KINDS[traits.antenna.count] ?? 'none',
      horns: traits.horns.kind,
      ears: traits.ears.kind,
      tail: traits.tail.kind,
      pattern: traits.pattern.kind,
      specialMark: traits.mark.kind,
      belly: traits.belly.enabled,
      freckles: traits.freckles.enabled,
    },
  };
  if (colors.accent) out.colors.accent = colors.accent;
  return out;
}

/**
 * CREATE an identity for a seed: the colours and trait kinds this seed gives
 * under the current algorithm, stated explicitly. The same seed always
 * returns an equal identity.
 *
 * @throws TypeError when `seed` is not a V3 seed (64 hexadecimal digits).
 */
export function createBlobbiIdentity(seed: string): BlobbiIdentity {
  const canonical = canonicalBlobbiSeed(seed);
  if (canonical === undefined) throw new TypeError('[blobbi-3d] createBlobbiIdentity: a Blobbi seed is 64 hexadecimal digits.');
  return identityOf(generateGenome(canonical));
}

/**
 * Resolve loose input to a complete identity. A VALID EXPLICIT FIELD ALWAYS
 * WINS; the seed is consulted only for a field that is missing or
 * malformed, and every such field is reported in `inferred`. The colours
 * are one decision: with a valid `base` the palette is explicit (a missing
 * `accent` then means "no accent"); without one it is all the seed's.
 *
 * @throws TypeError when the seed is not a V3 seed or the algorithm is one this package does not implement.
 */
export function resolveBlobbiIdentity(input: BlobbiIdentityInput | string): { identity: BlobbiIdentity; inferred: string[] } {
  const raw: BlobbiIdentityInput = typeof input === 'string' ? { seed: input } : input;
  const seed = canonicalBlobbiSeed(raw.seed);
  if (seed === undefined) throw new TypeError('[blobbi-3d] resolveBlobbiIdentity: a Blobbi seed is 64 hexadecimal digits.');
  if (raw.algorithm !== undefined && raw.algorithm !== PROCEDURAL_ALGORITHM_VERSION) {
    throw new TypeError(`[blobbi-3d] resolveBlobbiIdentity: algorithm ${raw.algorithm} is not implemented (this package implements ${PROCEDURAL_ALGORITHM_VERSION}).`);
  }
  const own = identityOf(generateGenome(seed));
  const inferred: string[] = [];
  if (raw.algorithm === undefined) inferred.push('algorithm');

  const c = raw.colors ?? {};
  const base = sanitizeHex(c.base);
  let colors: BlobbiIdentityColors;
  if (base) {
    const secondary = sanitizeHex(c.secondary);
    const eye = sanitizeHex(c.eye);
    const accent = sanitizeHex(c.accent);
    colors = { base, secondary: secondary ?? own.colors.secondary, eye: eye ?? own.colors.eye };
    if (!secondary) inferred.push('colors.secondary');
    if (!eye) inferred.push('colors.eye');
    if (accent) colors.accent = accent;
    else if (c.accent !== undefined) inferred.push('colors.accent');
  } else {
    colors = { ...own.colors };
    inferred.push('colors');
  }

  const t = raw.traits ?? {};
  const read = <K extends keyof BlobbiIdentityTraits>(key: K, value: BlobbiIdentityTraits[K] | undefined): BlobbiIdentityTraits[K] => {
    if (value === undefined) {
      inferred.push(`traits.${key}`);
      return own.traits[key];
    }
    return value;
  };
  const traits: BlobbiIdentityTraits = {
    antenna: read('antenna', oneOf(BLOBBI_ANTENNA_KINDS, t.antenna)),
    horns: read('horns', oneOf(HORN_KINDS, t.horns)),
    ears: read('ears', oneOf(EAR_KINDS, t.ears)),
    tail: read('tail', oneOf(TAIL_KINDS, t.tail)),
    pattern: read('pattern', oneOf(PATTERN_KINDS, t.pattern)),
    specialMark: read('specialMark', oneOf(MARK_KINDS, t.specialMark)),
    belly: read('belly', flag(t.belly)),
    freckles: read('freckles', flag(t.freckles)),
  };
  return { identity: { seed, algorithm: PROCEDURAL_ALGORITHM_VERSION, colors, traits }, inferred };
}

/** The genome of an identity: its stated colours and trait kinds, and the seed's micro-geometry. */
export function genomeOf(identity: BlobbiIdentity): BlobbiGenome {
  return generateGenome({
    seed: identity.seed,
    colors: identity.colors,
    antenna: identity.traits.antenna,
    horns: identity.traits.horns,
    ears: identity.traits.ears,
    tail: identity.traits.tail,
    pattern: identity.traits.pattern,
    mark: identity.traits.specialMark,
    belly: identity.traits.belly,
    freckles: identity.traits.freckles,
  });
}
