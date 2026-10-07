/**
 * LIMBS, TUFT AND APPENDAGES: the feet, the arm paddles, the head tuft, and
 * the traits (antennae, horns, ears, tail), each a handful of bounded
 * root-unit numbers turned into soft shapes and attached to the body
 * surface where the 2D renderer attaches them.
 *
 * ATTACHMENT. Every trait is rooted at a MOUNT: a point of the body surface
 * with its outward normal, found by the same anatomical description the kit
 * uses ("on the crown, 56% of the way out", "on the flank, a fifth of the
 * way down", "toward the back of the head"). From the mount a trait gets:
 *
 *  - its direction, by the kit's own rule for its kind (a horn leaves along
 *    the surface's normal eased toward upright; an antenna stands up from
 *    the crown, tilted away from the centre line; an ear leans out);
 *  - a root that is sunk a little INTO the body along the normal and FLARES
 *    where it crosses the skin, so the trait swells out of the body rather
 *    than meeting it at a corner (the kit's `ROOT_FLARE`);
 *  - a centre line that is a curve, not a stick: the kit's own quadratic
 *    (horns, tails), or a cubic that leaves the skin along the normal and
 *    swings to the trait's direction (antennae, ears).
 *
 * No world-space Euler angles are accumulated: directions are built from
 * the mount's normal, world up and the lateral outward axis, and a mesh that
 * needs a frame gets it from `rotationFacing`.
 *
 * Every part hangs from a PIVOT at its root, so the rig can swing an arm or
 * sway an antenna without knowing how the part was built.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BodySurface, SurfacePoint } from './body';
import { clamp, lerp, rad, smoothstep } from './math';
import { rotationFacing } from './orient';
import { ARMS, FEET, TUFT } from './plan';
import { UNIT, VIEWER_X, worldX } from './units';
import { HORN_ANCHORS, topHornLat, type AntennaMorphology, type BlobbiMorphology, type EarMorphology, type HornMorphology, type TailMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';

const AXIS = 408.65657;
const UP = Vector3.Up();
const FORWARD = new Vector3(0, 0, 1);
const v3 = (p: SurfacePoint) => new Vector3(p.x, p.y, p.z);
const n3 = (p: SurfacePoint) => new Vector3(p.nx, p.ny, p.nz);

export interface Pivoted {
  pivot: TransformNode;
  meshes: Mesh[];
  /** Where the part is rooted (the pivot) and where its tip reaches, in the body's frame, metres. For inspection and tests. */
  root: Vector3;
  tip: Vector3;
}

export interface BlobbiParts {
  leftFoot: Pivoted;
  rightFoot: Pivoted;
  leftArm: Pivoted;
  rightArm: Pivoted;
  tuft: Pivoted | null;
  antennae: Pivoted[];
  horns: Pivoted[];
  ears: Pivoted[];
  tail: Pivoted | null;
  all: Mesh[];
}

/** How far inside the skin a trait's root starts, root units: the body covers the join. */
export const SINK = 12;

function pivotAt(scene: Scene, parent: TransformNode, name: string, at: Vector3): TransformNode {
  const node = new TransformNode(name, scene);
  node.parent = parent;
  node.position.copyFrom(at);
  return node;
}

/** A sphere scaled into an ellipsoid, in root units, placed relative to its pivot. */
function blob(scene: Scene, pivot: TransformNode, name: string, material: Material, local: Vector3, rx: number, ry: number, rz: number, segments = 20): Mesh {
  const mesh = MeshBuilder.CreateSphere(name, { diameter: 2, segments }, scene);
  mesh.parent = pivot;
  mesh.material = material;
  mesh.position.copyFrom(local);
  mesh.scaling.set(rx * UNIT, ry * UNIT, rz * UNIT);
  mesh.isPickable = false;
  return mesh;
}

