/**
 * LIMBS, TUFT AND APPENDAGES: the feet, the arm paddles, the head tuft, and
 * the traits (antennae, horns, ears, tail), each a handful of bounded
 * root-unit numbers turned into soft shapes and attached to the body
 * surface where the 2D renderer attaches them.
 *
 * Every part hangs from a PIVOT (`TransformNode`) at its anatomical root,
 * so the rig can swing an arm about its shoulder or sway an antenna about
 * its base without knowing how the part was built. All shapes stay inside
 * Blobbi's vocabulary: round ends, no sharp points, no straight cuts.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { rotationFacing } from './orient';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BodySurface, SurfacePoint } from './body';
import { lerp, rad } from './math';
import { ARMS, FEET, TUFT } from './plan';
import { UNIT, VIEWER_X, worldX } from './units';
import { HORN_ANCHORS, topHornLat, type AntennaMorphology, type BlobbiMorphology, type EarMorphology, type HornMorphology, type TailMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';

const AXIS = 408.65657;
const v3 = (p: SurfacePoint) => new Vector3(p.x, p.y, p.z);
const n3 = (p: SurfacePoint) => new Vector3(p.nx, p.ny, p.nz);

export interface Pivoted {
  pivot: TransformNode;
  meshes: Mesh[];
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

/** A tapered tube along a quadratic from `base` through `control` to `tip` (metres, relative to the pivot). */
function stalk(scene: Scene, pivot: TransformNode, name: string, material: Material, base: Vector3, control: Vector3, tip: Vector3, radiusBase: number, radiusTip: number, samples = 14): Mesh {
  const path: Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    path.push(base.scale(u * u).add(control.scale(2 * u * t)).add(tip.scale(t * t)));
  }
  const mesh = MeshBuilder.CreateTube(name, { path, radiusFunction: (i) => lerp(radiusBase, radiusTip, i / samples), tessellation: 14, cap: Mesh.CAP_START }, scene);
  mesh.parent = pivot;
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}

// ─── Feet and arms ───────────────────────────────────────────────────────────

function buildFoot(scene: Scene, parent: TransformNode, m: BlobbiMorphology, materials: BlobbiMaterials, side: -1 | 1, name: string): Pivoted {
  const rx = FEET.rx * m.footSize;
  const ry = FEET.ry * m.footSize * 0.82;
  const rz = FEET.rx * m.footSize * 1.12;
  const x = worldX(side * FEET.spacing * m.footSpacing);
  const pivot = pivotAt(scene, parent, `${name}-foot`, new Vector3(x, ry * UNIT, 14 * UNIT));
  const foot = blob(scene, pivot, `${name}-foot-mesh`, materials.foot, Vector3.Zero(), rx, ry, rz);
  // The authored feet toe out a little.
  foot.rotation.y = -side * VIEWER_X * rad(FEET.rotation);
  return { pivot, meshes: [foot] };
}

function buildArm(scene: Scene, parent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, side: -1 | 1, name: string): Pivoted {
  const canon = side === -1 ? ARMS.left : ARMS.right;
  const shoulderY = canon.y + m.armHeight;
  // The shoulder sits on the silhouette's edge at its height, a little inside it.
  const edge = surface.frontPoint(side * 10000, shoulderY, 0);
  const shoulder = new Vector3(edge.x - VIEWER_X * side * 8 * UNIT, edge.y, edge.z);
  const pivot = pivotAt(scene, parent, `${name}-arm`, shoulder);
  const size = m.armSize;
  const paddle = blob(scene, pivot, `${name}-arm-mesh`, materials.limb, new Vector3(VIEWER_X * side * 12 * size * UNIT, -58 * size * UNIT, 16 * UNIT), 33 * size, 68 * size, 29 * size);
  // Hanging with the tip a little outward, as the authored paddle does.
  paddle.rotation.z = -VIEWER_X * side * rad(8);
  return { pivot, meshes: [paddle] };
}

// ─── Tuft ────────────────────────────────────────────────────────────────────

function buildTuft(scene: Scene, parent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const rootX = TUFT.root.x - AXIS;
  const root = surface.crownPoint(rootX, 0, -8 * UNIT);
  const pivot = pivotAt(scene, parent, `${name}-tuft`, v3(root));
  const meshes: Mesh[] = [];
  const openDir = TUFT.secondary.rotation >= TUFT.main.rotation ? 1 : -1;
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
  };
  leaf('main', TUFT.main, -openDir * m.tuftSpread * 0.5, -2);
  leaf('secondary', TUFT.secondary, openDir * m.tuftSpread * 0.5, 9);
  return { pivot, meshes };
}

// ─── Antennae ────────────────────────────────────────────────────────────────

const SINK = 12;

