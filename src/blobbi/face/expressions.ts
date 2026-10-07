/**
 * EXPRESSIONS as continuous transformations of a Blobbi's own face: a port
 * of the kit's `expressions.ts`. Each kit preset is a KEY POSE in a small
 * numeric pose space, and an expression is a weighted blend of key poses.
 * A pose never contains coordinates: it is in the face's own units (mouth
 * widths, brow widths, eye radii), so two Blobbis with different faces make
 * the same expression with their own faces, in 2D and in 3D alike.
 */
import { clamp01, lerp } from '../geometry/math';

export const EMOTIONS = ['happy', 'excited', 'sad', 'sleepy', 'surprised', 'upset'] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type ExpressionWeights = Partial<Record<Emotion, number>>;

export interface MouthPose {
  width: number;
  dy: number;
  hx: number;
  low: number;
  up: number;
  hxSkew: number;
  lowSkew: number;
}

export interface BrowPose {
  start: number;
  ctrl: number;
  end: number;
}

export interface FacePose {
  mouth: MouthPose;
  browLeft: BrowPose;
  browRight: BrowPose;
  /** 0 open, 0.5 the kit's half lid, 1 closed. */
  lid: number;
  /** Scale of the inner eye (the kit's `wide` is 0.84). */
  irisScale: number;
  /** -1 no blush, 0 the authored cheek, 1 the kit's strong blush. */
  blush: number;
}

const NEUTRAL_MOUTH: MouthPose = {
  width: 1,
  dy: 0,
  hx: (15.89586 + (82.71435 - 67.22108)) / 2 / 82.71435,
  low: (30.56679 + 31.06386) / 2 / 82.71435,
  up: (30.56679 + 31.06386) / 2 / 82.71435,
  hxSkew: (15.89586 - (82.71435 - 67.22108)) / 2 / 82.71435,
  lowSkew: (31.06386 - 30.56679) / 2 / 82.71435,
};

const SMILE: MouthPose = { width: 1, dy: 0, hx: 0.19, low: 0.52, up: 0.52, hxSkew: 0, lowSkew: 0 };
const GRIN: MouthPose = { width: 1.24, dy: -0.02, hx: 0.25 / 1.24, low: 0.72, up: 0.72, hxSkew: 0, lowSkew: 0 };
const FROWN: MouthPose = { width: 1, dy: 0.18, hx: 0.19, low: -0.34, up: -0.34, hxSkew: 0, lowSkew: 0 };
const FLAT: MouthPose = { width: 0.84, dy: 0.1, hx: 0.19, low: 0, up: 0, hxSkew: 0, lowSkew: 0 };
const OPEN: MouthPose = { width: 0.56, dy: 0.16, hx: 0, low: (4 / 3) * 0.22, up: -(4 / 3) * 0.22, hxSkew: 0, lowSkew: 0 };

const NEUTRAL_BROW_LEFT: BrowPose = { start: 0, ctrl: -25 / 76, end: 1 / 76 };
const NEUTRAL_BROW_RIGHT: BrowPose = { start: 0, ctrl: -26 / 76, end: -1 / 76 };
const RAISED: BrowPose = { start: -0.16, ctrl: -0.52, end: -0.16 };
const LOWERED: BrowPose = { start: 0.12, ctrl: 0.02, end: 0.14 };
const INNER_UP_LEFT: BrowPose = { start: 0.05, ctrl: -0.15, end: -0.17 };
const INNER_UP_RIGHT: BrowPose = { start: -0.17, ctrl: -0.19, end: 0.05 };

export const NEUTRAL_POSE: FacePose = {
  mouth: NEUTRAL_MOUTH,
  browLeft: NEUTRAL_BROW_LEFT,
  browRight: NEUTRAL_BROW_RIGHT,
  lid: 0,
  irisScale: 1,
  blush: 0,
};

const WIDE = 0.84;

export const KEY_POSES: Readonly<Record<Emotion, FacePose>> = {
  happy: { mouth: SMILE, browLeft: RAISED, browRight: RAISED, lid: 0, irisScale: 1, blush: 0 },
  excited: { mouth: GRIN, browLeft: RAISED, browRight: RAISED, lid: 0, irisScale: WIDE, blush: 1 },
  sad: { mouth: FROWN, browLeft: INNER_UP_LEFT, browRight: INNER_UP_RIGHT, lid: 0.5, irisScale: 1, blush: -1 },
  sleepy: { mouth: FLAT, browLeft: LOWERED, browRight: LOWERED, lid: 0.5, irisScale: 1, blush: 0 },
  surprised: { mouth: OPEN, browLeft: RAISED, browRight: RAISED, lid: 0, irisScale: WIDE, blush: 0 },
  upset: { mouth: FLAT, browLeft: LOWERED, browRight: LOWERED, lid: 0, irisScale: 1, blush: -1 },
};

export function normalizeWeights(weights: ExpressionWeights | undefined): Record<Emotion, number> {
  const out = {} as Record<Emotion, number>;
  let total = 0;
  for (const emotion of EMOTIONS) {
    const raw = weights?.[emotion];
    const w = typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : 0;
    out[emotion] = w;
    total += w;
  }
  if (total > 1) for (const emotion of EMOTIONS) out[emotion] /= total;
  return out;
}

