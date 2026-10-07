/**
 * A SWEPT MESH WITH A SURFACE-CONFORMING ROOT: the one way every trait
 * that grows out of the body is built.
 *
 * A sweep is a centre line C(t) with a cross-section ring at each sample:
 * a circle (or a flattened oval, for leaves) of radius r(t), laid in a
 * frame that is PARALLEL-TRANSPORTED along the curve (rotation-minimising:
 * each ring's frame is the previous one turned by exactly the rotation that
 * takes the previous tangent to the new one), so a curved horn's rings
 * follow its bend without rolling or twisting.
 *
 * The root is an AREA on a curved body, not a point. The root ring is laid
 * a fixed depth UNDER the skin, each vertex under its own patch of skin
 * (found along the mount's normal through it). Above it, every vertex that
 * is still near the skin (within a few sinks of it, by its own depth) is
 * blended toward that same sunk placement, and a vertex clear of the skin
 * is left exactly where the free sweep puts it. So the whole perimeter of
 * the root is inside the body whatever the body's curvature, the wall
 * crosses the skin once on every side, nothing floats, and the trait's
 * visible shape above the root is its own, untouched.
 *
 * Pure geometry in the part's own frame (metres, relative to its pivot);
 * the conform callback is where the body comes in.
 */
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { clamp, smoothstep } from './math';

export interface SweepConform {
  /** The skin under a point of the sweep (pivot frame), along the mount's normal: its position and how far `point` is outside it. */
  skinUnder(point: Vector3): { depth: number; skin: Vector3; normal: Vector3 } | null;
  /** How far under the skin the root ring lies, metres. */
  sink: number;
  /** Beyond this arc length from the root (metres) a ring is always free, whatever its depth. */
  run: number;
}

/** A vertex this far outside the skin (in sinks) is free; between the root depth and this it blends. */
const CLEAR_SINKS = 1.5;

export interface SweepOptions {
  /** The centre line, pivot frame, metres, from root to tip. */
  path: Vector3[];
  /** Ring radius at t (0 root, 1 tip), metres. */
  radiusAt(t: number): number;
  /** A flattened section: the ring is scaled by `scale` along `axis` (the thin direction of a leaf). */
  flatten?: { axis: Vector3; scale: number };
  segments?: number;
  conform?: SweepConform;
  /** Close the tip with a fan (a pointed or rounded end); the root is always closed. */
  closeTip?: boolean;
}

export interface Sweep {
  vertexData: VertexData;
  /** The ring vertices, pivot frame, by ring then segment. */
  rings: Vector3[][];
  centres: Vector3[];
  tangents: Vector3[];
  /** The first ring index at which the sweep is fully free of the root blend. */
  freeFrom: number;
}

const DEFAULT_SEGMENTS = 16;

/** Tangents of a polyline: central differences, end differences at the ends. */
function tangentsOf(path: Vector3[]): Vector3[] {
  const n = path.length;
  return path.map((_, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const t = b.subtract(a);
    return t.lengthSquared() < 1e-14 ? new Vector3(0, 1, 0) : t.normalize();
  });
}

