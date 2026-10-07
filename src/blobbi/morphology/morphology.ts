/**
 * MORPHOLOGY: genes resolved to bounded numbers, in the kit's ROOT UNITS,
 * for the adult. A port of the kit's `morphology.ts` for the adult stage.
 *
 * This is where "procedural" is kept from meaning "random": every gene maps
 * linearly onto `base ± spread`, where `base` is the canonical Blobbi and
 * `spread` is how far an individual may drift from it. The spreads are the
 * kit's, deliberately small, so a hundred 3D Blobbis are a hundred
 * individuals of one species, and each one is the individual its 2D
 * drawing shows.
 *
 * Staying in root units here (not metres) is deliberate: the result is
 * comparable number for number with what the kit derives for the same seed
 * (`morphology.test.ts` pins it), and `geometry/` is the one place that
 * converts to metres.
 */
import {
  clampGene,
  MORPHOLOGY_GENES,
  type AntennaGeneName,
  type BlobbiGenome,
  type EarGeneName,
  type EarKind,
  type HornGeneName,
  type HornKind,
  type MarkKind,
  type MorphologyGeneName,
  type PatternKind,
  type TailGeneName,
  type TailKind,
} from '../identity/genome';
import { derivePalette, type BlobbiPalette } from '../identity/colors';
import { lerp } from '../geometry/math';
import { CANON_HEIGHT, FRONT_BODY, MARK_REGIONS, SURFACE, type MarkRegionName } from '../geometry/plan';
import { buildFrontBody, CANONICAL_PARAMS } from '../geometry/silhouette';

export interface GeneRange {
  base: number;
  spread: number;
  unit: 'scale' | 'units' | 'deg';
  label: string;
}

export const MORPHOLOGY_RANGES: Readonly<Record<MorphologyGeneName, GeneRange>> = {
  bodyWidth: { base: 1, spread: 0.07, unit: 'scale', label: 'Body width' },
  bodyHeight: { base: 1, spread: 0.05, unit: 'scale', label: 'Body height' },
  topWidth: { base: 1, spread: 0.1, unit: 'scale', label: 'Top width' },
  belly: { base: 1, spread: 0.08, unit: 'scale', label: 'Belly' },
  roundness: { base: 1, spread: 0.14, unit: 'scale', label: 'Roundness' },
  lean: { base: 0, spread: 6, unit: 'units', label: 'Crown lean' },
  eyeSize: { base: 1, spread: 0.09, unit: 'scale', label: 'Eye size' },
  eyeSpacing: { base: 1, spread: 0.08, unit: 'scale', label: 'Eye spacing' },
  eyeHeight: { base: 0, spread: 12, unit: 'units', label: 'Eye height' },
  eyeTilt: { base: 0, spread: 3, unit: 'units', label: 'Eye tilt' },
  pupilSize: { base: 1, spread: 0.08, unit: 'scale', label: 'Pupil size' },
  mouthWidth: { base: 1, spread: 0.12, unit: 'scale', label: 'Mouth width' },
  mouthHeight: { base: 0, spread: 9, unit: 'units', label: 'Mouth height' },
  mouthCurve: { base: 1, spread: 0.16, unit: 'scale', label: 'Mouth curve' },
  browHeight: { base: 0, spread: 6, unit: 'units', label: 'Brow height' },
  cheekSize: { base: 1, spread: 0.1, unit: 'scale', label: 'Cheek size' },
  armSize: { base: 1, spread: 0.1, unit: 'scale', label: 'Arm size' },
  armHeight: { base: 0, spread: 14, unit: 'units', label: 'Arm height' },
  footSize: { base: 1, spread: 0.08, unit: 'scale', label: 'Foot size' },
  footSpacing: { base: 1, spread: 0.07, unit: 'scale', label: 'Foot spacing' },
  tuftSize: { base: 1, spread: 0.15, unit: 'scale', label: 'Tuft size' },
  tuftTilt: { base: 0, spread: 8, unit: 'deg', label: 'Tuft lean' },
  tuftSpread: { base: 0, spread: 12, unit: 'deg', label: 'Tuft spread' },
  tuftLength: { base: 1, spread: 0.14, unit: 'scale', label: 'Tuft length' },
};

