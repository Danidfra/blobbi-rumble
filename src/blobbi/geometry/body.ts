/**
 * THE BODY SURFACE: the Blobbi's egg, grown from the same two silhouettes
 * the 2D renderer draws.
 *
 * At every height the surface's half-width is the FRONT silhouette's and
 * its depth, ahead of and behind the axis, is the PROFILE's. Round the body
 * the cross-section is an ellipse whose front and back radii differ (the
 * belly bulges low in front, the back bulges a little higher), so a Blobbi
 * seen from the side in 3D has the profile its 2D side view has, and seen
 * from the front has its front silhouette. The six body genes (width,
 * height, top width, belly, roundness, lean) shape it exactly as they shape
 * the drawings.
 *
 * The surface also answers the questions every other builder asks:
 * "where on the skin is this point of the face?", "where is the crown at
 * this lateral position?", "what is this spot's place on the texture?".
 *
 * Mesh parameterisation, which the texture painter relies on:
 *   φ: angle round the body, 0 at the middle of the face, positive toward
 *      the viewer's right; u = 0.5 + φ / 2π (the seam is at the back).
 *   v: height fraction, 0 at the base, 1 at the crown.
 */
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { clamp, lerp, TAU } from './math';
import { FRONT_BODY, GROUND } from './plan';
import { buildFrontBody, buildSideBody, type BodyParams, type FrontBody, type SideBody } from './silhouette';
import { UNIT, VIEWER_X } from './units';

export interface SurfacePoint {
  /** World position, metres. */
  x: number;
  y: number;
  z: number;
  /** Outward unit normal (approximate: radial). */
  nx: number;
  ny: number;
  nz: number;
}

export interface BodySurface {
  front: FrontBody;
  side: SideBody;
  params: BodyParams;
  /** The body's height, root units, and where its crown and base are, in world metres. */
  heightUnits: number;
  topY: number;
  baseY: number;
  /** Half-width (root units) at a height fraction from the base. */
  halfWidthAt(v: number): number;
  /** Depth in front of (+) and behind (-) the axis, root units, at a height fraction. */
  depthAt(v: number): { front: number; back: number };
  /** Height fraction (from the base) of a root-unit y (artwork y, down from the crown). */
  vOfRootY(rootY: number): number;
  /** World y of a height fraction. */
  yOfV(v: number): number;
  /** The surface point at a body angle (radians, 0 the middle of the face, positive to the viewer's right) and height fraction. */
  pointAt(phi: number, v: number, offset?: number): SurfacePoint;
  /**
   * The surface point under a point of the front drawing: `viewerX` root
   * units to the viewer's right of the axis, at artwork height `rootY`.
   * Points past the silhouette's edge are pinned to it.
   */
  frontPoint(viewerX: number, rootY: number, offset?: number): SurfacePoint;
  /** The body angle a front-drawing x lands at, at a height fraction. */
  phiOfFrontX(viewerX: number, v: number): number;
  /** The crown's surface at a lateral position (viewer x, root units) and a fore/aft position (root units, +forward). */
  crownPoint(viewerX: number, fore: number, offset?: number): SurfacePoint;
  /** Texture coordinates of a body angle (degrees, the kit's `theta`, 0 face, 180 back) on a side, at a height fraction from the crown. */
  uvOf(thetaDeg: number, side: -1 | 1, yFractionFromCrown: number): { u: number; v: number };
  /** Texture coordinates under a point of the front drawing. */
  uvOfFront(viewerX: number, rootY: number): { u: number; v: number };
  /** How many root units one texture unit (0..1) spans, round the body at a height fraction, and up it. */
  uvScaleAt(v: number): { unitsPerU: number; unitsPerV: number };
  /** The crown's half-width and half-depth in root units. */
  crownHalfWidth: number;
  crownHalfDepth: number;
  /** Whether a point (body frame, metres) lies outside the skin. */
  isOutside(point: { x: number; y: number; z: number }): boolean;
  /**
   * Where the skin is, along a line through `point` in direction `dir`
   * (unit, pointing out of the body): the crossing within `reach` metres
   * either way, the skin's normal there, and `depth`, how far `point` is
   * OUTSIDE the skin along `dir` (negative inside). Null when the line does
   * not cross the skin within reach.
   */
  skinAlong(point: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, reach?: number): { depth: number; point: SurfacePoint } | null;
}

const ROWS = 56;
const COLS = 72;

/** Make the lean (a sideways nudge of the crown) fade in over the top third of the body. */
const leanAt = (lean: number, v: number) => lean * clamp((v - 0.6) / 0.4, 0, 1) ** 2;