function buildAntenna(scene: Scene, parent: TransformNode, surface: BodySurface, a: AntennaMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const lateral = a.side * a.position * surface.crownHalfWidth;
  const fore = a.fore * surface.crownHalfDepth;
  const root = surface.crownPoint(lateral, fore, -SINK * UNIT);
  const pivot = pivotAt(scene, parent, name, v3(root));
  const tilt = rad(a.tilt);
  const sweep = rad(a.sweep);
  const dir = new Vector3(VIEWER_X * a.side * Math.sin(tilt), Math.cos(tilt) * Math.cos(sweep), -Math.sin(sweep)).normalize();
  const bend = new Vector3(VIEWER_X * a.side * Math.cos(tilt), Math.sin(tilt), -0.7).normalize();
  const length = (a.length + SINK) * UNIT;
  const base = Vector3.Zero();
  const tip = dir.scale(length);
  const control = dir.scale(length / 2).add(bend.scale(a.curvature * a.length * UNIT));
  const meshes = [stalk(scene, pivot, `${name}-stalk`, materials.limb, base, control, tip, (a.thickness / 2) * UNIT, (a.thickness / 2) * 0.58 * UNIT)];
  meshes.push(blob(scene, pivot, `${name}-tip`, materials.accent, tip, a.tipRadius, a.tipRadius, a.tipRadius, 18));
  return { pivot, meshes };
}

// ─── Horns ───────────────────────────────────────────────────────────────────

function hornMesh(scene: Scene, pivot: TransformNode, h: HornMorphology, materials: BlobbiMaterials, name: string, dir: Vector3, curlDir: Vector3, lengthScale = 1): Mesh[] {
  const length = (h.length * lengthScale + SINK) * UNIT;
  const half = (h.width / 2) * UNIT;
  const tipR = half * h.roundness * 0.55;
  const tip = dir.scale(length);
  // The centre line turns through `curvature` degrees by the tip: a quadratic whose control point leans into the curl.
  const curl = rad(h.curvature);
  const control = dir.scale(length * 0.5).add(curlDir.scale(Math.sin(curl) * length * 0.45));
  const bentTip = tip.add(curlDir.scale(Math.sin(curl) * length * 0.5));
  const meshes = [stalk(scene, pivot, `${name}-cone`, materials.horn, Vector3.Zero(), control, bentTip, half * 1.1, tipR)];
  meshes.push(blob(scene, pivot, `${name}-dome`, materials.horn, bentTip, tipR / UNIT, tipR / UNIT, tipR / UNIT, 14));
  return meshes;
}

function buildHorns(scene: Scene, parent: TransformNode, surface: BodySurface, h: HornMorphology, materials: BlobbiMaterials, name: string): Pivoted[] {
  const out: Pivoted[] = [];
  const tilt = rad(h.tilt);
  if (h.kind === 'forehead') {
    const yFraction = HORN_ANCHORS.foreheadHeight + h.position * HORN_ANCHORS.foreheadSpread;
    const p = surface.pointAt(0, 1 - yFraction, -SINK * UNIT);
    const pivot = pivotAt(scene, parent, `${name}-horn`, v3(p));
    const normal = n3(p);
    // Out of the face, tipped up by the tilt.
    const dir = normal.scale(Math.cos(tilt)).add(Vector3.Up().scale(Math.sin(tilt))).normalize();
    out.push({ pivot, meshes: hornMesh(scene, pivot, h, materials, `${name}-horn`, dir, Vector3.Up()) });
    return out;
  }
  for (const side of [-1, 1] as const) {
    const longer = side === h.asymmetrySide ? 1 + 0.06 * h.asymmetry : 1 - 0.06 * h.asymmetry;
    if (h.kind === 'top') {
      const lateral = side * topHornLat(h.position) * surface.crownHalfWidth;
      const fore = h.fore * surface.crownHalfDepth;
      const p = surface.crownPoint(lateral, fore, -SINK * UNIT);
      const pivot = pivotAt(scene, parent, `${name}-horn-${side}`, v3(p));
      const dir = new Vector3(VIEWER_X * side * Math.sin(tilt), Math.cos(tilt), 0.05).normalize();
      // A positive curl turns the tip up and in (toward the centre line).
      const inward = new Vector3(-VIEWER_X * side, 0.3, 0).normalize();
      out.push({ pivot, meshes: hornMesh(scene, pivot, h, materials, `${name}-horn-${side}`, dir, inward, longer) });
    } else {
      const yFraction = HORN_ANCHORS.sideHeight + h.position * HORN_ANCHORS.sideSpread;
      const p = surface.pointAt((side * Math.PI) / 2, 1 - yFraction, -SINK * UNIT);
      const pivot = pivotAt(scene, parent, `${name}-horn-${side}`, v3(p));
      const dir = new Vector3(VIEWER_X * side * Math.cos(tilt), Math.sin(tilt), 0.08).normalize();
      out.push({ pivot, meshes: hornMesh(scene, pivot, h, materials, `${name}-horn-${side}`, dir, Vector3.Up(), longer) });
    }
  }
  return out;
}

// ─── Ears ────────────────────────────────────────────────────────────────────

const EAR_THETA = 76;