export const ANTENNA_RANGES: Readonly<Record<Exclude<AntennaGeneName, 'asymmetry'>, GeneRange>> = {
  position: { base: 0.56, spread: 0.14, unit: 'scale', label: 'Position' },
  length: { base: 74, spread: 18, unit: 'units', label: 'Length' },
  thickness: { base: 19, spread: 4, unit: 'units', label: 'Thickness' },
  curvature: { base: 0.1, spread: 0.26, unit: 'scale', label: 'Curvature' },
  tilt: { base: 15, spread: 11, unit: 'deg', label: 'Tilt' },
  sweep: { base: 8, spread: 12, unit: 'deg', label: 'Sweep' },
  tipSize: { base: 23, spread: 5, unit: 'units', label: 'Tip' },
  fore: { base: -0.05, spread: 0.4, unit: 'scale', label: 'Set (back / forward)' },
};

export const HORN_RANGES: Readonly<Record<Exclude<HornGeneName, 'asymmetry'>, GeneRange>> = {
  length: { base: 70, spread: 14, unit: 'units', label: 'Length' },
  width: { base: 58, spread: 7, unit: 'units', label: 'Width' },
  curvature: { base: 0, spread: 50, unit: 'deg', label: 'Curl' },
  tilt: { base: 14, spread: 9, unit: 'deg', label: 'Tilt' },
  roundness: { base: 0.6, spread: 0.12, unit: 'scale', label: 'Roundness' },
  position: { base: 0, spread: 1, unit: 'scale', label: 'Position' },
  fore: { base: 0.02, spread: 0.28, unit: 'scale', label: 'Set (back / forward)' },
};

export const EAR_RANGES: Readonly<Record<EarGeneName, GeneRange>> = {
  size: { base: 54, spread: 8, unit: 'units', label: 'Size' },
  tilt: { base: 36, spread: 10, unit: 'deg', label: 'Tilt' },
  flop: { base: 0.4, spread: 0.3, unit: 'scale', label: 'Flop' },
  position: { base: 0.115, spread: 0.03, unit: 'scale', label: 'Position (down the flank)' },
};

export const HORN_ANCHORS = { topLat: 0.46, topLatSpread: 0.07, sideHeight: 0.19, sideSpread: 0.035, foreheadHeight: 0.2, foreheadSpread: 0.03 } as const;
export const topHornLat = (position: number) => HORN_ANCHORS.topLat + position * HORN_ANCHORS.topLatSpread;
export const ANTENNA_BEHIND_HORN = 0.14;
export const ANTENNA_OUTSIDE_HORN = 0.15;

export const TAIL_RANGES: Readonly<Record<TailGeneName, GeneRange>> = {
  size: { base: 38, spread: 6, unit: 'units', label: 'Size' },
  length: { base: 78, spread: 14, unit: 'units', label: 'Length' },
  curvature: { base: 0.3, spread: 0.14, unit: 'scale', label: 'Curl' },
  lift: { base: 26, spread: 13, unit: 'deg', label: 'Lift' },
};

export interface AntennaMorphology {
  side: -1 | 1;
  position: number;
  fore: number;
  length: number;
  thickness: number;
  curvature: number;
  tilt: number;
  sweep: number;
  tipRadius: number;
}

export interface HornMorphology {
  kind: Exclude<HornKind, 'none'>;
  length: number;
  width: number;
  curvature: number;
  tilt: number;
  roundness: number;
  asymmetrySide: -1 | 1;
  asymmetry: number;
  position: number;
  fore: number;
}

export interface EarMorphology {
  kind: Exclude<EarKind, 'none'>;
  size: number;
  tilt: number;
  flop: number;
  position: number;
}

export interface TailMorphology {
  kind: Exclude<TailKind, 'none'>;
  size: number;
  length: number;
  curvature: number;
  lift: number;
}

export interface MarkMorphology {
  zone: 'flank' | 'back';
  side: -1 | 1;
  /** Degrees round the body from the middle of the face (0..180). */
  theta: number;
  /** Height as a fraction of the body, from the crown. */
  yFraction: number;
  dy: number;
  rx: number;
  ry: number;
  rotation: number;
}

export interface StripeMorphology {
  yFraction: number;
  thickness: number;
  reach: number;
}

export interface StripesMorphology {
  bands: StripeMorphology[];
  sag: number;
}