/** Rotate `v` toward `target` by `deg` degrees, in the plane of the two (a negative angle turns away). */
export function turnToward(v: Vector3, target: Vector3, deg: number): Vector3 {
  const a = v.normalizeToNew();
  const t = target.normalizeToNew();
  // The component of the target perpendicular to v: the direction to turn in.
  const perp = t.subtract(a.scale(Vector3.Dot(a, t)));
  if (perp.lengthSquared() < 1e-10) return a;
  perp.normalize();
  const r = rad(deg);
  return a.scale(Math.cos(r)).add(perp.scale(Math.sin(r))).normalize();
}

/** The outward lateral axis for a part on the viewer's side `side`, projected onto the skin's tangent plane. */
function outwardAt(side: -1 | 1, normal: Vector3): Vector3 {
  const lateral = new Vector3(VIEWER_X * side, 0, 0);
  const tangent = lateral.subtract(normal.scale(Vector3.Dot(lateral, normal)));
  return tangent.lengthSquared() < 1e-6 ? lateral : tangent.normalize();
}

const STALK_SAMPLES = 18;

/**
 * The root flare: a stalk is this much wider near its root than its own
 * profile says, swelling into the skin. `skinT` is where along the stalk
 * (0..1) the skin is crossed; the flare is full at the root, 1.2 at the
 * skin, and gone a little past it.
 */
export function rootFlare(t: number, skinT: number): number {
  const fade = smoothstep(1 - t / Math.max(1e-6, skinT * 2.4));
  return 1 + 0.35 * fade * fade;
}

