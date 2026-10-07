/**
 * SILHOUETTES, generated from the plan's anchors and an individual's body
 * parameters: a port of the kit's `silhouette.ts`. The FRONT one is
 * symmetric (one side's anchors, mirrored); the SIDE one is a profile loop.
 *
 * The 3D body is a surface of these two: at every height its half-width is
 * the front silhouette's and its depth, in front of and behind the axis, is
 * the profile's. The same six body genes shape both exactly as they shape
 * the 2D drawing, which is what keeps one Blobbi one Blobbi in 2D and 3D.
 */
import { lerp, pt, sampleCubic, type Cubic, type Pt } from './math';
import { FRONT_BODY, SIDE_BODY, type PlanAnchor } from './plan';

export interface BodyParams {
  bodyWidth: number;
  bodyHeight: number;
  topWidth: number;
  belly: number;
  roundness: number;
  lean: number;
}

export const CANONICAL_PARAMS: BodyParams = { bodyWidth: 1, bodyHeight: 1, topWidth: 1, belly: 1, roundness: 1, lean: 0 };

const SAMPLES = 24;

export interface Outline {
  segments: Cubic[];
  line: Pt[];
  top: number;
  bottom: number;
  left: number;
  right: number;
  apex: Pt;
  /** Leftmost and rightmost x of the outline at height `y`; null outside it. */
  spanAt(y: number): { min: number; max: number } | null;
}

function finish(segments: Cubic[]): Outline {
  const line = segments.flatMap((s, i) => sampleCubic(s, SAMPLES).slice(i === 0 ? 0 : 1));
  let apex = line[0];
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const p of line) {
    if (p.y < apex.y) apex = p;
    if (p.y > bottom) bottom = p.y;
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
  }
  const crossings = (value: number): number[] => {
    const out: number[] = [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      if ((a.y - value) * (b.y - value) > 0 || a.y === b.y) continue;
      out.push(a.x + ((b.x - a.x) * (value - a.y)) / (b.y - a.y));
    }
    return out;
  };
  return {
    segments,
    line,
    top: apex.y,
    bottom,
    left,
    right,
    apex,
    spanAt: (y) => {
      const xs = crossings(y);
      return xs.length < 2 ? null : { min: Math.min(...xs), max: Math.max(...xs) };
    },
  };
}

const anchorScale = (a: PlanAnchor, p: BodyParams, width: number) => width * lerp(1, p.topWidth, a.top ?? 0) * lerp(1, p.belly, a.belly ?? 0);

export interface FrontBody extends Outline {
  axisX: number;
  baseY: number;
  height: number;
  halfWidth: number;
  crownHalfWidth: number;
  /** The silhouette's x on a side (-1 left, 1 right) at height `y`; the axis outside the body. */
  edgeAt(side: -1 | 1, y: number): number;
}

export function buildFrontBody(p: BodyParams, plan = FRONT_BODY): FrontBody {
  const sx = p.bodyWidth;
  const sy = p.bodyHeight;
  const canonHeight = plan.baseY - plan.top;
  const height = canonHeight * sy;
  const top = plan.baseY - height;
  const last = plan.anchors.length - 1;

  const side = (dir: -1 | 1) => {
    const anchors = plan.anchors.map((a, i) => (i === 0 ? pt(plan.axisX + p.lean, top) : pt(plan.axisX + dir * a.at.x * anchorScale(a, p, sx), top + a.at.y * sy)));
    const handle = (i: number, which: 'in' | 'out'): Pt => {
      const h = plan.anchors[i][which];
      const hx = i === 0 ? sx * p.roundness * lerp(1, p.topWidth, 0.6) : i === last ? sx * p.roundness * lerp(1, p.belly, 0.6) : sx;
      return pt(anchors[i].x + dir * h.x * hx, anchors[i].y + h.y * sy);
    };
    const segments: Cubic[] = [];
    for (let i = 0; i < last; i++) segments.push({ p0: anchors[i], c1: handle(i, 'out'), c2: handle(i + 1, 'in'), p1: anchors[i + 1] });
    return segments;
  };

  const right = side(1);
  const left = side(-1);
  const leftUp = [...left].reverse().map((s): Cubic => ({ p0: s.p1, c1: s.c2, c2: s.c1, p1: s.p0 }));
  const outline = finish([...right, ...leftUp]);
  return {
    ...outline,
    apex: right[0].p0,
    top,
    axisX: plan.axisX,
    baseY: plan.baseY,
    height,
    halfWidth: plan.halfWidth * sx,
    crownHalfWidth: plan.crownHalfWidth * sx * p.topWidth,
    edgeAt: (dir, y) => {
      const span = outline.spanAt(y);
      if (!span) return plan.axisX;
      return dir === 1 ? span.max : span.min;
    },
  };
}

export interface SideBody extends Outline {
  axisX: number;
  baseY: number;
  height: number;
  /** The profile's front (face) edge at height `y`, facing right. */
  frontAt(y: number): number;
  backAt(y: number): number;
  depthScale: number;
}

function loop(anchors: PlanAnchor[], place: (p: Pt, a: PlanAnchor) => Pt, handleScale: (a: PlanAnchor) => number): Cubic[] {
  const at = anchors.map((a) => place(a.at, a));
  const handle = (i: number, which: 'in' | 'out'): Pt => {
    const a = anchors[i];
    return place(pt(a.at.x + a[which].x * handleScale(a), a.at.y + a[which].y), a);
  };
  return anchors.map((_, i) => {
    const next = (i + 1) % anchors.length;
    return { p0: at[i], c1: handle(i, 'out'), c2: handle(next, 'in'), p1: at[next] };
  });
}

function profileFrame(plan: typeof SIDE_BODY) {
  const canon = finish(loop(plan.anchors, (p) => p, () => 1));
  return { top: canon.top, bottom: canon.bottom };
}

export function buildSideBody(p: BodyParams, plan = SIDE_BODY): SideBody {
  const frame = profileFrame(plan);
  const depthScale = lerp(1, p.bodyWidth, 0.5);
  const place = (q: Pt, a: PlanAnchor): Pt =>
    pt(
      plan.axisX + (q.x - plan.axisX) * depthScale * lerp(1, p.topWidth, (a.top ?? 0) * 0.6) * lerp(1, p.belly, (a.belly ?? 0) * 0.8),
      frame.bottom - (frame.bottom - q.y) * p.bodyHeight,
    );
  const outline = finish(loop(plan.anchors, place, (a) => (a.round ? p.roundness : 1)));
  return {
    ...outline,
    axisX: plan.axisX,
    baseY: frame.bottom,
    height: outline.bottom - outline.top,
    frontAt: (y) => outline.spanAt(y)?.max ?? plan.axisX,
    backAt: (y) => outline.spanAt(y)?.min ?? plan.axisX,
    depthScale: depthScale * lerp(1, p.topWidth, 0.6),
  };
}
