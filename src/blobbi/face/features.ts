/**
 * THE FACE IN 3D: eyes, brows and mouth on the body's skin.
 *
 * The 2D face is a drawing on a flat silhouette; in 3D the same features sit
 * ON the body surface, each found with `surface.frontPoint` from the same
 * root-unit coordinates the kit's face builder uses (the eye line as a
 * fraction of the body's height, the eyes' spacing scaled by the gene, the
 * mouth's width in the plan's units). So the face lands where the drawing
 * has it, and a wide-set, high-eyed individual is wide-set and high-eyed in
 * both.
 *
 * Eyes are skin patches on a shallow dome (`eye.ts`); the brows and mouth
 * are tubes and a fan so they stay crisp and can animate; cheeks, freckles
 * and the blush are painted (`markings/painter.ts`).
 *
 * An expression arrives as a `FacePose` in the face's own units, as in 2D.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { BodySurface } from '../geometry/body';
import { cubicAt, lerp, pt, quadraticAt, type Pt } from '../geometry/math';
import { BROWS, EYES, MOUTH } from '../geometry/plan';
import { UNIT } from '../geometry/units';
import type { BlobbiMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';
import { createEye, type EyeRig } from './eye';
import { createStroke, type Placed, type Stroke } from './stroke';
import { type BrowPose, type FacePose, type MouthPose } from './expressions';

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

const AXIS = 408.65657;
const TOP = 136.79346;
const CANON_HEIGHT = 630.66717;
/** The front drawing's x, relative to the axis, in the viewer's frame. */
const vx = (x: number) => x - AXIS;