/** A unit vector perpendicular to `t`, from `hint` where possible. */
function perpendicular(t: Vector3, hint: Vector3): Vector3 {
  const p = hint.subtract(t.scale(Vector3.Dot(hint, t)));
  if (p.lengthSquared() > 1e-10) return p.normalize();
  const alt = Math.abs(t.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return alt.subtract(t.scale(Vector3.Dot(alt, t))).normalize();
}

/** Rotate `v` by the rotation that takes unit `from` to unit `to` (Rodrigues). */
function transport(v: Vector3, from: Vector3, to: Vector3): Vector3 {
  const axis = Vector3.Cross(from, to);
  const s = axis.length();
  const c = clamp(Vector3.Dot(from, to), -1, 1);
  if (s < 1e-9) return c > 0 ? v.clone() : v.scale(-1);
  const k = axis.scale(1 / s);
  return v.scale(c).add(Vector3.Cross(k, v).scale(s)).add(k.scale(Vector3.Dot(k, v) * (1 - c)));
}

export function buildSweep(options: SweepOptions): Sweep {
  const { path, radiusAt, flatten, conform } = options;
  const segments = options.segments ?? DEFAULT_SEGMENTS;
  const n = path.length;
  const tangents = tangentsOf(path);

  // Rotation-minimising frames: U starts from the flatten axis (or anything perpendicular) and is carried along.
  const U: Vector3[] = [perpendicular(tangents[0], flatten?.axis ?? new Vector3(1, 0, 0))];
  for (let i = 1; i < n; i++) U.push(perpendicular(tangents[i], transport(U[i - 1], tangents[i - 1], tangents[i])));
  const V = U.map((u, i) => Vector3.Cross(tangents[i], u).normalize());

  // Arc length, for the root blend.
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + path[i].subtract(path[i - 1]).length());

  const rings: Vector3[][] = [];
  let freeFrom = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = radiusAt(t);
    const w = conform ? smoothstep(arc[i] / Math.max(1e-6, conform.run)) : 1;
    if (w >= 1 && freeFrom === 0 && i > 0) freeFrom = i;
    const ring: Vector3[] = [];
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const free = path[i].add(U[i].scale(Math.cos(a) * r * (flatten?.scale ?? 1))).add(V[i].scale(Math.sin(a) * r));
      if (!conform || w >= 1) {
        ring.push(free);
        continue;
      }
      const under = conform.skinUnder(free);
      if (!under) {
        ring.push(free);
        continue;
      }
      // Where this vertex would be if it were simply `sink` under its own patch of skin.
      const sunk = under.skin.subtract(under.normal.scale(conform.sink));
      // The root ring is sunk outright. Above it a vertex follows its own depth: at the root depth it is sunk,
      // clear of the skin it is free, in between it blends; and past the run it is free whatever its depth.
      const byDepth = smoothstep((under.depth + conform.sink) / ((CLEAR_SINKS + 1) * conform.sink));
      const f = i === 0 ? 0 : Math.max(w, byDepth);
      ring.push(Vector3.Lerp(sunk, free, f));
    }
    rings.push(ring);
  }
  if (freeFrom === 0) freeFrom = n - 1;

  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) for (const p of ring) positions.push(p.x, p.y, p.z);
  const at = (i: number, j: number) => i * segments + (j % segments);
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = at(i, j);
      const b = at(i, j + 1);
      const c = at(i + 1, j);
      const d = at(i + 1, j + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  // The root cap: a fan from the root ring's centre (inside the body).
  const rootCentre = positions.length / 3;
  const c0 = rings[0].reduce((acc, p) => acc.add(p), Vector3.Zero()).scale(1 / segments);
  positions.push(c0.x, c0.y, c0.z);
  for (let j = 0; j < segments; j++) indices.push(rootCentre, at(0, j + 1), at(0, j));
  if (options.closeTip) {
    const tipCentre = positions.length / 3;
    const cn = path[n - 1];
    positions.push(cn.x, cn.y, cn.z);
    for (let j = 0; j < segments; j++) indices.push(tipCentre, at(n - 1, j), at(n - 1, j + 1));
  }

  // Outward winding: the wall's normal must point away from the centre line, whichever way the frame came out.
  const normals = new Array<number>(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const probe = Math.min(n - 1, Math.max(1, freeFrom));
  const k = at(probe, 0);
  const outward = rings[probe][0].subtract(path[probe]);
  if (normals[3 * k] * outward.x + normals[3 * k + 1] * outward.y + normals[3 * k + 2] * outward.z < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
    VertexData.ComputeNormals(positions, indices, normals);
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  return { vertexData, rings, centres: path.map((p) => p.clone()), tangents, freeFrom };
}

/** The kit's quadratic centre line: along `dir` for half the length, then along `tipDir` (the tangent turned by the curl). */
export function kitQuadratic(base: Vector3, dir: Vector3, tipDir: Vector3, length: number, samples: number): Vector3[] {
  const control = base.add(dir.scale(length / 2));
  const tip = control.add(tipDir.scale(length / 2));
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const u = 1 - t;
    return base.scale(u * u).add(control.scale(2 * u * t)).add(tip.scale(t * t));
  });
}
