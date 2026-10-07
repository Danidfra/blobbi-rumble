/**
 * THE FACE IN 3D: eyes, lids, brows and mouth as meshes on the body's skin.
 *
 * The 2D face is a drawing on a flat silhouette; in 3D the same features
 * sit ON the body surface, each found with `surface.frontPoint` from the
 * same root-unit coordinates the kit's face builder uses (the eye line as a
 * fraction of the body's height, the eyes' spacing scaled by the gene, the
 * mouth's width in the plan's units). So the face lands where the drawing
 * has it, and a wide-set, high-eyed individual is wide-set and high-eyed
 * in both.
 *
 * Eyes are real geometry (a bulging white, a flattened iris and pupil, two
 * highlights) because they catch the light and read from any angle; the
 * brows and mouth are tubes and a fan so they stay crisp and can animate;
 * cheeks, freckles and the blush are painted (see `markings/painter.ts`).
 *
 * An expression arrives as a `FacePose` in the face's own units, as in 2D.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { rotationFacing } from '../geometry/orient';
import type { Scene } from '@babylonjs/core/scene';
import type { BodySurface } from '../geometry/body';
import { clamp, cubicAt, lerp, pt, quadraticAt, type Pt } from '../geometry/math';
import { BROWS, EYES, MOUTH } from '../geometry/plan';
import { UNIT, VIEWER_X } from '../geometry/units';
import type { BlobbiMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';
import { lidShape, type BrowPose, type FacePose, type MouthPose } from './expressions';

export interface Gaze {
  x: number;
  y: number;
}

/** Where the face's features are, in the front drawing's root units (viewer frame). */
export interface FaceLayout {
  eyeLineY: number;
  halfSpacing: number;
  tilt: number;
  eyeK: number;
  eyeRx: number;
  eyeRy: number;
  mouthStart: Pt;
  mouthUnit: number;
  cheekY: number;
  cheekSpacing: number;
  browGap: number;
}

export function layoutFace(m: BlobbiMorphology, surface: BodySurface): FaceLayout {
  const frameY = (y: number) => surface.front.top + ((y - 136.79346) / 630.66717) * surface.front.height;
  const midX = (EYES.left.x + EYES.right.x) / 2;
  const eyeLineCanon = (EYES.left.y + EYES.right.y) / 2;
  const eyeK = EYES.k * m.eyeSize;
  const cheekSpacingCanon = (571.65656 - 245.65657) / 2;
  const browGap = EYES.left.y - EYES.white.ry * EYES.k - BROWS.left.y;
  return {
    eyeLineY: frameY(eyeLineCanon) + m.eyeHeight,
    halfSpacing: ((EYES.right.x - EYES.left.x) / 2) * m.eyeSpacing,
    tilt: (EYES.left.y - EYES.right.y) / 2 + m.eyeTilt,
    eyeK,
    eyeRx: EYES.white.rx * eyeK,
    eyeRy: EYES.white.ry * eyeK,
    mouthStart: pt(midX - (MOUTH.width * m.mouthWidth) / 2 + (MOUTH.start.x + MOUTH.width / 2 - midX), frameY(MOUTH.start.y) + m.mouthHeight),
    mouthUnit: MOUTH.width * m.mouthWidth,
    cheekY: frameY(499.44977),
    cheekSpacing: cheekSpacingCanon * lerp(1, m.bodyWidth, 0.8) * lerp(1, m.eyeSpacing, 0.5),
    browGap,
  };
}

const AXIS = 408.65657;
/** The front drawing's x, relative to the axis, in the viewer's frame. */
const vx = (x: number) => x - AXIS;

// ─── Eyes ────────────────────────────────────────────────────────────────────

interface EyeParts {
  node: TransformNode;
  white: Mesh;
  inner: TransformNode;
  iris: Mesh;
  pupil: Mesh;
  highlight: Mesh;
  glint: Mesh;
  upperLid: Mesh;
  lowerLid: Mesh;
  lidLine: Mesh;
  rx: number;
  ry: number;
  rz: number;
  local: (typeof EYES)['localLeft'];
  side: -1 | 1;
}