export function buildBodySurface(params: BodyParams): BodySurface {
  const front = buildFrontBody(params);
  const side = buildSideBody(params);
  const heightUnits = front.height;
  const topY = (GROUND - front.top) * UNIT;
  const baseY = (GROUND - front.baseY) * UNIT;

  const halfWidthAt = (v: number): number => {
    const y = front.baseY - clamp(v, 0, 1) * heightUnits;
    const span = front.spanAt(y);
    if (!span) return 0;
    return (span.max - span.min) / 2;
  };
  const depthAt = (v: number) => {
    const y = side.bottom - clamp(v, 0, 1) * side.height;
    const span = side.spanAt(y);
    if (!span) return { front: 0, back: 0 };
    return { front: span.max - side.axisX, back: side.axisX - span.min };
  };
  const vOfRootY = (rootY: number) => clamp((front.baseY - rootY) / heightUnits, 0, 1);
  const yOfV = (v: number) => baseY + v * heightUnits * UNIT;

  /** Radius along the depth axis at an angle: the front's or the back's, blended smoothly past the flanks. */
  const depthRadius = (phi: number, v: number) => {
    const d = depthAt(v);
    const c = Math.cos(phi);
    const w = 0.5 + 0.5 * c;
    const t = w * w * (3 - 2 * w);
    return lerp(d.back, d.front, t);
  };

  /** The surface's position (no offset) at a body angle and height fraction, root units for x and z and metres for y. */
  const bare = (phi: number, v: number): [number, number, number] => {
    const vv = clamp(v, 0, 1);
    const hw = halfWidthAt(vv);
    const dr = depthRadius(phi, vv);
    const xu = VIEWER_X * hw * Math.sin(phi) + leanAt(params.lean, vv) * VIEWER_X;
    const zu = dr * Math.cos(phi);
    return [xu * UNIT, yOfV(vv), zu * UNIT];
  };

  const pointAt = (phi: number, v: number, offset = 0): SurfacePoint => {
    const vv = clamp(v, 0, 1);
    const [x, y, z] = bare(phi, vv);
    // The true outward normal: the cross product of the surface's two tangents, by finite differences.
    let nx: number;
    let ny: number;
    let nz: number;
    if (vv >= 0.999) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else if (vv <= 0.001) {
      nx = 0;
      ny = -1;
      nz = 0;
    } else {
      const dv = 0.004;
      const dp = 0.02;
      const up = bare(phi, Math.min(1, vv + dv));
      const down = bare(phi, Math.max(0, vv - dv));
      const fwd = bare(phi + dp, vv);
      const back = bare(phi - dp, vv);
      const tv = [up[0] - down[0], up[1] - down[1], up[2] - down[2]];
      const tp = [fwd[0] - back[0], fwd[1] - back[1], fwd[2] - back[2]];
      nx = tv[1] * tp[2] - tv[2] * tp[1];
      ny = tv[2] * tp[0] - tv[0] * tp[2];
      nz = tv[0] * tp[1] - tv[1] * tp[0];
      // Outward: away from the axis.
      if (nx * x + nz * z < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    return { x: x + nx * offset, y: y + ny * offset, z: z + nz * offset, nx, ny, nz };
  };

  const phiOfFrontX = (viewerX: number, v: number) => {
    const hw = halfWidthAt(v);
    if (hw < 1e-6) return 0;
    return Math.asin(clamp(viewerX / hw, -1, 1));
  };

  const frontPoint = (viewerX: number, rootY: number, offset = 0) => {
    const v = vOfRootY(rootY);
    return pointAt(phiOfFrontX(viewerX, v), v, offset);
  };

  const crownHalfWidth = front.crownHalfWidth;
  const crownHalfDepth = depthAt(0.85).front * 0.7;

  const crownPoint = (viewerX: number, fore: number, offset = 0): SurfacePoint => {
    // Search down from the apex for the height whose cross-section reaches this (x, z).
    const target = (v: number) => {
      const hw = halfWidthAt(v);
      const phi = Math.atan2(viewerX, fore === 0 ? 1e-6 : fore);
      const dr = depthRadius(phi, v);
      if (hw < 1e-6 || dr < 1e-6) return -1;
      return 1 - ((viewerX / hw) ** 2 + (fore / dr) ** 2);
    };
    let lo = 0.5;
    let hi = 1;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (target(mid) >= 0) lo = mid;
      else hi = mid;
    }
    const v = lo;
    const phi = Math.atan2(viewerX, fore === 0 ? 1e-6 : fore);
    const p = pointAt(phi, v, 0);
    // The crown's normal leans upward strongly; blend toward straight up near the apex.
    const up = clamp((v - 0.85) / 0.15, 0, 1);
    const nx = lerp(p.nx, 0, up);
    const ny = lerp(p.ny, 1, up);
    const nz = lerp(p.nz, 0, up);
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: p.x + (nx / len) * offset, y: p.y + (ny / len) * offset, z: p.z + (nz / len) * offset, nx: nx / len, ny: ny / len, nz: nz / len };
  };

  /** The ring's centre x at a height (the crown's lean), metres. */
  const centreXAt = (v: number) => leanAt(params.lean, clamp(v, 0, 1)) * VIEWER_X * UNIT;
  const isOutside = (p: { x: number; y: number; z: number }): boolean => {
    const v = (p.y - baseY) / (topY - baseY);
    if (v >= 1 || v <= 0) return true;
    const cx = centreXAt(v);
    const phi = Math.atan2(VIEWER_X * (p.x - cx), p.z);
    const q = pointAt(phi, v, 0);
    return Math.hypot(p.x - cx, p.z) > Math.hypot(q.x - cx, q.z);
  };
  const skinAlong = (p: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, reach = 0.15) => {
    const at = (s: number) => ({ x: p.x + dir.x * s, y: p.y + dir.y * s, z: p.z + dir.z * s });
    let lo = -reach;
    let hi = reach;
    if (isOutside(at(lo)) || !isOutside(at(hi))) return null;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (isOutside(at(mid))) hi = mid;
      else lo = mid;
    }
    const s = (lo + hi) / 2;
    const q = at(s);
    const v = clamp((q.y - baseY) / (topY - baseY), 0.001, 0.999);
    const cx = centreXAt(v);
    const phi = Math.atan2(VIEWER_X * (q.x - cx), q.z);
    const skin = pointAt(phi, v, 0);
    return { depth: -s, point: { ...skin, x: q.x, y: q.y, z: q.z } };
  };

  const uvOf = (thetaDeg: number, sideSign: -1 | 1, yFractionFromCrown: number) => ({
    u: 0.5 + (sideSign * thetaDeg) / 360,
    v: 1 - clamp(yFractionFromCrown, 0, 1),
  });
  const uvOfFront = (viewerX: number, rootY: number) => {
    const v = vOfRootY(rootY);
    return { u: 0.5 + phiOfFrontX(viewerX, v) / TAU, v };
  };
  const uvScaleAt = (v: number) => {
    const hw = halfWidthAt(v);
    const d = depthAt(v);
    const mean = (hw + (d.front + d.back) / 2) / 2;
    return { unitsPerU: Math.max(1, TAU * mean), unitsPerV: heightUnits };
  };

  return {
    front,
    side,
    params,
    heightUnits,
    topY,
    baseY,
    halfWidthAt,
    depthAt,
    vOfRootY,
    yOfV,
    pointAt,
    frontPoint,
    phiOfFrontX,
    crownPoint,
    uvOf,
    uvOfFront,
    uvScaleAt,
    crownHalfWidth,
    crownHalfDepth,
    isOutside,
    skinAlong,
  };
}

