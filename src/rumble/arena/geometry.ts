/**
 * ARENA GEOMETRY, for any arena (M11A): the floor as a set of rectangular
 * PLATFORMS, each with a top height, over a void. The same questions
 * `layout.ts` answers for the classic island, asked of any definition: is
 * this point on a floor, how far from a rim, where are the rims, what is
 * the top under a point. Heights matter for standing and for ledges; the
 * union in the plane is what "on the floor" means for walking (a bot that
 * steps off a high platform onto a low one is not walking into the void).
 * Pure.
 */
import type { Planar, Rect } from './layout';

export interface Platform extends Rect {
  /** The top surface's height, metres. */
  y: number;
  /** The slab's thickness below its top. */
  thickness: number;
  /** What it is made of, for the view and the rules (ice is slippery; a bridge breaks; a belt moves). */
  kind: 'floor' | 'bridge' | 'platform' | 'ice' | 'conveyor';
  /** A short label for the view's debug overlay. */
  name?: string;
}

export const inPlatform = (r: Rect, p: Planar, inset = 0) => Math.abs(p.x - r.x) <= r.halfWidth - inset && Math.abs(p.z - r.z) <= r.halfDepth - inset;

/** The highest platform whose footprint holds `p` (a positive inset keeps away from its edges), or null. */
export function platformUnder(platforms: readonly Platform[], p: Planar, inset = 0): Platform | null {
  let best: Platform | null = null;
  for (const r of platforms) if (inPlatform(r, p, inset) && (!best || r.y > best.y)) best = r;
  return best;
}

/** Whether a point is over some floor (any height), at least `inset` from the outer rim of the union. */
export function onAnyFloor(platforms: readonly Platform[], p: Planar, inset = 0): boolean {
  if (inset <= 0) return platforms.some((r) => inPlatform(r, p, inset));
  return platforms.some((r) => inPlatform(r, p, 0)) && rimDistanceOf(platforms, p) >= inset;
}

const segmentDistance = (p: Planar, [a, b]: [Planar, Planar]) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
};

const rimCache = new WeakMap<object, [Planar, Planar][]>();

/** The outer rim of the union of platforms, in the plane, as segments: every edge run whose outward side is void. Cached per array. */
export function rimSegmentsOf(platforms: readonly Platform[]): [Planar, Planar][] {
  let cached = rimCache.get(platforms);
  if (cached) return cached;
  const out: [Planar, Planar][] = [];
  const isInside = (p: Planar) => onAnyFloor(platforms, p, -1e-6);
  for (const r of platforms) {
    const corners = [
      { x: r.x - r.halfWidth, z: r.z - r.halfDepth },
      { x: r.x + r.halfWidth, z: r.z - r.halfDepth },
      { x: r.x + r.halfWidth, z: r.z + r.halfDepth },
      { x: r.x - r.halfWidth, z: r.z + r.halfDepth },
    ];
    for (let i = 0; i < 4; i++) {
      const from = corners[i];
      const to = corners[(i + 1) % 4];
      const n = 64;
      const dx = (to.x - from.x) / n;
      const dz = (to.z - from.z) / n;
      const ox = r.x - (from.x + to.x) / 2;
      const oz = r.z - (from.z + to.z) / 2;
      const len = Math.hypot(ox, oz) || 1;
      const outward = { x: (-ox / len) * 0.02, z: (-oz / len) * 0.02 };
      let runStart: Planar | null = null;
      for (let k = 0; k <= n; k++) {
        const mid = { x: from.x + dx * (k + 0.5), z: from.z + dz * (k + 0.5) };
        const exposed = k < n && !isInside({ x: mid.x + outward.x, z: mid.z + outward.z });
        if (exposed && runStart === null) runStart = { x: from.x + dx * k, z: from.z + dz * k };
        if (!exposed && runStart !== null) {
          out.push([runStart, { x: from.x + dx * k, z: from.z + dz * k }]);
          runStart = null;
        }
      }
    }
  }
  cached = out;
  rimCache.set(platforms, cached);
  return cached;
}

/** How far a point on some floor is from the union's outer rim (0 off the floor). */
export function rimDistanceOf(platforms: readonly Platform[], p: Planar): number {
  if (!platforms.some((r) => inPlatform(r, p, 0))) return 0;
  let d = Infinity;
  for (const seg of rimSegmentsOf(platforms)) d = Math.min(d, segmentDistance(p, seg));
  return d;
}

/** The union's extent in the plane. */
export function extentOf(platforms: readonly Platform[]): { halfWidth: number; halfDepth: number } {
  let w = 0;
  let d = 0;
  for (const r of platforms) {
    w = Math.max(w, Math.abs(r.x) + r.halfWidth);
    d = Math.max(d, Math.abs(r.z) + r.halfDepth);
  }
  return { halfWidth: w, halfDepth: d };
}

/**
 * A LEDGE (M11C): a point on the top edge of one platform where a hanging
 * body may hold. For a capsule centre `c`, the nearest edge of a platform
 * whose top is above the body's feet by [minBelow, maxBelow] and whose
 * footprint the body is just OUTSIDE of, within `reach` in the plane, with
 * the direction INTO the platform. Only platforms whose own footprint is not
 * under the body (one cannot hang from a floor one stands over), and only
 * platforms at least as wide as a hand-hold. Null when there is none.
 */
export interface Ledge {
  /** Index of the platform. */
  platform: number;
  /** The point on the edge, world (x, top y, z). */
  x: number;
  y: number;
  z: number;
  /** Unit direction from the edge into the platform, in the plane. */
  inX: number;
  inZ: number;
}

export function findLedge(platforms: readonly Platform[], c: { x: number; y: number; z: number }, feetY: number, opts: { reach: number; minBelow: number; maxBelow: number; minSize?: number; skip?: (index: number) => boolean }): Ledge | null {
  let best: Ledge | null = null;
  let bestD = Infinity;
  const minSize = opts.minSize ?? 0.8;
  platforms.forEach((r, i) => {
    if (opts.skip?.(i)) return;
    if (r.halfWidth * 2 < minSize || r.halfDepth * 2 < minSize) return;
    const below = r.y - feetY;
    if (below < opts.minBelow || below > opts.maxBelow) return;
    if (inPlatform(r, { x: c.x, z: c.z }, 0)) return;
    // The nearest point of the footprint's boundary to the body, in the plane.
    const nx = Math.max(r.x - r.halfWidth, Math.min(r.x + r.halfWidth, c.x));
    const nz = Math.max(r.z - r.halfDepth, Math.min(r.z + r.halfDepth, c.z));
    const d = Math.hypot(c.x - nx, c.z - nz);
    if (d > opts.reach || d >= bestD) return;
    // Which edge: the one the body is beyond.
    const dx = c.x - nx;
    const dz = c.z - nz;
    const len = Math.hypot(dx, dz) || 1;
    // A corner is held along the dominant axis.
    const inX = Math.abs(dx) >= Math.abs(dz) ? -Math.sign(dx || 1) : 0;
    const inZ = inX === 0 ? -Math.sign(dz || 1) : 0;
    void len;
    bestD = d;
    best = { platform: i, x: nx, y: r.y, z: nz, inX, inZ };
  });
  return best;
}