function buildEars(scene: Scene, parent: TransformNode, surface: BodySurface, e: EarMorphology, materials: BlobbiMaterials, name: string): Pivoted[] {
  const out: Pivoted[] = [];
  const tilt = rad(e.tilt);
  for (const side of [-1, 1] as const) {
    const p = surface.pointAt(side * rad(EAR_THETA), 1 - e.position, -SINK * 0.9 * UNIT);
    const pivot = pivotAt(scene, parent, `${name}-ear-${side}`, v3(p));
    const outward = new Vector3(VIEWER_X * side, 0, 0);
    const dir = new Vector3(VIEWER_X * side * Math.sin(tilt), Math.cos(tilt), 0).normalize();
    const forward = new Vector3(0, 0, 1);
    const meshes: Mesh[] = [];
    if (e.kind === 'round') {
      const height = e.size * 1.02 + SINK * 0.9;
      const centre = dir.scale(height * 0.56 * UNIT);
      const outer = blob(scene, pivot, `${name}-ear-${side}-outer`, materials.limb, centre, e.size * 0.56, height * 0.5, e.size * 0.32, 18);
      outer.rotation.z = VIEWER_X * side * tilt;
      const inner = blob(scene, pivot, `${name}-ear-${side}-inner`, materials.cheek, dir.scale(height * 0.6 * UNIT).add(forward.scale(e.size * 0.2 * UNIT)), e.size * 0.3, height * 0.27, e.size * 0.16, 14);
      inner.rotation.z = VIEWER_X * side * tilt;
      inner.visibility = 0.85;
      meshes.push(outer, inner);
    } else {
      const height = e.size * 1.28 + SINK * 0.9;
      const straight = dir.scale(height * UNIT);
      const tip = straight.add(outward.scale(e.flop * e.size * 0.7 * UNIT)).add(new Vector3(0, -e.flop * e.size * 0.42 * UNIT, 0));
      const control = dir.scale(height * 0.62 * UNIT).subtract(outward.scale(e.flop * e.size * 0.12 * UNIT));
      meshes.push(stalk(scene, pivot, `${name}-ear-${side}-outer`, materials.limb, Vector3.Zero(), control, tip, (e.size * 1.16) / 2 * UNIT, e.size * 0.16 * UNIT));
      meshes.push(blob(scene, pivot, `${name}-ear-${side}-tip`, materials.limb, tip, e.size * 0.16, e.size * 0.16, e.size * 0.16, 10));
      const ib = dir.scale((SINK * 0.9 + (height - SINK * 0.9) * 0.2) * UNIT).add(forward.scale(e.size * 0.28 * UNIT));
      const it = Vector3.Lerp(ib, tip.add(forward.scale(e.size * 0.1 * UNIT)), 0.7);
      const ic = Vector3.Lerp(ib, control.add(forward.scale(e.size * 0.22 * UNIT)), 0.8);
      const inner = stalk(scene, pivot, `${name}-ear-${side}-inner`, materials.cheek, ib, ic, it, (e.size * 0.52) / 2 * UNIT, e.size * 0.08 * UNIT, 10);
      inner.visibility = 0.85;
      meshes.push(inner);
    }
    out.push({ pivot, meshes });
  }
  return out;
}

// ─── Tail ────────────────────────────────────────────────────────────────────

function buildTail(scene: Scene, parent: TransformNode, surface: BodySurface, t: TailMorphology, materials: BlobbiMaterials, name: string): Pivoted {
  const sink = SINK * 0.7;
  const p = surface.pointAt(Math.PI, 1 - 0.8, -sink * UNIT);
  const pivot = pivotAt(scene, parent, `${name}-tail`, v3(p));
  const lift = rad(t.lift);
  const dir = new Vector3(0, Math.sin(lift), -Math.cos(lift)).normalize();
  const up = Vector3.Up();
  const meshes: Mesh[] = [];
  if (t.kind === 'nub') {
    const r = t.size * 0.86;
    const centre = dir.scale((sink + r * 0.7) * UNIT);
    meshes.push(blob(scene, pivot, `${name}-tail-nub`, materials.limb, centre, r, r, r, 18));
  } else if (t.kind === 'curl') {
    const length = (t.length + sink) * UNIT;
    const curve = t.curvature * t.length * UNIT;
    const control = dir.scale(length * 0.55).subtract(up.scale(curve));
    const tip = dir.scale(length).add(up.scale(curve * 0.9));
    const thick = t.size * 0.95 * UNIT;
    const endR = (thick / 2) * 0.72;
    meshes.push(stalk(scene, pivot, `${name}-tail-curl`, materials.limb, Vector3.Zero(), control, tip, thick / 2, endR));
    meshes.push(blob(scene, pivot, `${name}-tail-tip`, materials.accent, tip, (endR * 1.25) / UNIT, (endR * 1.25) / UNIT, (endR * 1.25) / UNIT, 16));
  } else {
    const length = t.length * 0.95 + sink;
    const centre = dir.scale((sink + (length - sink) * 0.52) * UNIT);
    const leaf = blob(scene, pivot, `${name}-tail-leaf`, materials.limb, centre, t.size * 0.24, t.size * 0.62, (length - sink) * 0.56, 18);
    leaf.rotationQuaternion = rotationFacing(dir, up);
    meshes.push(leaf);
  }
  return { pivot, meshes };
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