/** The body's mesh data: a closed surface of revolution-like rings, metres, with the UVs described above. */
export function buildBodyVertexData(surface: BodySurface, rows = ROWS, cols = COLS): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // Rows are cosine-spaced so the poles are dense and smooth.
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const v = 0.5 - 0.5 * Math.cos(t * Math.PI);
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      const phi = (u - 0.5) * TAU;
      const p = surface.pointAt(phi, v);
      positions.push(p.x, p.y, p.z);
      normals.push(p.nx, p.ny, p.nz);
      uvs.push(u, v);
    }
  }
  const stride = cols + 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      // Outward-facing winding (Babylon culls counter-clockwise faces in its left-handed system).
      indices.push(a, b, c, b, d, c);
    }
  }
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  const computed = new Array<number>(positions.length);
  VertexData.ComputeNormals(positions, indices, computed);
  // The seam at the back duplicates a column of vertices; give both copies one normal so no line shows.
  for (let i = 0; i <= rows; i++) {
    const a = 3 * (i * stride);
    const b = 3 * (i * stride + cols);
    const nx = computed[a] + computed[b];
    const ny = computed[a + 1] + computed[b + 1];
    const nz = computed[a + 2] + computed[b + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    computed[a] = computed[b] = nx / len;
    computed[a + 1] = computed[b + 1] = ny / len;
    computed[a + 2] = computed[b + 2] = nz / len;
  }
  // The poles: every vertex of the top and bottom rows shares one normal.
  for (const row of [0, rows]) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let j = 0; j <= cols; j++) {
      const k = 3 * (row * stride + j);
      nx += computed[k];
      ny += computed[k + 1];
      nz += computed[k + 2];
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let j = 0; j <= cols; j++) {
      const k = 3 * (row * stride + j);
      computed[k] = nx / len;
      computed[k + 1] = ny / len;
      computed[k + 2] = nz / len;
    }
  }
  data.normals = computed;
  return data;
}

export { FRONT_BODY };