function blend<T extends object>(neutral: T, rest: number, poses: [T, number][]): T {
  const out = {} as Record<string, number>;
  for (const key of Object.keys(neutral)) {
    let value = (neutral as Record<string, number>)[key] * rest;
    for (const [pose, weight] of poses) value += (pose as Record<string, number>)[key] * weight;
    out[key] = value;
  }
  return out as T;
}

/** Blend the key poses by weight, starting from a neutral face. All weights zero returns `neutral`. */
export function resolveFacePose(weights: ExpressionWeights | undefined, neutral: FacePose = NEUTRAL_POSE): FacePose {
  const w = normalizeWeights(weights);
  const active = EMOTIONS.filter((e) => w[e] > 0);
  if (active.length === 0) return neutral;
  const rest = 1 - active.reduce((sum, e) => sum + w[e], 0);
  const scalar = (pick: (p: FacePose) => number) => pick(neutral) * rest + active.reduce((sum, e) => sum + pick(KEY_POSES[e]) * w[e], 0);
  return {
    mouth: blend(neutral.mouth, rest, active.map((e) => [KEY_POSES[e].mouth, w[e]])),
    browLeft: blend(neutral.browLeft, rest, active.map((e) => [KEY_POSES[e].browLeft, w[e]])),
    browRight: blend(neutral.browRight, rest, active.map((e) => [KEY_POSES[e].browRight, w[e]])),
    lid: scalar((p) => p.lid),
    irisScale: scalar((p) => p.irisScale),
    blush: scalar((p) => p.blush),
  };
}

/** Interpolate two poses (for animating between expressions). */
export function lerpFacePose(a: FacePose, b: FacePose, t: number): FacePose {
  const mix = <T extends object>(x: T, y: T): T => {
    const out = {} as Record<string, number>;
    for (const key of Object.keys(x)) out[key] = lerp((x as Record<string, number>)[key], (y as Record<string, number>)[key], t);
    return out as T;
  };
  return {
    mouth: mix(a.mouth, b.mouth),
    browLeft: mix(a.browLeft, b.browLeft),
    browRight: mix(a.browRight, b.browRight),
    lid: lerp(a.lid, b.lid, t),
    irisScale: lerp(a.irisScale, b.irisScale, t),
    blush: lerp(a.blush, b.blush, t),
  };
}

/** A single emotion at an intensity: `expressionOf('happy', 0.5)`. */
export function expressionOf(emotion: Emotion | 'neutral', intensity = 1): ExpressionWeights {
  return emotion === 'neutral' ? {} : { [emotion]: clamp01(intensity) };
}

const STRONG_BLUSH = { base: 0.96 / 0.74, highlight: 0.28 / 0.17 } as const;

/** Cheek opacities for a blush level: the resting cheek at 0, hidden at -1, the kit's `strong` at 1. */
export function blushOpacity(blush: number, restBase = 0.74, restHighlight = 0.17): { base: number; highlight: number } {
  const b = blush < -1 ? -1 : blush > 1 ? 1 : blush;
  return b < 0
    ? { base: lerp(restBase, 0, -b), highlight: lerp(restHighlight, 0, -b) }
    : { base: lerp(restBase, Math.min(1, restBase * STRONG_BLUSH.base), b), highlight: lerp(restHighlight, restHighlight * STRONG_BLUSH.highlight, b) };
}

export interface LidShape {
  /** Height of the lid edge's ends, in vertical radii (negative is above the centre). */
  chord: number;
  /** How far below the chord the edge's control point hangs, in vertical radii. */
  sag: number;
  /** Half-length of the edge in horizontal radii; `null` means "ends on the eye's outline". */
  reach: number | null;
  lineWidth: number;
  lineOpacity: number;
  tint: number;
  /** For closures past half: the lower lid rising to meet the upper one. */
  lower: number;
}

/** The adult's closed eye: `m cx-58,cy+8 q 58,44 116,0` on a 77 by 91 eye, stroke 17. */
export const ADULT_CLOSED_LID = { chord: 8 / 91, sag: 44 / 91, reach: 58 / 77, lineWidth: 17 / 77 } as const;

export function lidShape(closure: number, closed = ADULT_CLOSED_LID): LidShape | null {
  const c = clamp01(closure);
  if (c <= 0) return null;
  if (c <= 0.5) {
    const u = c / 0.5;
    return { chord: lerp(-1, -0.09, u), sag: lerp(0, 0.3, u), reach: null, lineWidth: 0.16, lineOpacity: clamp01(c / 0.2), tint: 1, lower: 0 };
  }
  const u = (c - 0.5) / 0.5;
  return {
    chord: lerp(-0.09, closed.chord, u),
    sag: lerp(0.3, closed.sag, u),
    reach: closed.reach,
    lineWidth: lerp(0.16, closed.lineWidth, u),
    lineOpacity: 1,
    tint: 1 - u,
    lower: u,
  };
}
