/**
 * THE GENOME: what a Blobbi physically is. A faithful port of the blobbi-kit
 * procedural engine's `genome.ts` (algorithm 1), minus the egg's shell genes,
 * which a 3D character does not need (every gene has its own keyed stream,
 * so leaving the egg out changes nothing else).
 *
 * A gene is a number in [-1, 1] where 0 IS THE CANONICAL BLOBBI. The genome
 * knows nothing about pixels, metres, meshes or views: `morphology/` owns how
 * a gene shows, and the 3D builders own how it shows in space.
 *
 * Two layers of identity, kept apart on purpose:
 *
 *  - SEMANTIC identity (colours, the kind of each trait, the pattern, the
 *    mark) is what an event states explicitly. It can be passed in
 *    (`GenerateGenomeInput`); the seed only supplies it when nothing is.
 *  - MICRO-GEOMETRY (exact horn curvature, eye spacing, spot positions) is
 *    always derived from the seed. Trait genes are generated even when the
 *    trait is off, so switching a trait on reveals THIS individual's horns.
 */
import { geneRng } from './rng';
import { generateColors, sanitizeHex, type BlobbiColors, type ColorScheme } from './colors';

/** The procedural algorithm version this port implements (the kit's `PROCEDURAL_ALGORITHM_VERSION`). */
export const PROCEDURAL_ALGORITHM_VERSION = 1;

export const MORPHOLOGY_GENES = [
  'bodyWidth',
  'bodyHeight',
  'topWidth',
  'belly',
  'roundness',
  'lean',
  'eyeSize',
  'eyeSpacing',
  'eyeHeight',
  'eyeTilt',
  'pupilSize',
  'mouthWidth',
  'mouthHeight',
  'mouthCurve',
  'browHeight',
  'cheekSize',
  'armSize',
  'armHeight',
  'footSize',
  'footSpacing',
  'tuftSize',
  'tuftTilt',
  'tuftSpread',
  'tuftLength',
] as const;

export type MorphologyGeneName = (typeof MORPHOLOGY_GENES)[number];
export type MorphologyGenes = Record<MorphologyGeneName, number>;

export type AntennaCount = 0 | 1 | 2;

export interface AntennaGenes {
  count: AntennaCount;
  side: -1 | 1;
  position: number;
  length: number;
  thickness: number;
  curvature: number;
  tilt: number;
  sweep: number;
  tipSize: number;
  asymmetry: number;
  fore: number;
}

export const ANTENNA_GENES = ['position', 'length', 'thickness', 'curvature', 'tilt', 'sweep', 'tipSize', 'asymmetry', 'fore'] as const;
export type AntennaGeneName = (typeof ANTENNA_GENES)[number];

export const HORN_KINDS = ['none', 'forehead', 'top', 'side'] as const;
export type HornKind = (typeof HORN_KINDS)[number];
export const HORN_GENES = ['length', 'width', 'curvature', 'tilt', 'roundness', 'asymmetry', 'position', 'fore'] as const;
export type HornGeneName = (typeof HORN_GENES)[number];
export type HornGenes = { kind: HornKind } & Record<HornGeneName, number>;

export const EAR_KINDS = ['none', 'round', 'pointed'] as const;
export type EarKind = (typeof EAR_KINDS)[number];
export const EAR_GENES = ['size', 'tilt', 'flop', 'position'] as const;
export type EarGeneName = (typeof EAR_GENES)[number];
export type EarGenes = { kind: EarKind } & Record<EarGeneName, number>;

export const TAIL_KINDS = ['none', 'nub', 'curl', 'leaf'] as const;
export type TailKind = (typeof TAIL_KINDS)[number];
export const TAIL_GENES = ['size', 'length', 'curvature', 'lift'] as const;
export type TailGeneName = (typeof TAIL_GENES)[number];
export type TailGenes = { kind: TailKind } & Record<TailGeneName, number>;

export interface SpotGene {
  dx: number;
  dy: number;
  size: number;
  rotation: number;
}

export type MarkingSide = 'left' | 'right' | 'both';

export const PATTERN_KINDS = ['solid', 'spotted', 'striped', 'gradient'] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export interface SpotsGenes {
  side: MarkingSide;
  count: 2 | 3;
  marks: SpotGene[];
  backCount: 2 | 3;
  back: SpotGene[];
}

export interface StripesGenes {
  count: 3 | 4;
  sag: number;
  bands: { dy: number; width: number; reach: number }[];
}

export interface GradientGenes {
  start: number;
  strength: number;
}

export interface PatternGenes {
  kind: PatternKind;
  spots: SpotsGenes;
  stripes: StripesGenes;
  gradient: GradientGenes;
}