export function layoutFace(m: BlobbiMorphology, surface: BodySurface): FaceLayout {
  const frameY = (y: number) => surface.front.top + ((y - TOP) / CANON_HEIGHT) * surface.front.height;
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

const BROW_SAMPLES = 10;
const MOUTH_SAMPLES = 14;

/** A point of the front drawing (root units, absolute artwork x and y) on the skin, lifted off it, with the skin's normal. */
function onSkin(surface: BodySurface, x: number, y: number, lift: number): Placed {
  const p = surface.frontPoint(vx(x), y, lift * UNIT);
  return { position: new Vector3(p.x, p.y, p.z), normal: new Vector3(p.nx, p.ny, p.nz) };
}

/** How far the drawn strokes sit above the skin, root units: enough never to fight the skin, too little to float. */
const STROKE_LIFT = 1.2;

export interface FaceRig {
  root: TransformNode;
  eyes: { left: EyeRig; right: EyeRig };
  browLeft: Stroke;
  browRight: Stroke;
  /** The mouth's lower lip (the whole mouth when closed) and, when open, its upper lip and the dark inside. */
  mouthLine: Stroke;
  mouthUpper: Stroke;
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

  const eyeMaterials = { white: materials.eyeWhite, iris: materials.iris, pupil: materials.pupil, glint: materials.glint, skin: materials.body, line: materials.feature };
  // The viewer's-left eye sits a little lower (the authored face is a touch diagonal), plus this individual's tilt.
  const eyeSpec = (side: -1 | 1) => ({
    cx: side * layout.halfSpacing,
    cy: layout.eyeLineY - side * layout.tilt,
    rx: layout.eyeRx,
    ry: layout.eyeRy,
    k: layout.eyeK,
    local: side === -1 ? EYES.localLeft : EYES.localRight,
    pupilSize: m.pupilSize,
  });
  const left = createEye(scene, root, surface, eyeSpec(-1), eyeMaterials, `${name}-left-eye`);
  const right = createEye(scene, root, surface, eyeSpec(1), eyeMaterials, `${name}-right-eye`);

  const placer = (x: number, y: number, lift: number) => onSkin(surface, x, y, lift);
  const browLeft = createStroke(scene, root, `${name}-left-brow`, materials.line, BROW_SAMPLES + 1, placer);
  const browRight = createStroke(scene, root, `${name}-right-brow`, materials.line, BROW_SAMPLES + 1, placer);
  browLeft.mesh.visibility = BROWS.opacity;
  browRight.mesh.visibility = BROWS.opacity;
  const mouthLine = createStroke(scene, root, `${name}-mouth`, materials.feature, MOUTH_SAMPLES + 1, placer);
  const mouthUpper = createStroke(scene, root, `${name}-mouth-upper`, materials.feature, MOUTH_SAMPLES + 1, placer);
  const mouthFill = new Mesh(`${name}-mouth-fill`, scene);
  mouthFill.parent = root;
  mouthFill.material = materials.feature;
  mouthFill.isPickable = false;
  const FILL_VERTS = MOUTH_SAMPLES * 2 + 2;
  {
    const data = new VertexData();
    data.positions = new Array(3 * FILL_VERTS).fill(0);
    data.normals = new Array(3 * FILL_VERTS).fill(0);
    const indices: number[] = [];
    for (let i = 1; i <= MOUTH_SAMPLES * 2 + 1; i++) {
      const next = i === MOUTH_SAMPLES * 2 + 1 ? 1 : i + 1;
      indices.push(0, i, next, 0, next, i);
    }
    data.indices = indices;
    data.applyToMesh(mouthFill, true);
  }

  /** A brow keeps its authored gap above the top of its eye, whatever the eye's size, and rides the skin. */
  const browPath = (side: -1 | 1, canonEye: Pt, canonStart: Pt, pose: BrowPose): Pt[] => {
    const cx = AXIS + side * layout.halfSpacing;
    const cy = layout.eyeLineY - side * layout.tilt;
    const start = pt(cx + (canonStart.x - canonEye.x) * m.eyeSize, cy - layout.eyeRy - layout.browGap - m.browHeight);
    const width = BROWS.width * m.eyeSize;
    const a = pt(start.x, start.y + pose.start * width);
    const c = pt(start.x + 0.5 * width, start.y + pose.ctrl * width);
    const b = pt(start.x + width, start.y + pose.end * width);
    return Array.from({ length: BROW_SAMPLES + 1 }, (_, i) => quadraticAt(a, c, b, i / BROW_SAMPLES));
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
  const apply = (pose: FacePose, gaze: Gaze, sleeping: boolean, blink: number) => {
    const closure = sleeping ? 1 : Math.max(pose.lid, blink);
    rig.lastClosure = closure;
    const eyeState = { closure, irisScale: pose.irisScale, gaze };
    left.apply(eyeState);
    right.apply(eyeState);
    const key = `${pose.mouth.width},${pose.mouth.dy},${pose.mouth.low},${pose.mouth.up},${pose.mouth.hx},${pose.browLeft.ctrl},${pose.browLeft.start},${pose.browLeft.end},${pose.browRight.ctrl},${pose.browRight.start},${pose.browRight.end}`;
    if (key === lastKey) return;
    lastKey = key;
    browLeft.update(browPath(-1, EYES.left, BROWS.left, pose.browLeft), BROWS.strokeWidth, STROKE_LIFT);
    browRight.update(browPath(1, EYES.right, BROWS.right, pose.browRight), BROWS.strokeWidth, STROKE_LIFT);
    const { lower, upper, open } = mouthCurves(pose.mouth);
    mouthLine.update(lower, MOUTH.strokeWidth, STROKE_LIFT);
    if (!open) {
      mouthUpper.mesh.setEnabled(false);
      mouthFill.setEnabled(false);
    } else {
      mouthUpper.update(upper, MOUTH.strokeWidth, STROKE_LIFT);
      mouthUpper.mesh.setEnabled(true);
      // The dark inside: a fan from the mouth's centre over the loop of both lips, on the skin under the strokes.
      const loop = [...lower, ...upper.slice(1)];
      let cx = 0;
      let cy = 0;
      for (const p of loop) {
        cx += p.x;
        cy += p.y;
      }
      const centre = onSkin(surface, cx / loop.length, cy / loop.length, STROKE_LIFT * 0.7);
      const positions: number[] = [centre.position.x, centre.position.y, centre.position.z];
      const normals: number[] = [centre.normal.x, centre.normal.y, centre.normal.z];
      for (const p of loop) {
        const q = onSkin(surface, p.x, p.y, STROKE_LIFT * 0.7);
        positions.push(q.position.x, q.position.y, q.position.z);
        normals.push(q.normal.x, q.normal.y, q.normal.z);
      }
      while (positions.length < 3 * FILL_VERTS) {
        positions.push(centre.position.x, centre.position.y, centre.position.z);
        normals.push(centre.normal.x, centre.normal.y, centre.normal.z);
      }
      mouthFill.updateVerticesData(VertexBuffer.PositionKind, positions);
      mouthFill.updateVerticesData(VertexBuffer.NormalKind, normals);
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
    mouthUpper,
    mouthFill,
    layout,
    lastClosure: 0,
    apply,
    dispose: () => root.dispose(false, true),
  };
  return rig;
}
