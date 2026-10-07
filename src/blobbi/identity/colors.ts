/**
 * COLOUR: a faithful port of the blobbi-kit procedural engine's `colors.ts`
 * (the parts a 3D renderer needs).
 *
 *  1. `generateColors(seed)` picks an individual's TRAIT colours (body,
 *     marking, eye, accent) in OKLCH, exactly as the kit does at creation.
 *     It is used ONCE, when an identity is created from a seed; after that
 *     the identity's stated colours are the truth.
 *  2. `derivePalette(colors)` turns the trait colours into every ROLE a
 *     drawing paints with (highlight, mid, shadow, limbs, feet, line work,
 *     iris tones, cheek, horn, mark), with the kit's measured OKLCH offsets
 *     from the authored purple. The 3D materials are built from this
 *     palette, so a 3D Blobbi is lit in the same family of tones its 2D
 *     drawing is painted in.
 */
import { geneRng } from './rng';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A colour as canonical lower-case `#rrggbb`, or undefined if it is not a plain hex colour. */
export function sanitizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HEX.test(value)) return undefined;
  const hex = value.length === 4 ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
  return hex.toLowerCase();
}

// ─── Colour math ─────────────────────────────────────────────────────────────

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const wrap = (h: number) => ((h % 360) + 360) % 360;

export function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = rgbOf(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: wrap((Math.atan2(B, A) * 180) / Math.PI) };
}

function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** The most chroma the screen can show at a lightness and hue. */
export function maxChroma(l: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear({ l, c: mid, h }))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** OKLCH to `#rrggbb`. Out-of-gamut colours keep their lightness and hue and give up chroma. */
export function oklchToHex(color: Oklch): string {
  const l = Math.min(1, Math.max(0, color.l));
  const c = Math.min(Math.max(0, color.c), maxChroma(l, color.h));
  const rgb = oklchToLinear({ l, c, h: color.h }).map((v) => Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255));
  return `#${((1 << 24) + (rgb[0] << 16) + (rgb[1] << 8) + rgb[2]).toString(16).slice(1)}`;
}

/** Perceptual distance between two colours (Euclidean in OKLab). */
export function distance(a: string, b: string): number {
  const p = hexToOklch(a);
  const q = hexToOklch(b);
  const ax = p.c * Math.cos((p.h * Math.PI) / 180);
  const ay = p.c * Math.sin((p.h * Math.PI) / 180);
  const bx = q.c * Math.cos((q.h * Math.PI) / 180);
  const by = q.c * Math.sin((q.h * Math.PI) / 180);
  return Math.hypot(p.l - q.l, ax - bx, ay - by);
}

/** A blend of two colours in OKLab, `t` of the way from `a` to `b`. */
export function mixOklab(a: string, b: string, t: number): string {
  const p = hexToOklch(a);
  const q = hexToOklch(b);
  const ax = p.c * Math.cos((p.h * Math.PI) / 180);
  const ay = p.c * Math.sin((p.h * Math.PI) / 180);
  const bx = q.c * Math.cos((q.h * Math.PI) / 180);
  const by = q.c * Math.sin((q.h * Math.PI) / 180);
  const x = ax + (bx - ax) * t;
  const y = ay + (by - ay) * t;
  return oklchToHex({ l: p.l + (q.l - p.l) * t, c: Math.hypot(x, y), h: wrap((Math.atan2(y, x) * 180) / Math.PI) });
}

/** `over` painted on `under` at an opacity. */
export function composite(over: string, under: string, opacity: number): string {
  const a = rgbOf(over);
  const b = rgbOf(under);
  const mix = a.map((v, i) => Math.round((v * opacity + b[i] * (1 - opacity)) * 255));
  return `#${((1 << 24) + (mix[0] << 16) + (mix[1] << 8) + mix[2]).toString(16).slice(1)}`;
}

// ─── Trait colours and palette ───────────────────────────────────────────────

