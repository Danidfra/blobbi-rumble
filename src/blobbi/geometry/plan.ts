/**
 * THE ADULT PLAN: the Adult V2 artwork, measured, as the blobbi-kit
 * procedural engine holds it (`procedural/plan/adult.ts`). These numbers
 * are the canonical Blobbi in ROOT UNITS (the artwork's own unit); with
 * every gene at zero the 2D builders reproduce the authored drawing from
 * them, and the 3D builders here grow the same body in space.
 *
 * Only what a 3D character needs is carried over: the front silhouette (its
 * width at each height), the profile (its depth at each height, front and
 * back), and where every feature sits on the canonical body.
 */
import { pt, type Pt } from './math';

export interface PlanAnchor {
  at: Pt;
  in: Pt;
  out: Pt;
  top?: number;
  belly?: number;
  round?: boolean;
}

export const AXIS = 408.65657;
export const TOP = 136.79346;
export const BASE_Y = 767.46063;
/** The ground line the feet stand on. */
export const GROUND = 801;
/** The canonical body's height, crown to base, in root units. */
export const CANON_HEIGHT = BASE_Y - TOP;
/** Both eye groups carry `matrix(0.69877802, …)`. */
export const EYE_K = 0.69877802;

export const FRONT_BODY = {
  axisX: AXIS,
  top: TOP,
  baseY: BASE_Y,
  anchors: [
    { at: pt(0, 0), in: pt(0, 0), out: pt(72, 0), round: true },
    { at: pt(174, 95.70063), in: pt(-44, -59.33439), out: pt(47, 63.16242), top: 1 },
    { at: pt(264, 351.22132), in: pt(-14, -101.44267), out: pt(16, 115.79777), belly: 0.3 },
    { at: pt(123, 605.78501), in: pt(99, -41.15128), out: pt(-37, 15.3121), belly: 1 },
    { at: pt(0, 630.66717), in: pt(45, -1.91401), out: pt(0, 0), round: true },
  ] as PlanAnchor[],
  halfWidth: 264,
  crownHalfWidth: 174,
};

/** The profile, facing right (+x is the face). */
export const SIDE_BODY = {
  axisX: 399.6,
  anchors: [
    { at: pt(334.991, 130.982), in: pt(-54.439, 17.498), out: pt(69.992, -20.414), round: true },
    { at: pt(546.912, 197.086), in: pt(-59.299, -62.215), out: pt(53.466, 55.411), top: 1 },
    { at: pt(638.291, 446.92), in: pt(-9.721, -105.961), out: pt(11.665, 123.459), belly: 0.4 },
    { at: pt(515.805, 729.805), in: pt(88.463, -54.439), out: pt(-46.662, 28.191), belly: 1 },
    { at: pt(348.601, 758.969), in: pt(64.16, 10.693), out: pt(-97.212, -16.526) },
    { at: pt(160.982, 569.406), in: pt(18.47, 99.156), out: pt(-18.47, -100.128), belly: 0.5 },
    { at: pt(206.672, 275.827), in: pt(-45.689, 87.49), out: pt(33.052, -64.16), top: 1 },
  ] as PlanAnchor[],
};

/** The eyes: centres, the white's radii (times EYE_K), and the inner eye's offsets. */
export const EYES = {
  k: EYE_K,
  white: { rx: 77, ry: 91 },
  gazeTravel: 12,
  left: pt(EYE_K * 319.65656 + 79.280551, EYE_K * 383.79346 + 152.15487),
  right: pt(EYE_K * 497.65656 + 163.09607, EYE_K * 383.79346 + 145.17025),
  iris: { rx: 52, ry: 63 },
  pupil: { rx: 32, ry: 41 },
  highlight: { rx: 18, ry: 23 },
  glint: { r: 8.5, opacity: 0.76 },
  // The highlights sit on the lit (viewer's-left) side of BOTH eyes.
  localLeft: { iris: pt(4, 8), pupil: pt(10, 19), highlight: pt(-15, -23), glint: pt(26, 35) },
  localRight: { iris: pt(-4, 8), pupil: pt(-10, 19), highlight: pt(-29, -23), glint: pt(12, 35) },
};

export const BROWS = {
  width: 76,
  strokeWidth: 11,
  opacity: 0.72,
  left: pt(266.25672, 330.36951),
  right: pt(464.49446, 330.02033),
  neutralLeft: { start: 0, ctrl: -25 / 76, end: 1 / 76 },
  neutralRight: { start: 0, ctrl: -26 / 76, end: -1 / 76 },
};

export const CHEEKS = {
  left: pt(245.65657 - 7.3047614, 514.79346 - 15.343688),
  right: pt(571.65656 - 7.3047614, 514.79346 - 15.343688),
  rx: 47,
  ry: 30,
  opacity: 0.74,
  highlightOpacity: 0.17,
  highlight: { dx: -14, dy: -9, rx: 18, ry: 9 },
};

export const MOUTH = {
  start: pt(371.1973, 494.83689),
  width: 82.71435,
  strokeWidth: 14.0674,
};

export const FEET = { spacing: 94, cy: 744, rx: 79, ry: 57, rotation: 7 };
/** The near foot in profile stands this much AHEAD of the axis, the far one behind. */
export const FEET_SIDE = { near: 378.793 - 399.6, far: 419.061 - 399.6 };

export const ARMS = { left: pt(148.21229, 496.57208), right: pt(669.10084, 497.92126) };
/** The authored arm paddle's box: about 65 wide and 133 long, hanging from the shoulder. */
export const ARM_PADDLE = { width: 66, length: 133 };

export const TUFT = {
  root: pt(AXIS + 3.4, TOP + 30.5),
  main: { cx: AXIS - 5, cy: TOP - 10, rx: 32, ry: 49, rotation: 18 },
  secondary: { cx: AXIS + 31, cy: TOP + 4, rx: 23, ry: 37, rotation: 52 },
};

export const SHINE = { dx: -84, dy: 92, rx: 23, ry: 13, rotation: -30 };

/** Where the face is, as fractions of the body's height, and where a special mark may lie. */
export const SURFACE = {
  face: { top: 0.19, bottom: 0.72 },
  marks: {
    forehead: { theta: [4, 16], y: [0.12, 0.148], size: 0.8 },
    chest: { theta: [14, 34], y: [0.775, 0.825], size: 1 },
    hip: { theta: [52, 66], y: [0.765, 0.82], size: 1 },
    shoulder: { theta: [130, 156], y: [0.27, 0.42], size: 1 },
  } as Record<MarkRegionName, { theta: [number, number]; y: [number, number]; size: number }>,
};

export const MARK_REGIONS = ['forehead', 'chest', 'hip', 'shoulder'] as const;
export type MarkRegionName = (typeof MARK_REGIONS)[number];