/** A tube along a sampled centre line (metres, relative to the pivot) with a radius profile in root units. */
function stalk(scene: Scene, pivot: TransformNode, name: string, material: Material, path: Vector3[], radiusAt: (t: number) => number): Mesh {
  const last = path.length - 1;
  const mesh = MeshBuilder.CreateTube(name, { path, radiusFunction: (i) => radiusAt(i / last) * UNIT, tessellation: 16, cap: Mesh.CAP_START }, scene);
  mesh.parent = pivot;
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

/** The kit's quadratic centre line: from `base` along `dir` for half the length, then along `tipDir`. */
function quadraticLine(base: Vector3, dir: Vector3, tipDir: Vector3, length: number): Vector3[] {
  const control = base.add(dir.scale(length / 2));
  const tip = control.add(tipDir.scale(length / 2));
  return Array.from({ length: STALK_SAMPLES + 1 }, (_, i) => {
    const t = i / STALK_SAMPLES;
    const u = 1 - t;
    return base.scale(u * u).add(control.scale(2 * u * t)).add(tip.scale(t * t));
  });
}

/**
 * A centre line that LEAVES THE SKIN ALONG ITS NORMAL and swings to the
 * trait's own direction: a cubic from a root sunk inside the body, whose
 * first handle follows the normal and whose last handle arrives along
 * `dir`, bowed by `bend`.
 */
function emergingLine(root: Vector3, normal: Vector3, dir: Vector3, length: number, sink: number, bend: Vector3): Vector3[] {
  const p0 = root.subtract(normal.scale(sink));
  const tip = root.add(dir.scale(length));
  const c1 = root.add(normal.scale(length * 0.3));
  const c2 = tip.subtract(dir.scale(length * 0.3)).add(bend);
  return Array.from({ length: STALK_SAMPLES + 1 }, (_, i) => {
    const t = i / STALK_SAMPLES;
    const u = 1 - t;
    return p0
      .scale(u * u * u)
      .add(c1.scale(3 * u * u * t))
      .add(c2.scale(3 * u * t * t))
      .add(tip.scale(t * t * t));
  });
}

// ─── Feet and arms ───────────────────────────────────────────────────────────

function buildFoot(scene: Scene, parent: TransformNode, m: BlobbiMorphology, materials: BlobbiMaterials, side: -1 | 1, name: string): Pivoted {
  const rx = FEET.rx * m.footSize;
  const ry = FEET.ry * m.footSize * 0.82;
  const rz = FEET.rx * m.footSize * 1.12;
  const x = worldX(side * FEET.spacing * m.footSpacing);
  const at = new Vector3(x, ry * UNIT, 14 * UNIT);
  const pivot = pivotAt(scene, parent, `${name}-foot`, at);
  const foot = blob(scene, pivot, `${name}-foot-mesh`, materials.foot, Vector3.Zero(), rx, ry, rz);
  // The authored feet toe out a little.
  foot.rotation.y = -side * VIEWER_X * rad(FEET.rotation);
  return { pivot, meshes: [foot], root: at, tip: at.add(new Vector3(0, 0, rz * UNIT)) };
}

function buildArm(scene: Scene, parent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, side: -1 | 1, name: string): Pivoted {
  const canon = side === -1 ? ARMS.left : ARMS.right;
  const shoulderY = canon.y + m.armHeight;
  // The shoulder sits on the silhouette's edge at its height, a little inside it.
  const edge = surface.frontPoint(side * 10000, shoulderY, 0);
  const shoulder = new Vector3(edge.x - VIEWER_X * side * 8 * UNIT, edge.y, edge.z);
  const pivot = pivotAt(scene, parent, `${name}-arm`, shoulder);
  const size = m.armSize;
  const centre = new Vector3(VIEWER_X * side * 12 * size * UNIT, -58 * size * UNIT, 16 * UNIT);
  const paddle = blob(scene, pivot, `${name}-arm-mesh`, materials.limb, centre, 33 * size, 68 * size, 29 * size);
  // Hanging with the tip a little outward, as the authored paddle does.
  paddle.rotation.z = -VIEWER_X * side * rad(8);
  return { pivot, meshes: [paddle], root: shoulder, tip: shoulder.add(centre).add(new Vector3(0, -68 * size * UNIT, 0)) };
}

// ─── Tuft ────────────────────────────────────────────────────────────────────

function buildTuft(scene: Scene, parent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const rootX = TUFT.root.x - AXIS;
  const root = surface.crownPoint(rootX, 0, -8 * UNIT);
  const pivot = pivotAt(scene, parent, `${name}-tuft`, v3(root));
  const meshes: Mesh[] = [];
  const openDir = TUFT.secondary.rotation >= TUFT.main.rotation ? 1 : -1;
  let tip = v3(root);
  const leaf = (part: string, spec: typeof TUFT.main, extraTurn: number, zOffset: number) => {
    const dx = (spec.cx - TUFT.root.x) * m.tuftSize;
    const dy = -(spec.cy - TUFT.root.y) * m.tuftSize;
    const mesh = blob(scene, pivot, `${name}-tuft-${part}`, materials.limb, new Vector3(VIEWER_X * dx * UNIT, dy * UNIT, zOffset * UNIT), spec.rx * m.tuftSize, spec.ry * m.tuftSize * m.tuftLength, spec.rx * 0.6 * m.tuftSize, 18);
    // SVG rotation is clockwise on screen: the top of the leaf leans to the viewer's right, which is world -X.
    const angle = spec.rotation + m.tuftTilt + extraTurn;
    mesh.rotation.z = rad(angle);
    // Rotating about the leaf's centre, not the root: turn the offset too.
    const a = rad(m.tuftTilt + extraTurn);
    const ox = VIEWER_X * dx;
    const oy = dy;
    mesh.position.x = (ox * Math.cos(a) - oy * Math.sin(a)) * UNIT;
    mesh.position.y = (ox * Math.sin(a) + oy * Math.cos(a)) * UNIT;
    meshes.push(mesh);
    const top = pivot.position.add(mesh.position).add(new Vector3(0, spec.ry * m.tuftSize * m.tuftLength * UNIT, 0));
    if (top.y > tip.y) tip = top;
  };
  leaf('main', TUFT.main, -openDir * m.tuftSpread * 0.5, -2);
  leaf('secondary', TUFT.secondary, openDir * m.tuftSpread * 0.5, 9);
  return { pivot, meshes, root: v3(root), tip };
}

// ─── Antennae ────────────────────────────────────────────────────────────────

/** The stalk narrows to this fraction of its base width at the tip (the kit's TAPER). */
const ANTENNA_TAPER = 0.58;

/**
 * An antenna: a bobble on a stalk. It stands on the crown where the kit
 * roots it, leaves the skin along the crown's normal and swings to its own
 * direction (up, tilted `tilt` degrees away from the centre line, swept
 * `sweep` degrees back), bowing outward by its curvature. The stalk is the
 * limb colour, flares into the skin, and carries an accent-coloured ball.
 */
function buildAntenna(scene: Scene, parent: TransformNode, surface: BodySurface, a: AntennaMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const lateral = a.side * a.position * surface.crownHalfWidth;
  const fore = a.fore * surface.crownHalfDepth;
  const mount = surface.crownPoint(lateral, fore, 0);
  const root = v3(mount);
  const normal = n3(mount);
  const pivot = pivotAt(scene, parent, name, root);
  const tilt = rad(a.tilt);
  const sweep = rad(a.sweep);
  const dir = new Vector3(VIEWER_X * a.side * Math.sin(tilt), Math.cos(tilt) * Math.cos(sweep), -Math.sin(sweep)).normalize();
  const bend = new Vector3(VIEWER_X * a.side * Math.cos(tilt), Math.sin(tilt), -0.7).normalize().scale(a.curvature * a.length * UNIT);
  const length = a.length * UNIT;
  const sink = SINK * UNIT;
  const path = emergingLine(Vector3.Zero(), normal, dir, length, sink, bend);
  const skinT = sink / (length + sink);
  const half = a.thickness / 2;
  const meshes = [stalk(scene, pivot, `${name}-stalk`, materials.limb, path, (t) => lerp(half, half * ANTENNA_TAPER, t) * rootFlare(t, skinT))];
  const tip = path[path.length - 1];
  meshes.push(blob(scene, pivot, `${name}-tip`, materials.accent, tip, a.tipRadius, a.tipRadius, a.tipRadius, 18));
  return { pivot, meshes, root, tip: root.add(tip) };
}

// ─── Horns ───────────────────────────────────────────────────────────────────

/** The horn's root is this much wider than the horn: it swells out of the body (the kit's ROOT_FLARE). */
const HORN_ROOT_FLARE = 1.22;

/**
 * A horn is short and plump: a thumb, not a spike. Its profile is the
 * kit's: a flared root pulling in quickly, a soft swell along the sides,
 * and a domed tip whose radius is `roundness` of the half-width.
 */
function hornProfile(t: number, half: number, roundness: number, skinT: number): number {
  const tipR = Math.min(0.95, roundness) * half;
  let r: number;
  if (t < 0.22) r = lerp(half * HORN_ROOT_FLARE, half, smoothstep(t / 0.22));
  else if (t < 0.62) r = lerp(half, half * 0.9, smoothstep((t - 0.22) / 0.4));
  else r = lerp(half * 0.9, tipR, smoothstep((t - 0.62) / 0.38));
  return r * lerp(1, rootFlare(t, skinT), 0.5);
}

function hornOn(scene: Scene, parent: TransformNode, h: HornMorphology, materials: BlobbiMaterials, name: string, mount: SurfacePoint, dir: Vector3, curlToward: Vector3, longer: number, widthScale: number): Pivoted {
  const root = v3(mount);
  const normal = n3(mount);
  const pivot = pivotAt(scene, parent, name, root);
  // A stubby horn cannot bend far without folding; it takes less of the curl (the kit's `bendable`).
  const bendable = Math.min(1, Math.max(0.3, (h.length * longer) / (1.25 * h.width)));
  const curl = clamp(h.curvature, -50, 50) * bendable;
  const tipDir = turnToward(dir, curlToward, curl);
  const sink = SINK * 0.55 * UNIT;
  const length = h.length * longer * UNIT + sink;
  const base = normal.scale(-sink);
  const path = quadraticLine(base, dir, tipDir, length);
  const half = (h.width * widthScale) / 2;
  const skinT = sink / length;
  const tipR = Math.min(0.95, h.roundness) * half;
  const meshes = [stalk(scene, pivot, `${name}-body`, materials.horn, path, (t) => hornProfile(t, half, h.roundness, skinT))];
  const tip = path[path.length - 1];
  meshes.push(blob(scene, pivot, `${name}-dome`, materials.horn, tip, tipR, tipR, tipR, 14));
  return { pivot, meshes, root, tip: root.add(tip).add(tipDir.scale(tipR * UNIT)) };
}

/**
 * Horns, by the kit's rules. The tilt gene leans a horn away from its
 * resting direction, in degrees about its canonical 14.
 *
 *  - forehead: one horn in the middle of the brow, leaving the face along
 *    the surface's normal turned well up; a positive curl turns it up and back.
 *  - top: a pair on the crown, each leaving along the crown's normal eased
 *    toward upright, leaned outward by the tilt; a positive curl turns the
 *    tips toward each other.
 *  - side: a pair on the upper flanks, leaving along the flank's normal
 *    turned up; a positive curl turns the tips upward, a negative droops them.
 */
function buildHorns(scene: Scene, parent: TransformNode, surface: BodySurface, h: HornMorphology, materials: BlobbiMaterials, name: string): Pivoted[] {
  const tilt = h.tilt - 14;
  if (h.kind === 'forehead') {
    const mount = surface.pointAt(0, 1 - (HORN_ANCHORS.foreheadHeight + h.position * HORN_ANCHORS.foreheadSpread), 0);
    const n = n3(mount);
    const dir = turnToward(n.add(UP.scale(0.95)).normalize(), UP, tilt * 0.6);
    return [hornOn(scene, parent, h, materials, `${name}-horn`, mount, dir, UP, 1, 1)];
  }
  const out: Pivoted[] = [];
  for (const side of [-1, 1] as const) {
    const pair = side === h.asymmetrySide;
    const longer = pair ? 1 + 0.06 * h.asymmetry : 1;
    if (h.kind === 'top') {
      const mount = surface.crownPoint(side * topHornLat(h.position) * surface.crownHalfWidth, h.fore * surface.crownHalfDepth, 0);
      const n = n3(mount);
      const outward = outwardAt(side, n);
      const upright = n.scale(0.6).add(UP.scale(0.4)).normalize();
      const dir = turnToward(upright, outward, tilt * 0.7);
      out.push(hornOn(scene, parent, h, materials, `${name}-horn-${side}`, mount, dir, outward.scale(-1), longer, 1));
    } else {
      const mount = surface.pointAt((side * Math.PI) / 2, 1 - (HORN_ANCHORS.sideHeight + h.position * HORN_ANCHORS.sideSpread), 0);
      const n = n3(mount);
      const lift = 0.62 + tilt / 45;
      const dir = n.add(UP.scale(lift)).normalize();
      out.push(hornOn(scene, parent, h, materials, `${name}-horn-${side}`, mount, dir, UP, longer, 1));
    }
  }
  return out;
}

// ─── Ears ────────────────────────────────────────────────────────────────────

/**
 * The ears sit high on the flanks, just behind the head's widest line (the
 * kit mounts them "toward the back of the head" and draws them on the
 * silhouette's edge from the front: in 3D the root hides behind the head's
 * curve while the leaf stands clear of it), leaning a little back.
 */
const EAR = { theta: 104, profileLean: 16 } as const;

/**
 * Ears are flat leaves standing on the head's upper flank, leaning out by
 * the tilt and a little back, showing their pink inside to the front and
 * the near side. `round` is a soft oval; `pointed` is a wide soft cone
 * whose tip flops outward and down. Both are thin across the ear's plane,
 * which faces between forward and outward.
 */
function buildEars(scene: Scene, parent: TransformNode, surface: BodySurface, e: EarMorphology, materials: BlobbiMaterials, name: string): Pivoted[] {
  const out: Pivoted[] = [];
  for (const side of [-1, 1] as const) {
    const mount = surface.pointAt(side * rad(EAR.theta), 1 - e.position, 0);
    const root = v3(mount);
    const pivot = pivotAt(scene, parent, `${name}-ear-${side}`, root);
    const outward = new Vector3(VIEWER_X * side, 0, 0);
    // Up, leaned outward by the tilt, and a little back.
    const dir = turnToward(turnToward(UP, outward, e.tilt), FORWARD.scale(-1), EAR.profileLean);
    // The ear's plane faces between forward and outward; the leaf is thin across it.
    const planeNormal = FORWARD.add(outward.scale(0.8)).normalize();
    const leafFrame = new TransformNode(`${name}-ear-${side}-frame`, scene);
    leafFrame.parent = pivot;
    leafFrame.rotationQuaternion = rotationFacing(planeNormal, dir);
    const sink = SINK * 0.9;
    const meshes: Mesh[] = [];
    let tip: Vector3;
    if (e.kind === 'round') {
      const height = e.size * 1.02 + sink;
      // In the leaf's frame +Y is the ear's direction and +Z faces the plane normal.
      const centreY = -sink + height * 0.56;
      const outer = blob(scene, leafFrame, `${name}-ear-${side}-outer`, materials.limb, new Vector3(0, centreY * UNIT, 0), e.size * 0.56, height * 0.5, e.size * 0.3, 18);
      const inner = blob(scene, leafFrame, `${name}-ear-${side}-inner`, materials.cheek, new Vector3(0, (-sink + height * 0.6) * UNIT, e.size * 0.26 * UNIT), e.size * 0.3, height * 0.27, e.size * 0.1, 14);
      inner.visibility = 0.85;
      meshes.push(outer, inner);
      tip = dir.scale((height - sink) * UNIT);
    } else {
      const height = e.size * 1.28;
      // Which way of the leaf's own X axis is outward.
      const localOut = Math.sign(Vector3.Dot(Vector3.Cross(dir, planeNormal), outward)) || 1;
      const flopX = localOut * e.flop * e.size * 0.7;
      const flopY = -e.flop * e.size * 0.42;
      const base = new Vector3(0, -sink * UNIT, 0);
      const c1 = new Vector3(0, height * 0.32 * UNIT, 0);
      const c2 = new Vector3(-localOut * e.flop * e.size * 0.12 * UNIT, height * 0.72 * UNIT, 0);
      const tipLocal = new Vector3(flopX * UNIT, (height + flopY) * UNIT, 0);
      const path = Array.from({ length: STALK_SAMPLES + 1 }, (_, i) => {
        const t = i / STALK_SAMPLES;
        const u = 1 - t;
        return base
          .scale(u * u * u)
          .add(c1.scale(3 * u * u * t))
          .add(c2.scale(3 * u * t * t))
          .add(tipLocal.scale(t * t * t));
      });
      const half = (e.size * 1.16) / 2;
      const tipR = e.size * 0.14;
      const skinT = sink / (height + sink);
      const leaf = stalk(scene, leafFrame, `${name}-ear-${side}-outer`, materials.limb, path, (t) => lerp(half, tipR, smoothstep(t) * 0.85 + t * 0.15) * rootFlare(t, skinT));
      // A leaf, not a cone: thin across the ear's plane.
      leaf.scaling.z = 0.42;
      const cap = blob(scene, leafFrame, `${name}-ear-${side}-tip`, materials.limb, tipLocal, tipR, tipR, tipR * 0.42, 10);
      // The pink inside lies on the leaf's front face: offset past the leaf's own thickness.
      const innerPath = path.slice(3).map((p) => p.scale(0.78).add(new Vector3(0, 0, half * 0.5 * UNIT)));
      const inner = stalk(scene, leafFrame, `${name}-ear-${side}-inner`, materials.cheek, innerPath, (t) => lerp(half * 0.5, tipR * 0.6, t));
      inner.scaling.z = 0.3;
      inner.visibility = 0.85;
      meshes.push(leaf, cap, inner);
      tip = new Vector3(flopX, height + flopY, 0).scale(UNIT).rotateByQuaternionToRef(leafFrame.rotationQuaternion, new Vector3());
    }
    out.push({ pivot, meshes, root, tip: root.add(tip) });
  }
  return out;
}

// ─── Tail ────────────────────────────────────────────────────────────────────

function buildTail(scene: Scene, parent: TransformNode, surface: BodySurface, t: TailMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const sink = SINK * 0.7;
  const mount = surface.pointAt(Math.PI, 1 - 0.8, 0);
  const root = v3(mount);
  const normal = n3(mount);
  const pivot = pivotAt(scene, parent, `${name}-tail`, root);
  const lift = rad(t.lift);
  const dir = new Vector3(0, Math.sin(lift), -Math.cos(lift)).normalize();
  const meshes: Mesh[] = [];
  let tip: Vector3;
  if (t.kind === 'nub') {
    const r = t.size * 0.86;
    const centre = dir.scale(r * 0.5 * UNIT);
    meshes.push(blob(scene, pivot, `${name}-tail-nub`, materials.limb, centre, r, r, r, 18));
    tip = centre.add(dir.scale(r * UNIT));
  } else if (t.kind === 'curl') {
    const length = (t.length + sink) * UNIT;
    const curve = t.curvature * t.length * UNIT;
    const bend = UP.scale(curve * 0.9);
    const path = emergingLine(Vector3.Zero(), normal, dir, length, sink * UNIT, bend.scale(-1));
    // The curl: the tip turns upward.
    const tipPoint = path[path.length - 1].add(bend);
    path[path.length - 1] = tipPoint;
    path[path.length - 2] = path[path.length - 2].add(bend.scale(0.45));
    const thick = t.size * 0.95;
    const endR = (thick / 2) * 0.72;
    const skinT = (sink * UNIT) / length;
    meshes.push(stalk(scene, pivot, `${name}-tail-curl`, materials.limb, path, (u) => lerp(thick / 2, endR, u) * rootFlare(u, skinT)));
    meshes.push(blob(scene, pivot, `${name}-tail-tip`, materials.accent, tipPoint, endR * 1.25, endR * 1.25, endR * 1.25, 16));
    tip = tipPoint;
  } else {
    const length = t.length * 0.95 + sink;
    const centre = dir.scale((-sink + length * 0.52) * UNIT);
    const leaf = blob(scene, pivot, `${name}-tail-leaf`, materials.limb, centre, t.size * 0.24, t.size * 0.62, (length - sink) * 0.56, 18);
    leaf.rotationQuaternion = rotationFacing(dir, UP);
    tip = dir.scale((length - sink) * UNIT);
  }
  return { pivot, meshes, root, tip: root.add(tip) };
}

// ─── All together ────────────────────────────────────────────────────────────

export function buildParts(scene: Scene, bodyNode: TransformNode, feetParent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, name = 'blobbi'): BlobbiParts {
  const leftFoot = buildFoot(scene, feetParent, m, materials, -1, `${name}-left`);
  const rightFoot = buildFoot(scene, feetParent, m, materials, 1, `${name}-right`);
  const leftArm = buildArm(scene, bodyNode, surface, m, materials, -1, `${name}-left`);
  const rightArm = buildArm(scene, bodyNode, surface, m, materials, 1, `${name}-right`);
  const tuft = buildTuft(scene, bodyNode, surface, m, materials, name);
  const antennae = m.antennae.map((a, i) => buildAntenna(scene, bodyNode, surface, a, materials, `${name}-antenna-${i}`));
  const horns = m.horns ? buildHorns(scene, bodyNode, surface, m.horns, materials, name) : [];
  const ears = m.ears ? buildEars(scene, bodyNode, surface, m.ears, materials, name) : [];
  const tail = m.tail ? buildTail(scene, bodyNode, surface, m.tail, materials, name) : null;
  const all = [leftFoot, rightFoot, leftArm, rightArm, tuft, ...antennae, ...horns, ...ears, ...(tail ? [tail] : [])].flatMap((p) => p.meshes);
  return { leftFoot, rightFoot, leftArm, rightArm, tuft, antennae, horns, ears, tail, all };
}