/** Orient a node so its local +Z is `normal` and its local +Y is as upright as possible. */
function orientToNormal(node: TransformNode, normal: Vector3, position: Vector3) {
  node.position.copyFrom(position);
  node.rotationQuaternion = rotationFacing(normal);
}

const LID_SAMPLES = 18;
/** How much the eyes face straight ahead (1) rather than along the skin (0). */
const EYE_FORWARD = 0.55;

/** The eye's own surface height at a point in its local xy (root units), or 0 outside it. */
const bulge = (x: number, y: number, rx: number, ry: number, rz: number) => rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2 - (y / ry) ** 2));

function lidPolygon(eye: EyeParts, closure: number, which: 'upper' | 'lower'): Pt[] | null {
  const shape = lidShape(closure);
  if (!shape) return null;
  if (which === 'lower' && shape.lower <= 0) return null;
  const { rx, ry } = eye;
  // In the eye's local frame y is UP; the kit's lid math has y down, so every kit y is negated.
  const reachAt = (yDown: number) => {
    const onOutline = rx * Math.sqrt(Math.max(0, 1 - (yDown / ry) ** 2));
    return shape.reach === null ? onOutline : lerp(onOutline, shape.reach * rx, shape.lower);
  };
  const outline = (a: number) => pt(rx * Math.cos(a) * 1.02, ry * Math.sin(a) * 1.02);
  const points: Pt[] = [];
  if (which === 'upper') {
    const yDown = shape.chord * ry;
    const reach = reachAt(yDown);
    const ctrlDown = yDown + shape.sag * ry;
    // The edge from the right end to the left (sagging), then the outline from the left end over the top back to the right.
    for (let i = 0; i <= LID_SAMPLES; i++) {
      const q = quadraticAt(pt(reach, yDown), pt(0, ctrlDown), pt(-reach, yDown), i / LID_SAMPLES);
      points.push(pt(q.x, -q.y));
    }
    let aL = Math.atan2(-yDown / ry, -reach / rx);
    if (aL < 0) aL += Math.PI * 2;
    const aR = Math.atan2(-yDown / ry, reach / rx);
    for (let i = 1; i < LID_SAMPLES; i++) points.push(outline(aL - (aL - aR) * (i / LID_SAMPLES)));
    return points;
  }
  // The lower lid rises from below the eye to meet the upper edge.
  const lowDown = lerp(1.15 * ry, shape.chord * ry, shape.lower);
  const ctrlDown = lowDown + lerp(0, shape.sag * ry, shape.lower);
  const reach = reachAt(Math.min(ry * 0.999, lowDown));
  for (let i = 0; i <= LID_SAMPLES; i++) {
    const q = quadraticAt(pt(-reach, lowDown), pt(0, ctrlDown), pt(reach, lowDown), i / LID_SAMPLES);
    points.push(pt(q.x, -q.y));
  }
  const aR = Math.atan2(-lowDown / ry, reach / rx);
  let aL = Math.atan2(-lowDown / ry, -reach / rx);
  if (aL > aR) aL -= Math.PI * 2;
  for (let i = 1; i < LID_SAMPLES; i++) points.push(outline(aR - (aR - aL) * (i / LID_SAMPLES)));
  return points;
}

/** A lid polygon always has this many points: the edge's samples and the outline's. */
const LID_POLYGON = 2 * LID_SAMPLES;
const LID_VERTS = LID_POLYGON + 1;

function lidVertexData(eye: EyeParts, polygon: Pt[] | null): { positions: number[] } {
  const positions: number[] = [];
  const { rx, ry, rz } = eye;
  const lift = 1.6;
  if (!polygon) {
    for (let i = 0; i <= LID_VERTS; i++) positions.push(0, 0, 0);
    return { positions };
  }
  let cx = 0;
  let cy = 0;
  for (const p of polygon) {
    cx += p.x;
    cy += p.y;
  }
  cx /= polygon.length;
  cy /= polygon.length;
  positions.push(cx * UNIT, cy * UNIT, (bulge(cx, cy, rx, ry, rz) + lift) * UNIT);
  for (const p of polygon) positions.push(p.x * UNIT, p.y * UNIT, (bulge(p.x, p.y, rx, ry, rz) + lift) * UNIT);
  while (positions.length < 3 * (LID_VERTS + 1)) positions.push(positions[0], positions[1], positions[2]);
  return { positions };
}