export interface GradientMorphology {
  start: number;
  strength: number;
}

export interface SpecialMarkMorphology {
  kind: Exclude<MarkKind, 'none'>;
  region: MarkRegionName;
  side: -1 | 1;
  theta: number;
  yFraction: number;
  r: number;
  rotation: number;
}

export interface BellyMorphology {
  yFraction: number;
  rx: number;
  ry: number;
  opacity: number;
}

export interface FreckleMorphology {
  dx: number;
  dy: number;
  r: number;
}

export type BlobbiMorphology = Record<MorphologyGeneName, number> & {
  stage: 'adult';
  antennae: AntennaMorphology[];
  horns: HornMorphology | null;
  ears: EarMorphology | null;
  tail: TailMorphology | null;
  pattern: PatternKind;
  spots: MarkMorphology[];
  stripes: StripesMorphology | null;
  gradient: GradientMorphology | null;
  mark: SpecialMarkMorphology | null;
  bellyPatch: BellyMorphology | null;
  freckles: FreckleMorphology[];
  palette: BlobbiPalette;
};

const resolve = (range: Pick<GeneRange, 'base' | 'spread'>, gene: unknown) => range.base + clampGene(gene) * range.spread;

const CANONICAL_ADULT = buildFrontBody(CANONICAL_PARAMS);
const CANONICAL_SPOTS = [
  { dx: 180.34, yFraction: 0.32854, rx: 17, ry: 24, rotation: -18 },
  { dx: 195, yFraction: 0.40306, rx: 21, ry: 27, rotation: 18 },
  { dx: 187.34, yFraction: 0.47125, rx: 14, ry: 20, rotation: -8 },
].map((spot) => {
  const y = CANONICAL_ADULT.top + spot.yFraction * CANONICAL_ADULT.height;
  const half = CANONICAL_ADULT.edgeAt(1, y) - CANONICAL_ADULT.axisX;
  return { ...spot, theta: 180 - (Math.asin(spot.dx / half) * 180) / Math.PI };
});

const CANONICAL_BACK_SPOTS = [
  { theta: 163, yFraction: 0.27, rx: 21, ry: 26, rotation: 12 },
  { theta: 199, yFraction: 0.43, rx: 24, ry: 29, rotation: -14 },
  { theta: 170, yFraction: 0.59, rx: 18, ry: 22, rotation: 8 },
] as const;

const MARK_RADIUS = 34;
const MARK_REGION_WEIGHTS: Record<MarkRegionName, number> = { forehead: 0.34, chest: 0.3, hip: 0.2, shoulder: 0.16 };

export function freeMarkRegions(horns: HornKind, pattern: PatternKind): MarkRegionName[] {
  return MARK_REGIONS.filter((region) => {
    if (region === 'forehead') return horns !== 'forehead' && horns !== 'top';
    if (region === 'shoulder') return pattern === 'solid' || pattern === 'gradient';
    return true;
  });
}

const CANONICAL_FRECKLES = [
  { dx: 14, dy: -4, r: 3.6 },
  { dx: -2, dy: -10, r: 3.9 },
  { dx: -15, dy: 2, r: 3.4 },
] as const;