export const COLOR_SCHEMES = ['analogous', 'complementary', 'split'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The trait colours. Each is optional: absent means the artwork's own (the canonical purple). */
export interface BlobbiColors {
  base?: string;
  secondary?: string;
  eye?: string;
  accent?: string;
}

/** Every literal colour the drawing uses, by role. */
export interface BlobbiPalette {
  bodyLight: string;
  bodyMid: string;
  bodyDark: string;
  limbLight: string;
  limbDark: string;
  footLight: string;
  footDark: string;
  /** Eyebrows, tuft details, freckles, tail veins. */
  line: string;
  /** Markings: spots, stripes, the deepening of a gradient. */
  marking: string;
  irisLight: string;
  irisMid: string;
  irisDark: string;
  accentLight: string;
  accentDark: string;
  hornLight: string;
  hornDark: string;
  cheek: string;
  belly: string;
  /** The special mark's colour. */
  mark: string;
  /** The baby's body mid tone; only used to judge a mark's readability over the whole life. */
  babyMid: string;
  pupil: string;
  white: string;
  feature: string;
  bodyShadow: string;
  groundShadow: string;
}

export const AUTHORED_PALETTE: Readonly<BlobbiPalette> = Object.freeze({
  bodyLight: '#c792ff',
  bodyMid: '#8749ef',
  bodyDark: '#5420c8',
  limbLight: '#9c61f4',
  limbDark: '#5422bc',
  footLight: '#8248e8',
  footDark: '#46199f',
  line: '#4f239e',
  marking: '#481696',
  irisLight: '#54308d',
  irisMid: '#201538',
  irisDark: '#090711',
  accentLight: '#9c61f4',
  accentDark: '#5422bc',
  hornLight: '#ffe6b8',
  hornDark: '#e0a468',
  cheek: '#ff7ab7',
  belly: '#ffffff',
  mark: '#ecdcff',
  babyMid: '#7c3aed',
  pupil: '#080711',
  white: '#ffffff',
  feature: '#21102e',
  bodyShadow: '#2d0d68',
  groundShadow: '#2f183f',
});

export interface RoleDelta {
  dl: number;
  chroma: number;
  dh: number;
}

export function deltaOf(role: string, from: string): RoleDelta {
  const a = hexToOklch(role);
  const b = hexToOklch(from);
  let dh = a.h - b.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return { dl: a.l - b.l, chroma: b.c === 0 ? 1 : a.c / b.c, dh };
}

/** Apply an authored offset to another tone, lightness scaled to the headroom the tone has. */
export function applyDelta(tone: Oklch, delta: RoleDelta, reference: Oklch): string {
  const l = delta.dl >= 0 ? tone.l + (delta.dl * (1 - tone.l)) / (1 - reference.l) : tone.l + (delta.dl * tone.l) / reference.l;
  return oklchToHex({ l, c: tone.c * delta.chroma, h: wrap(tone.h + delta.dh) });
}

const AUTHORED_MID = hexToOklch(AUTHORED_PALETTE.bodyMid);
const AUTHORED_IRIS = hexToOklch(AUTHORED_PALETTE.irisMid);
const BODY_ROLES = ['bodyLight', 'bodyDark', 'limbLight', 'limbDark', 'footLight', 'footDark', 'line'] as const;
const BODY_DELTAS = Object.fromEntries(BODY_ROLES.map((role) => [role, deltaOf(AUTHORED_PALETTE[role], AUTHORED_PALETTE.bodyMid)])) as Record<
  (typeof BODY_ROLES)[number],
  RoleDelta
>;
const BABY_MID_DELTA = deltaOf(AUTHORED_PALETTE.babyMid, AUTHORED_PALETTE.bodyMid);
const IRIS_LIGHT = deltaOf(AUTHORED_PALETTE.irisLight, AUTHORED_PALETTE.irisMid);
const IRIS_DARK = deltaOf(AUTHORED_PALETTE.irisDark, AUTHORED_PALETTE.irisMid);

const CHEEKS = ['#ff7ab7', '#ff8a65', '#ef4f86', '#ffd0e4'] as const;
const CHEEK_OPACITY = 0.74;
const CHEEK_MIN_DISTANCE = 0.085;

/** The cheek that stays visible on this body: the authored pink unless it would disappear. */
export function chooseCheek(bodyMid: string): string {
  const seen = (cheek: string) => distance(composite(cheek, bodyMid, CHEEK_OPACITY), bodyMid);
  if (seen(CHEEKS[0]) >= CHEEK_MIN_DISTANCE) return CHEEKS[0];
  return [...CHEEKS].sort((a, b) => seen(b) - seen(a))[0];
}

function hornFor(bodyMid: string): { light: string; dark: string } {
  const honey = { light: AUTHORED_PALETTE.hornLight, dark: AUTHORED_PALETTE.hornDark };
  const apart = (horn: { light: string; dark: string }) => Math.min(distance(horn.light, bodyMid), distance(horn.dark, bodyMid));
  if (apart(honey) >= 0.16) return honey;
  const others = [honey, { light: '#c98f5e', dark: '#96603a' }, { light: '#fffaf0', dark: '#e6dccb' }];
  return others.sort((a, b) => apart(b) - apart(a))[0];
}

const MARK_MIN_DISTANCE = 0.14;

function markColorFor(p: BlobbiPalette, accent: string | undefined): string {
  const body = hexToOklch(p.bodyMid);
  const pale = oklchToHex({ l: Math.min(0.95, body.l + 0.26), c: body.c * 0.38, h: body.h });
  const apart = (color: string) => Math.min(distance(color, p.bodyMid), distance(color, p.babyMid));
  const candidates = [...(accent ? [accent] : []), pale, p.marking];
  return candidates.find((color) => apart(color) >= MARK_MIN_DISTANCE) ?? [...candidates].sort((a, b) => apart(b) - apart(a))[0];
}

/** Resolve trait colours to a full palette. Invalid colours count as absent. Pure. */
export function derivePalette(colors: BlobbiColors | undefined): BlobbiPalette {
  const base = sanitizeHex(colors?.base);
  const secondary = sanitizeHex(colors?.secondary);
  const eye = sanitizeHex(colors?.eye);
  const accent = sanitizeHex(colors?.accent);
  const p: BlobbiPalette = { ...AUTHORED_PALETTE };
  if (base) {
    const mid = hexToOklch(base);
    p.bodyMid = base;
    for (const role of BODY_ROLES) p[role] = applyDelta(mid, BODY_DELTAS[role], AUTHORED_MID);
    p.accentLight = p.limbLight;
    p.accentDark = p.limbDark;
    p.cheek = chooseCheek(base);
    p.babyMid = applyDelta(mid, BABY_MID_DELTA, AUTHORED_MID);
    const horn = hornFor(base);
    p.hornLight = horn.light;
    p.hornDark = horn.dark;
  }
  if (secondary) p.marking = secondary;
  if (eye) {
    const mid = hexToOklch(eye);
    p.irisMid = eye;
    p.irisLight = applyDelta(mid, IRIS_LIGHT, AUTHORED_IRIS);
    p.irisDark = applyDelta(mid, IRIS_DARK, AUTHORED_IRIS);
  }
  if (accent) {
    const mid = hexToOklch(accent);
    p.accentLight = oklchToHex({ l: mid.l + 0.07, c: mid.c, h: mid.h });
    p.accentDark = oklchToHex({ l: mid.l - 0.13, c: mid.c, h: mid.h });
  }
  if (base || secondary || accent) p.mark = markColorFor(p, accent);
  return p;
}

// ─── Generation ──────────────────────────────────────────────────────────────

const HUE_LIGHTNESS: readonly (readonly [number, number])[] = [
  [0, 0.7],
  [30, 0.68],
  [60, 0.75],
  [90, 0.83],
  [110, 0.86],
  [135, 0.82],
  [150, 0.78],
  [180, 0.77],
  [210, 0.75],
  [240, 0.68],
  [265, 0.62],
  [293, AUTHORED_MID.l + 0.02],
  [320, 0.64],
  [345, 0.68],
  [360, 0.7],
];

export function bodyLightnessFor(hue: number): number {
  const h = wrap(hue);
  for (let i = 1; i < HUE_LIGHTNESS.length; i++) {
    const [h0, l0] = HUE_LIGHTNESS[i - 1];
    const [h1, l1] = HUE_LIGHTNESS[i];
    if (h <= h1) return l0 + ((l1 - l0) * (h - h0)) / (h1 - h0);
  }
  return HUE_LIGHTNESS[0][1];
}

export const MIN_BODY_LIGHTNESS = 0.565;
export const MAX_BODY_LIGHTNESS = 0.87;
export const MAX_BODY_CHROMA = 0.205;
export const MIN_BODY_CHROMA = 0.075;

export interface GeneratedColors {
  base: string;
  secondary: string;
  eye: string;
  accent?: string;
  scheme: ColorScheme;
}

/** An individual's trait colours from its seed, exactly as the kit decides them at creation. */
export function generateColors(seed: string): GeneratedColors {
  const hue = geneRng(seed, 'color.base').range(0, 360);
  const tone = geneRng(seed, 'color.tone');
  const l = Math.min(MAX_BODY_LIGHTNESS, Math.max(MIN_BODY_LIGHTNESS, bodyLightnessFor(hue) + tone.centered() * 0.045));
  const limit = maxChroma(l, hue);
  const floor = hue > 55 && hue < 135 ? 0.88 : 0.74;
  const c = Math.min(limit, MAX_BODY_CHROMA, Math.max(MIN_BODY_CHROMA, limit * (floor + (0.96 - floor) * tone.next())));
  const base = oklchToHex({ l, c, h: hue });

  const roll = geneRng(seed, 'color.scheme').next();
  const scheme: ColorScheme = roll < 0.5 ? 'analogous' : roll < 0.75 ? 'complementary' : 'split';
  const away = geneRng(seed, 'color.accent');
  const accentHue = scheme === 'complementary' ? hue + 180 : hue + (away.chance(0.5) ? 150 : -150);

  const mark = geneRng(seed, 'color.secondary');
  const secondary = oklchToHex({
    l: l - mark.range(0.2, 0.27),
    c: c * 1.05,
    h: wrap(hue + (mark.chance(0.5) ? 1 : -1) * mark.range(16, 38)),
  });

  const iris = geneRng(seed, 'color.eye');
  const eyeHue = scheme === 'analogous' ? hue + iris.range(-30, 30) : accentHue;
  const eye = oklchToHex({ l: iris.range(0.22, 0.3), c: iris.range(0.05, 0.11), h: wrap(eyeHue) });

  const colors: GeneratedColors = { base, secondary, eye, scheme };
  if (scheme !== 'analogous') {
    const al = Math.min(0.82, Math.max(0.6, bodyLightnessFor(accentHue)));
    colors.accent = oklchToHex({ l: al, c: maxChroma(al, accentHue) * 0.72, h: wrap(accentHue) });
  }
  return colors;
}