function buildEye(scene: Scene, parent: TransformNode, materials: BlobbiMaterials, side: -1 | 1, name: string): EyeParts {
  const node = new TransformNode(`${name}-eye`, scene);
  node.parent = parent;
  const white = MeshBuilder.CreateSphere(`${name}-eye-white`, { diameter: 2, segments: 24 }, scene);
  white.parent = node;
  white.material = materials.eyeWhite;
  const inner = new TransformNode(`${name}-eye-inner`, scene);
  inner.parent = node;
  const disc = (part: string, material: Mesh['material']) => {
    const mesh = MeshBuilder.CreateSphere(`${name}-eye-${part}`, { diameter: 2, segments: 16 }, scene);
    mesh.parent = inner;
    mesh.material = material;
    return mesh;
  };
  const iris = disc('iris', materials.iris);
  const pupil = disc('pupil', materials.pupil);
  const highlight = disc('highlight', materials.glint);
  const glint = disc('glint', materials.glint);
  const lid = (part: string) => {
    const mesh = new Mesh(`${name}-eye-${part}`, scene);
    mesh.parent = node;
    mesh.material = materials.lid;
    // A fan over a fixed-size polygon: the indices never change, only the positions do.
    const data = new VertexData();
    data.positions = new Array(3 * (LID_VERTS + 1)).fill(0);
    const indices: number[] = [];
    for (let i = 1; i <= LID_POLYGON; i++) {
      const next = i === LID_POLYGON ? 1 : i + 1;
      indices.push(0, i, next, 0, next, i);
    }
    data.indices = indices;
    data.applyToMesh(mesh, true);
    return mesh;
  };
  const upperLid = lid('upper-lid');
  const lowerLid = lid('lower-lid');
  const lidLine = MeshBuilder.CreateTube(
    `${name}-eye-lid-line`,
    { path: Array.from({ length: LID_SAMPLES + 1 }, (_, i) => new Vector3(i * 0.001, 0, 0)), radius: 0.001, tessellation: 8, updatable: true, cap: Mesh.CAP_ALL },
    scene,
  );
  lidLine.parent = node;
  lidLine.material = materials.feature;
  for (const mesh of [white, iris, pupil, highlight, glint, upperLid, lowerLid, lidLine]) mesh.isPickable = false;
  return { node, white, inner, iris, pupil, highlight, glint, upperLid, lowerLid, lidLine, rx: 1, ry: 1, rz: 1, local: side === -1 ? EYES.localLeft : EYES.localRight, side };
}

// ─── Brows and mouth ─────────────────────────────────────────────────────────

const BROW_SAMPLES = 10;
const MOUTH_SAMPLES = 14;

/** A point of the front drawing (root units, absolute artwork x and y) on the skin, lifted off it. */
function onSkin(surface: BodySurface, x: number, y: number, lift: number): Vector3 {
  const p = surface.frontPoint(vx(x), y, lift * UNIT);
  return new Vector3(p.x, p.y, p.z);
}

export interface FaceRig {
  root: TransformNode;
  eyes: { left: EyeParts; right: EyeParts };
  browLeft: Mesh;
  browRight: Mesh;
  mouthLine: Mesh;
  mouthFill: Mesh;
  layout: FaceLayout;
  /** The lid closure last applied (0 open, 1 shut), for inspection. */
  lastClosure: number;
  /** Apply a pose (expression), gaze and sleep. Cheap enough to call every frame. */
  apply(pose: FacePose, gaze: Gaze, sleeping: boolean, blink: number): void;
  dispose(): void;
}