/** Resolve a genome to concrete, bounded root-unit numbers for the adult. Pure and total. */
export function deriveMorphology(genome: BlobbiGenome): BlobbiMorphology {
  const out = { stage: 'adult' } as BlobbiMorphology;
  for (const name of MORPHOLOGY_GENES) out[name] = resolve(MORPHOLOGY_RANGES[name], genome.morphology?.[name]);
  const t = genome.traits;

  out.antennae = [];
  if (t.antenna.count === 1 || t.antenna.count === 2) {
    const a = t.antenna;
    const first: AntennaMorphology = {
      side: a.side === -1 ? -1 : 1,
      position: resolve(ANTENNA_RANGES.position, a.position),
      fore: resolve(ANTENNA_RANGES.fore, a.fore),
      length: resolve(ANTENNA_RANGES.length, a.length),
      thickness: resolve(ANTENNA_RANGES.thickness, a.thickness),
      curvature: resolve(ANTENNA_RANGES.curvature, a.curvature),
      tilt: resolve(ANTENNA_RANGES.tilt, a.tilt),
      sweep: resolve(ANTENNA_RANGES.sweep, a.sweep),
      tipRadius: resolve(ANTENNA_RANGES.tipSize, a.tipSize),
    };
    out.antennae.push(first);
    if (a.count === 2) {
      const asym = clampGene(a.asymmetry);
      out.antennae.push({
        ...first,
        side: first.side === 1 ? -1 : 1,
        length: first.length * (1 + 0.07 * asym),
        tilt: first.tilt + 3 * asym,
        curvature: first.curvature + 0.05 * asym,
      });
    }
  }

  out.horns = null;
  const hornKind = t.horns.kind;
  if (hornKind === 'forehead' || hornKind === 'top' || hornKind === 'side') {
    const h = t.horns;
    const k = hornKind === 'forehead' ? 0.86 : 1;
    out.horns = {
      kind: hornKind,
      length: resolve(HORN_RANGES.length, h.length) * k,
      width: resolve(HORN_RANGES.width, h.width) * k,
      curvature: resolve(HORN_RANGES.curvature, h.curvature),
      tilt: resolve(HORN_RANGES.tilt, h.tilt),
      roundness: resolve(HORN_RANGES.roundness, h.roundness),
      asymmetrySide: 1,
      asymmetry: clampGene(h.asymmetry),
      position: resolve(HORN_RANGES.position, h.position),
      fore: resolve(HORN_RANGES.fore, h.fore),
    };
    if (hornKind === 'top') {
      const behind = out.horns.fore - ANTENNA_BEHIND_HORN;
      const outside = topHornLat(out.horns.position) + ANTENNA_OUTSIDE_HORN;
      out.antennae = out.antennae.map((a) => ({ ...a, fore: Math.min(a.fore, behind), position: Math.max(a.position, outside) }));
    }
  }

  out.ears = null;
  const earKind = t.ears.kind;
  if (earKind === 'round' || earKind === 'pointed') {
    const e = t.ears;
    out.ears = {
      kind: earKind,
      size: resolve(EAR_RANGES.size, e.size),
      tilt: resolve(EAR_RANGES.tilt, e.tilt),
      flop: resolve(EAR_RANGES.flop, e.flop),
      position: resolve(EAR_RANGES.position, e.position),
    };
  }

  out.tail = null;
  const tailKind = t.tail.kind;
  if (tailKind === 'nub' || tailKind === 'curl' || tailKind === 'leaf') {
    const tail = t.tail;
    out.tail = {
      kind: tailKind,
      size: resolve(TAIL_RANGES.size, tail.size),
      length: resolve(TAIL_RANGES.length, tail.length),
      curvature: resolve(TAIL_RANGES.curvature, tail.curvature),
      lift: resolve(TAIL_RANGES.lift, tail.lift),
    };
  }

  const patternKind: PatternKind = t.pattern?.kind === 'spotted' || t.pattern?.kind === 'striped' || t.pattern?.kind === 'gradient' ? t.pattern.kind : 'solid';
  const face = SURFACE.face;
  out.pattern = patternKind;
  out.spots = [];
  out.stripes = null;
  out.gradient = null;
  if (patternKind === 'spotted') {
    const g = t.pattern.spots;
    const nudge = (gene: { dx: number; dy: number; size: number; rotation: number } | undefined) => gene ?? { dx: 0, dy: 0, size: 0, rotation: 0 };
    const sides: (-1 | 1)[] = g.side === 'both' ? [1, -1] : g.side === 'left' ? [-1] : [1];
    const count = g.count === 2 ? 2 : 3;
    for (const side of sides) {
      for (let i = 0; i < count; i++) {
        const canon = CANONICAL_SPOTS[i];
        const gene = nudge(g.marks[i]);
        const size = 1 + 0.12 * clampGene(gene.size);
        out.spots.push({
          zone: 'flank',
          side,
          theta: canon.theta - 3.5 * clampGene(gene.dx),
          yFraction: canon.yFraction,
          dy: 7 * clampGene(gene.dy),
          rx: canon.rx * size,
          ry: canon.ry * size,
          rotation: canon.rotation + 10 * clampGene(gene.rotation),
        });
      }
    }
    const lead: -1 | 1 = g.side === 'left' ? -1 : 1;
    const backCount = g.backCount === 2 ? 2 : 3;
    for (let i = 0; i < backCount; i++) {
      const canon = CANONICAL_BACK_SPOTS[i];
      const gene = nudge(g.back?.[i]);
      const size = 1 + 0.14 * clampGene(gene.size);
      const round = canon.theta + 9 * clampGene(gene.dx);
      out.spots.push({
        zone: 'back',
        side: round > 180 ? (lead === 1 ? -1 : 1) : lead,
        theta: round > 180 ? 360 - round : round,
        yFraction: canon.yFraction + 0.025 * clampGene(gene.dy),
        dy: 0,
        rx: canon.rx * size,
        ry: canon.ry * size,
        rotation: canon.rotation + 12 * clampGene(gene.rotation),
      });
    }
  } else if (patternKind === 'striped') {
    const g = t.pattern.stripes;
    const count = g.count === 4 ? 4 : 3;
    const bodyHeight = CANON_HEIGHT * out.bodyHeight;
    const first = face.top - 0.075;
    const last = face.bottom + 0.05;
    out.stripes = {
      sag: bodyHeight * 0.034 * (1 + 0.3 * clampGene(g.sag)),
      bands: Array.from({ length: count }, (_, i) => {
        const gene = g.bands[i] ?? { dy: 0, width: 0, reach: 0 };
        const yFraction = lerp(first, last, i / (count - 1)) + 0.012 * clampGene(gene.dy);
        const thickness = bodyHeight * 0.058 * (1 + 0.2 * clampGene(gene.width));
        const half = thickness / bodyHeight / 2 + 0.012;
        const reach = yFraction + half < face.top ? 148 : yFraction - half > face.bottom ? 150 : 62;
        return { yFraction, thickness, reach: reach + 8 * clampGene(gene.reach) };
      }),
    };
  } else if (patternKind === 'gradient') {
    const g = t.pattern.gradient;
    out.gradient = { start: 0.4 + 0.06 * clampGene(g.start), strength: 0.5 + 0.08 * clampGene(g.strength) };
  }

  out.mark = null;
  const markKind = t.mark?.kind;
  if (markKind === 'star' || markKind === 'heart' || markKind === 'sparkle' || markKind === 'moon') {
    const free = freeMarkRegions(t.horns.kind, patternKind);
    const total = free.reduce((sum, region) => sum + MARK_REGION_WEIGHTS[region], 0);
    let pick = Math.min(0.999999, Math.max(0, Number.isFinite(t.mark.region) ? t.mark.region : 0)) * total;
    let region = free[free.length - 1];
    for (const candidate of free) {
      if (pick < MARK_REGION_WEIGHTS[candidate]) {
        region = candidate;
        break;
      }
      pick -= MARK_REGION_WEIGHTS[candidate];
    }
    const patch = SURFACE.marks[region];
    out.mark = {
      kind: markKind,
      region,
      side: t.mark.side === -1 ? -1 : 1,
      theta: lerp(patch.theta[0], patch.theta[1], (clampGene(t.mark.u) + 1) / 2),
      yFraction: lerp(patch.y[0], patch.y[1], (clampGene(t.mark.v) + 1) / 2),
      r: MARK_RADIUS * (1 + 0.12 * clampGene(t.mark.size)) * (patch.size ?? 1),
      rotation: 16 * clampGene(t.mark.rotation),
    };
  }

  out.bellyPatch = null;
  if (t.belly.enabled) {
    const size = 1 + 0.12 * clampGene(t.belly.size);
    out.bellyPatch = {
      yFraction: 0.7 + 0.03 * clampGene(t.belly.height),
      rx: FRONT_BODY.halfWidth * 0.56 * size * out.bodyWidth * out.belly,
      ry: CANON_HEIGHT * 0.185 * size * out.bodyHeight,
      opacity: 0.3,
    };
  }

  out.freckles = [];
  if (t.freckles.enabled) {
    out.freckles = CANONICAL_FRECKLES.map((canon, i) => {
      const gene = t.freckles.dots[i] ?? { dx: 0, dy: 0, size: 0 };
      return {
        dx: canon.dx + 2.5 * clampGene(gene.dx),
        dy: canon.dy + 2.5 * clampGene(gene.dy),
        r: canon.r * (1 + 0.15 * clampGene(gene.size)),
      };
    });
  }

  out.palette = derivePalette(genome.colors);
  return out;
}