export const MARK_KINDS = ['none', 'star', 'heart', 'sparkle', 'moon'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface MarkGenes {
  kind: MarkKind;
  side: -1 | 1;
  region: number;
  u: number;
  v: number;
  size: number;
  rotation: number;
}

export interface BellyGenes {
  enabled: boolean;
  size: number;
  height: number;
}

export interface FreckleGene {
  dx: number;
  dy: number;
  size: number;
}

export interface FrecklesGenes {
  enabled: boolean;
  dots: FreckleGene[];
}

export interface BlobbiTraits {
  antenna: AntennaGenes;
  horns: HornGenes;
  ears: EarGenes;
  tail: TailGenes;
  pattern: PatternGenes;
  mark: MarkGenes;
  belly: BellyGenes;
  freckles: FrecklesGenes;
}

export interface BlobbiGenome {
  version: number;
  seed: string;
  colors: BlobbiColors;
  scheme?: ColorScheme;
  morphology: MorphologyGenes;
  traits: BlobbiTraits;
}

/** The explicit, semantic part of an identity: what an event carries next to the seed. */
export interface BlobbiSemanticIdentity {
  /** `'authored'` keeps the artwork's own colours (the canonical purple); an object states them. */
  colors?: BlobbiColors | 'authored';
  antenna?: 'none' | 'single' | 'double';
  horns?: HornKind;
  ears?: EarKind;
  tail?: TailKind;
  pattern?: PatternKind;
  mark?: MarkKind;
  belly?: boolean;
  freckles?: boolean;
}

export interface GenerateGenomeInput extends BlobbiSemanticIdentity {
  seed: string;
}

const SPOT_SLOTS = 3;
const STRIPE_SLOTS = 4;
const FRECKLE_SLOTS = 3;

const ANTENNA_COUNT: Record<NonNullable<BlobbiSemanticIdentity['antenna']>, AntennaCount> = { none: 0, single: 1, double: 2 };

function resolveColors(seed: string, colors: BlobbiSemanticIdentity['colors']): { colors: BlobbiColors; scheme?: ColorScheme } {
  if (colors === 'authored') return { colors: {} };
  if (colors && typeof colors === 'object') {
    const out: BlobbiColors = {};
    for (const role of ['base', 'secondary', 'eye', 'accent'] as const) {
      const hex = sanitizeHex(colors[role]);
      if (hex) out[role] = hex;
    }
    return { colors: out };
  }
  const { scheme, ...generated } = generateColors(seed);
  return { colors: generated, scheme };
}

const pickKind = <T extends string>(kinds: readonly T[], value: unknown, fallback: T): T => (kinds.includes(value as T) ? (value as T) : fallback);

/** Derive a complete genome from a seed (and, optionally, explicit semantic identity). Pure. */
export function generateGenome(input: string | GenerateGenomeInput): BlobbiGenome {
  const { seed, ...semantic }: GenerateGenomeInput = typeof input === 'string' ? { seed: input } : input;
  const gene = (key: string) => geneRng(seed, key).centered();
  const roll = (key: string) => geneRng(seed, key).next();
  const genesFor = <N extends string>(group: string, names: readonly N[]) =>
    Object.fromEntries(names.map((name) => [name, gene(`${group}.${name}`)])) as Record<N, number>;

  const morphology = genesFor('morphology', MORPHOLOGY_GENES);

  const antennaKind = roll('antenna.kind');
  const antenna: AntennaGenes = {
    count: semantic.antenna ? (ANTENNA_COUNT[semantic.antenna] ?? 0) : antennaKind < 0.55 ? 0 : antennaKind < 0.85 ? 1 : 2,
    side: geneRng(seed, 'antenna.side').chance(0.5) ? 1 : -1,
    ...genesFor('antenna', ANTENNA_GENES),
  };

  const hornRoll = roll('horns.kind');
  const earRoll = roll('ears.kind');
  const tailRoll = roll('tail.kind');
  let hornKind: HornKind = hornRoll < 0.8 ? 'none' : hornRoll < 0.88 ? 'forehead' : hornRoll < 0.94 ? 'top' : 'side';
  let earKind: EarKind = earRoll < 0.86 ? 'none' : earRoll < 0.95 ? 'round' : 'pointed';
  const tailKind: TailKind = tailRoll < 0.5 ? 'none' : tailRoll < 0.72 ? 'nub' : tailRoll < 0.88 ? 'curl' : 'leaf';
  // A Blobbi's head is small: horns take the place of ears, and crown horns
  // move to the flanks when an antenna already stands there.
  if (hornKind !== 'none') earKind = 'none';
  if (hornKind === 'top' && antenna.count > 0) hornKind = 'side';

  const horns: HornGenes = { kind: pickKind(HORN_KINDS, semantic.horns, hornKind), ...genesFor('horns', HORN_GENES) };
  const ears: EarGenes = { kind: pickKind(EAR_KINDS, semantic.ears, earKind), ...genesFor('ears', EAR_GENES) };
  const tail: TailGenes = { kind: pickKind(TAIL_KINDS, semantic.tail, tailKind), ...genesFor('tail', TAIL_GENES) };

  const spotSide = roll('spots.side');
  const spotGenes = (group: string) =>
    Array.from({ length: SPOT_SLOTS }, (_, i) => ({
      dx: gene(`${group}.${i}.dx`),
      dy: gene(`${group}.${i}.dy`),
      size: gene(`${group}.${i}.size`),
      rotation: gene(`${group}.${i}.rotation`),
    }));
  const patternRoll = roll('pattern.kind');
  const patternKind: PatternKind = patternRoll < 0.4 ? 'solid' : patternRoll < 0.66 ? 'spotted' : patternRoll < 0.82 ? 'striped' : 'gradient';
  const pattern: PatternGenes = {
    kind: pickKind(PATTERN_KINDS, semantic.pattern, patternKind),
    spots: {
      side: spotSide < 0.45 ? 'right' : spotSide < 0.8 ? 'left' : 'both',
      count: geneRng(seed, 'spots.count').chance(0.7) ? 3 : 2,
      marks: spotGenes('spots'),
      backCount: geneRng(seed, 'spots.back.count').chance(0.6) ? 3 : 2,
      back: spotGenes('spots.back'),
    },
    stripes: {
      count: geneRng(seed, 'stripes.count').chance(0.5) ? 4 : 3,
      sag: gene('stripes.sag'),
      bands: Array.from({ length: STRIPE_SLOTS }, (_, i) => ({
        dy: gene(`stripes.${i}.dy`),
        width: gene(`stripes.${i}.width`),
        reach: gene(`stripes.${i}.reach`),
      })),
    },
    gradient: { start: gene('gradient.start'), strength: gene('gradient.strength') },
  };

  const markRoll = roll('mark.kind');
  const markKind: MarkKind = markRoll < 0.58 ? 'none' : markRoll < 0.7 ? 'star' : markRoll < 0.81 ? 'heart' : markRoll < 0.91 ? 'sparkle' : 'moon';
  const mark: MarkGenes = {
    kind: pickKind(MARK_KINDS, semantic.mark, markKind),
    side: geneRng(seed, 'mark.side').chance(0.5) ? 1 : -1,
    region: roll('mark.region'),
    u: gene('mark.u'),
    v: gene('mark.v'),
    size: gene('mark.size'),
    rotation: gene('mark.rotation'),
  };

  const belly: BellyGenes = {
    enabled: semantic.belly ?? geneRng(seed, 'belly.enabled').chance(0.25),
    size: gene('belly.size'),
    height: gene('belly.height'),
  };

  const freckles: FrecklesGenes = {
    enabled: semantic.freckles ?? geneRng(seed, 'freckles.enabled').chance(0.22),
    dots: Array.from({ length: FRECKLE_SLOTS }, (_, i) => ({
      dx: gene(`freckles.${i}.dx`),
      dy: gene(`freckles.${i}.dy`),
      size: gene(`freckles.${i}.size`),
    })),
  };

  const { colors, scheme } = resolveColors(seed, semantic.colors);
  const genome: BlobbiGenome = {
    version: PROCEDURAL_ALGORITHM_VERSION,
    seed,
    colors,
    morphology,
    traits: { antenna, horns, ears, tail, pattern, mark, belly, freckles },
  };
  if (scheme) genome.scheme = scheme;
  return genome;
}

const zeros = <N extends string>(names: readonly N[]) => Object.fromEntries(names.map((name) => [name, 0])) as Record<N, number>;

/** The canonical Blobbi as a genome: every gene 0, no optional trait, the artwork's own purple. */
export function canonicalGenome(): BlobbiGenome {
  return {
    version: PROCEDURAL_ALGORITHM_VERSION,
    seed: 'canonical',
    colors: {},
    morphology: zeros(MORPHOLOGY_GENES),
    traits: {
      antenna: { count: 0, side: 1, ...zeros(ANTENNA_GENES) },
      horns: { kind: 'none', ...zeros(HORN_GENES) },
      ears: { kind: 'none', ...zeros(EAR_GENES) },
      tail: { kind: 'none', ...zeros(TAIL_GENES) },
      pattern: {
        kind: 'solid',
        spots: {
          side: 'right',
          count: 3,
          marks: Array.from({ length: SPOT_SLOTS }, () => ({ dx: 0, dy: 0, size: 0, rotation: 0 })),
          backCount: 3,
          back: Array.from({ length: SPOT_SLOTS }, () => ({ dx: 0, dy: 0, size: 0, rotation: 0 })),
        },
        stripes: { count: 3, sag: 0, bands: Array.from({ length: STRIPE_SLOTS }, () => ({ dy: 0, width: 0, reach: 0 })) },
        gradient: { start: 0, strength: 0 },
      },
      mark: { kind: 'none', side: 1, region: 0, u: 0, v: 0, size: 0, rotation: 0 },
      belly: { enabled: false, size: 0, height: 0 },
      freckles: { enabled: false, dots: Array.from({ length: FRECKLE_SLOTS }, () => ({ dx: 0, dy: 0, size: 0 })) },
    },
  };
}

/** Clamp a gene to [-1, 1]; anything that is not a finite number is canonical (0). */
export function clampGene(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < -1 ? -1 : value > 1 ? 1 : value;
}