export function buildFace(scene: Scene, parent: TransformNode, surface: BodySurface, m: BlobbiMorphology, materials: BlobbiMaterials, name = 'blobbi'): FaceRig {
  const root = new TransformNode(`${name}-face`, scene);
  root.parent = parent;
  const layout = layoutFace(m, surface);

  const left = buildEye(scene, root, materials, -1, `${name}-left`);
  const right = buildEye(scene, root, materials, 1, `${name}-right`);
  const placeEye = (eye: EyeParts) => {
    // The viewer's-left eye sits a little lower (the authored face is a touch diagonal), plus this individual's tilt.
    const cx = eye.side * layout.halfSpacing;
    const cy = layout.eyeLineY - eye.side * layout.tilt;
    eye.rx = layout.eyeRx;
    eye.ry = layout.eyeRy;
    eye.rz = layout.eyeRx * 0.7;
    const p = surface.frontPoint(cx, cy, -eye.rz * 0.62 * UNIT);
    // The drawing is a frontal face: the eyes look mostly straight ahead, and only a little along the skin's
    // normal, so the inner eye sits where the drawing has it from the front and the white still hugs the head.
    const forward = new Vector3(p.nx, p.ny, p.nz).scale(1 - EYE_FORWARD).add(new Vector3(0, 0, 1).scale(EYE_FORWARD)).normalize();
    orientToNormal(eye.node, forward, new Vector3(p.x, p.y, p.z));
    eye.white.scaling.set(eye.rx * UNIT, eye.ry * UNIT, eye.rz * UNIT);
  };
  placeEye(left);
  placeEye(right);

  const tube = (part: string, samples: number, radius: number, material: Mesh['material']) => {
    const mesh = MeshBuilder.CreateTube(
      `${name}-${part}`,
      { path: Array.from({ length: samples + 1 }, (_, i) => new Vector3(i * 0.001, 0, 0)), radius, tessellation: 10, updatable: true, cap: Mesh.CAP_ALL },
      scene,
    );
    mesh.parent = root;
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  };
  const browLeft = tube('left-brow', BROW_SAMPLES, (BROWS.strokeWidth / 2) * UNIT, materials.line);
  const browRight = tube('right-brow', BROW_SAMPLES, (BROWS.strokeWidth / 2) * UNIT, materials.line);
  const mouthLine = tube('mouth', MOUTH_SAMPLES, (MOUTH.strokeWidth / 2) * UNIT, materials.feature);
  const mouthUpper = tube('mouth-upper', MOUTH_SAMPLES, (MOUTH.strokeWidth / 2) * UNIT, materials.feature);
  const mouthFill = new Mesh(`${name}-mouth-fill`, scene);
  mouthFill.parent = root;
  mouthFill.material = materials.feature;
  mouthFill.isPickable = false;
  {
    const data = new VertexData();
    data.positions = new Array(3 * (MOUTH_SAMPLES * 2 + 2)).fill(0);
    const indices: number[] = [];
    for (let i = 1; i <= MOUTH_SAMPLES * 2 + 1; i++) {
      const next = i === MOUTH_SAMPLES * 2 + 1 ? 1 : i + 1;
      indices.push(0, i, next, 0, next, i);
    }
    data.indices = indices;
    data.applyToMesh(mouthFill, true);
  }

  const browPath = (eye: EyeParts, canonEye: Pt, canonStart: Pt, pose: BrowPose): Vector3[] => {
    const cx = AXIS + eye.side * layout.halfSpacing;
    const cy = layout.eyeLineY - eye.side * layout.tilt;
    const start = pt(cx + (canonStart.x - canonEye.x) * m.eyeSize, cy - eye.ry - layout.browGap * 0.75 - m.browHeight);
    const width = BROWS.width * m.eyeSize;
    const a = pt(start.x, start.y + pose.start * width);
    const c = pt(start.x + 0.5 * width, start.y + pose.ctrl * width);
    const b = pt(start.x + width, start.y + pose.end * width);
    return Array.from({ length: BROW_SAMPLES + 1 }, (_, i) => {
      const q = quadraticAt(a, c, b, i / BROW_SAMPLES);
      return onSkin(surface, q.x, q.y, BROWS.strokeWidth * 0.3);
    });
  };

  const mouthCurves = (pose: MouthPose): { lower: Pt[]; upper: Pt[]; open: boolean } => {
    const unit = layout.mouthUnit;
    const start = layout.mouthStart;
    const curve = m.mouthCurve;
    const width = unit * pose.width;
    const x0 = start.x + (unit - width) / 2;
    const y = start.y + pose.dy * unit;
    const leftP = pt(x0, y);
    const rightP = pt(x0 + width, y);
    const hxL = (pose.hx + pose.hxSkew) * width;
    const hxR = (pose.hx - pose.hxSkew) * width;
    const depth = unit * curve;
    const lowL = pt(x0 + hxL, y + (pose.low - pose.lowSkew) * depth);
    const lowR = pt(x0 + width - hxR, y + (pose.low + pose.lowSkew) * depth);
    const open = Math.abs(pose.low - pose.up) * depth > 0.75;
    const lower = Array.from({ length: MOUTH_SAMPLES + 1 }, (_, i) => cubicAt({ p0: leftP, c1: lowL, c2: lowR, p1: rightP }, i / MOUTH_SAMPLES));
    const upR = pt(x0 + width - hxR, y + pose.up * depth);
    const upL = pt(x0 + hxL, y + pose.up * depth);
    const upper = Array.from({ length: MOUTH_SAMPLES + 1 }, (_, i) => cubicAt({ p0: rightP, c1: upR, c2: upL, p1: leftP }, i / MOUTH_SAMPLES));
    return { lower, upper, open };
  };

  let lastKey = '';
  const applyLids = (eye: EyeParts, closure: number) => {
    const closed = closure >= 0.999;
    const shape = lidShape(closure);
    eye.white.setEnabled(!closed);
    eye.inner.setEnabled(!closed);
    for (const [mesh, which] of [
      [eye.upperLid, 'upper'],
      [eye.lowerLid, 'lower'],
    ] as const) {
      const polygon = closed ? null : lidPolygon(eye, closure, which);
      const data = lidVertexData(eye, polygon);
      mesh.setEnabled(polygon !== null);
      if (polygon) {
        mesh.updateVerticesData(VertexBuffer.PositionKind, data.positions);
        mesh.refreshBoundingInfo();
      }
    }
    // The lid line: along the upper edge, thickening as the eye shuts.
    if (shape) {
      const { rx, ry, rz } = eye;
      const y = shape.chord * ry;
      const onOutline = rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2));
      const reach = shape.reach === null ? onOutline : lerp(onOutline, shape.reach * rx, shape.lower);
      const ctrlY = y + shape.sag * ry;
      const path = Array.from({ length: LID_SAMPLES + 1 }, (_, i) => {
        const q = quadraticAt(pt(-reach, y), pt(0, ctrlY), pt(reach, y), i / LID_SAMPLES);
        return new Vector3(q.x * UNIT, -q.y * UNIT, (bulge(q.x, -q.y, rx, ry, rz) * (closed ? 0.2 : 1) + 2.4) * UNIT);
      });
      MeshBuilder.CreateTube(eye.lidLine.name, { path, radius: (shape.lineWidth * rx * 0.5) * UNIT, instance: eye.lidLine });
      eye.lidLine.setEnabled(true);
      eye.lidLine.visibility = shape.lineOpacity;
    } else {
      eye.lidLine.setEnabled(false);
    }
  };

  const applyInner = (eye: EyeParts, pose: FacePose, gaze: Gaze) => {
    const { rx, ry, rz, local } = eye;
    const k = layout.eyeK;
    const wide = clamp((1 - pose.irisScale) / 0.16, 0, 1);
    const s = lerp(1, 0.84, wide);
    // The eye node looks along the skin's normal with +Y up, so its +X is world +X: the viewer's left. Kit offsets are in the viewer's frame.
    const gx = VIEWER_X * gaze.x * EYES.gazeTravel * k;
    const gy = -gaze.y * EYES.gazeTravel * k;
    const place = (mesh: Mesh, dx: number, dy: number, w: number, h: number, size: number, depth: number) => {
      const x = VIEWER_X * dx * k * s + gx;
      const y = -(dy * k * s) + gy;
      const z = bulge(x, y, rx, ry, rz) + depth;
      mesh.position.set(x * UNIT, y * UNIT, z * UNIT);
      mesh.scaling.set(w * k * s * size * UNIT, h * k * s * size * UNIT, Math.max(rx * 0.12, 3) * UNIT);
    };
    place(eye.iris, local.iris.x, local.iris.y, EYES.iris.rx, EYES.iris.ry, m.pupilSize, 0.6);
    place(eye.pupil, local.pupil.x, local.pupil.y, EYES.pupil.rx, EYES.pupil.ry, m.pupilSize, 1.4);
    place(eye.highlight, local.highlight.x, local.highlight.y, EYES.highlight.rx, EYES.highlight.ry, 1, 2.2);
    place(eye.glint, local.glint.x, local.glint.y, EYES.glint.r, EYES.glint.r, 1, 2.4);
    eye.glint.visibility = EYES.glint.opacity;
  };

  const apply = (pose: FacePose, gaze: Gaze, sleeping: boolean, blink: number) => {
    const closure = sleeping ? 1 : Math.max(pose.lid, blink);
    rig.lastClosure = closure;
    applyLids(left, closure);
    applyLids(right, closure);
    applyInner(left, pose, gaze);
    applyInner(right, pose, gaze);
    const key = `${pose.mouth.width},${pose.mouth.dy},${pose.mouth.low},${pose.mouth.up},${pose.mouth.hx},${pose.browLeft.ctrl},${pose.browLeft.start},${pose.browLeft.end},${pose.browRight.ctrl},${pose.browRight.start},${pose.browRight.end}`;
    if (key === lastKey) return;
    lastKey = key;
    MeshBuilder.CreateTube(browLeft.name, { path: browPath(left, EYES.left, BROWS.left, pose.browLeft), instance: browLeft });
    MeshBuilder.CreateTube(browRight.name, { path: browPath(right, EYES.right, BROWS.right, pose.browRight), instance: browRight });
    const { lower, upper, open } = mouthCurves(pose.mouth);
    const lift = MOUTH.strokeWidth * 0.3;
    MeshBuilder.CreateTube(mouthLine.name, { path: lower.map((p) => onSkin(surface, p.x, p.y, lift)), instance: mouthLine });
    if (!open) {
      mouthUpper.setEnabled(false);
      mouthFill.setEnabled(false);
    } else {
      MeshBuilder.CreateTube(mouthUpper.name, { path: upper.map((p) => onSkin(surface, p.x, p.y, lift)), instance: mouthUpper });
      mouthUpper.setEnabled(true);
      const loop = [...lower, ...upper.slice(1)];
      let cx = 0;
      let cy = 0;
      for (const p of loop) {
        cx += p.x;
        cy += p.y;
      }
      const centre = onSkin(surface, cx / loop.length, cy / loop.length, lift * 0.9);
      const positions: number[] = [centre.x, centre.y, centre.z];
      for (const p of loop) {
        const q = onSkin(surface, p.x, p.y, lift * 0.9);
        positions.push(q.x, q.y, q.z);
      }
      while (positions.length < 3 * (MOUTH_SAMPLES * 2 + 2)) positions.push(centre.x, centre.y, centre.z);
      mouthFill.updateVerticesData(VertexBuffer.PositionKind, positions);
      mouthFill.refreshBoundingInfo();
      mouthFill.setEnabled(true);
    }
  };

  const rig: FaceRig = {
    root,
    eyes: { left, right },
    browLeft,
    browRight,
    mouthLine,
    mouthFill,
    layout,
    lastClosure: 0,
    apply,
    dispose: () => root.dispose(false, true),
  };
  return rig;
}

