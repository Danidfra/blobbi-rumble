/**
 * ONE EYE, AS A PATCH OF THE BODY'S SKIN.
 *
 * The 2D eye is a drawing on the face: a white oval, an iris and a pupil
 * set a little low and inward, two highlights on the lit side, and lids that
 * close over it. The 3D eye keeps that construction exactly, and answers
 * "where is this in space?" with one rule for every part:
 *
 *   a point (ex, ey) of the eye's own drawing, in root units with ey up,
 *   lies on the body's skin under the front drawing at (cx + ex, cy − ey),
 *   lifted along the skin's normal by DOME(ex, ey) + its layer's offset.
 *
 * DOME is a shallow elliptical bulge that is zero at the white's rim, so the
 * white rises softly out of the face and meets it with no step or gap. The
 * iris, pupil, highlights and lids are laid on that same dome a hair above
 * one another, so they conform to it, never float, never cut through it and
 * stay inside the white from any angle. There is no eye "node" to orient:
 * the eye faces wherever the skin faces, which is what a drawn eye does,
 * and from the front it is the drawing, to the unit.
 *
 * Gaze moves the inner parts across the drawing (the kit's travel), lids are
 * the kit's own lid shapes applied by sliding the vertices of a full disc up
 * to the edge curve, so a closing lid covers the iris progressively, as a
 * lid does. Every patch has fixed topology; only positions are updated.
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import type { Material } from '@babylonjs/core/Materials/material';
import type { BodySurface } from '../geometry/body';
import { clamp, lerp, pt, quadraticAt, TAU, type Pt } from '../geometry/math';
import { EYES } from '../geometry/plan';
import { UNIT } from '../geometry/units';
import { lidShape } from './expressions';
import { createStroke, type Placed } from './stroke';

export interface EyeSpec {
  /** The eye's centre in the front drawing: viewer x (root units, right positive) and artwork y (down). */
  cx: number;
  cy: number;
  /** The white's radii, root units. */
  rx: number;
  ry: number;
  /** The plan's eye scale (EYE_K times the individual's eye size). */
  k: number;
  /** The inner eye's authored offsets (kit units, y down), for this side. */
  local: { iris: Pt; pupil: Pt; highlight: Pt; glint: Pt };
  pupilSize: number;
}

export interface EyeState {
  /** 0 open, 0.5 the kit's half lid, 1 shut. */
  closure: number;
  /** The kit's iris scale (0.84 is "wide"). */
  irisScale: number;
  /** Where the eye looks, -1..1 per axis; x = 1 is the viewer's right, y = 1 is down. */
  gaze: { x: number; y: number };
}

export interface EyeMaterials {
  white: Material;
  iris: Material;
  pupil: Material;
  glint: Material;
  /** The body's own skin material: the lids are skin, textured as the body is. */
  skin: Material;
  line: Material;
}

export interface EyeRig {
  root: TransformNode;
  meshes: Mesh[];
  spec: EyeSpec;
  /** The dome's height above the skin at a point of the eye's drawing, root units. */
  dome(ex: number, ey: number): number;
  /** Where a point of the eye's drawing lies, lifted by `lift` root units above the dome. */
  place(ex: number, ey: number, lift: number): Vector3;
  apply(state: EyeState): void;
  /** The state last applied. */
  state: EyeState;
}

/** The dome's height at the white's centre, as a fraction of the white's half-width. */
export const EYE_DOME = 0.2;
/** Layer offsets above the dome, root units: each part sits a hair above the one under it. */
export const EYE_LAYERS = { white: 0.4, iris: 1.0, pupil: 1.6, highlight: 2.2, glint: 2.5, lowerLid: 2.9, lid: 3.2, line: 3.8 } as const;

const RINGS = 5;
const SEGMENTS = 36;

/** A disc's fixed topology: a centre, then `RINGS` rings of `SEGMENTS` vertices. */
function discIndices(): number[] {
  const indices: number[] = [];
  const at = (ring: number, seg: number) => (ring === 0 ? 0 : 1 + (ring - 1) * SEGMENTS + (seg % SEGMENTS));
  for (let s = 0; s < SEGMENTS; s++) indices.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < RINGS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = at(r, s);
      const b = at(r, s + 1);
      const c = at(r + 1, s);
      const d = at(r + 1, s + 1);
      indices.push(a, d, c, a, b, d);
    }
  }
  return indices;
}
const DISC_INDICES = discIndices();
/** The same disc wound the other way round, for a skin that faces the other way. */
const DISC_INDICES_REVERSED = DISC_INDICES.map((_, i, all) => (i % 3 === 1 ? all[i + 1] : i % 3 === 2 ? all[i - 1] : all[i]));
const DISC_VERTS = 1 + RINGS * SEGMENTS;

/** The (t, angle) of each disc vertex: t is the ring's radius fraction, 0..1. */
const DISC_PARAMS: { t: number; a: number }[] = [{ t: 0, a: 0 }];
for (let r = 1; r <= RINGS; r++) for (let s = 0; s < SEGMENTS; s++) DISC_PARAMS.push({ t: r / RINGS, a: (s / SEGMENTS) * TAU });

function discMesh(scene: Scene, name: string, parent: TransformNode, material: Material, indices: number[]): Mesh {
  const mesh = new Mesh(name, scene);
  mesh.parent = parent;
  mesh.material = material;
  mesh.isPickable = false;
  const data = new VertexData();
  data.positions = new Array(3 * DISC_VERTS).fill(0);
  data.normals = new Array(3 * DISC_VERTS).fill(0);
  data.uvs = new Array(2 * DISC_VERTS).fill(0);
  data.indices = indices;
  data.applyToMesh(mesh, true);
  return mesh;
}

const LINE_SAMPLES = 17;

export function createEye(scene: Scene, parent: TransformNode, surface: BodySurface, spec: EyeSpec, materials: EyeMaterials, name: string): EyeRig {
  const root = new TransformNode(name, scene);
  root.parent = parent;
  const { rx, ry } = spec;
  const domeHeight = EYE_DOME * rx;

  const dome = (ex: number, ey: number) => domeHeight * Math.sqrt(Math.max(0, 1 - (ex / rx) ** 2 - (ey / ry) ** 2));
  const place = (ex: number, ey: number, lift: number): Vector3 => {
    const p = surface.frontPoint(spec.cx + ex, spec.cy - ey, (dome(ex, ey) + lift) * UNIT);
    return new Vector3(p.x, p.y, p.z);
  };
  /** The outward normal of the skin at a point of the drawing (for orienting the patches' normals). */
  const skinNormal = (ex: number, ey: number) => {
    const p = surface.frontPoint(spec.cx + ex, spec.cy - ey, 0);
    return new Vector3(p.nx, p.ny, p.nz);
  };
  /** A point of the eye's drawing placed on the dome, with the skin's normal, for strokes. */
  const placed = (ex: number, ey: number, lift: number): Placed => ({ position: place(ex, ey, lift), normal: skinNormal(ex, ey) });

  // Which way round the disc's triangles must go to face out of THIS skin: decided once, from the white's own
  // centre triangle laid on the dome, so the patches are front faces whatever the body's shape.
  const windingOut = (() => {
    const a = place(0, 0, 0);
    const b = place(rx * 0.2, 0, 0);
    const c = place(rx * 0.2 * Math.cos(TAU / SEGMENTS), ry * 0.2 * Math.sin(TAU / SEGMENTS), 0);
    // The first triangle of DISC_INDICES is (centre, segment 1, segment 0): its winding normal as Babylon computes it.
    const computed = new Array<number>(9);
    VertexData.ComputeNormals([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], [0, 2, 1], computed);
    const n = skinNormal(0, 0);
    return computed[0] * n.x + computed[1] * n.y + computed[2] * n.z >= 0;
  })();
  const indices = windingOut ? DISC_INDICES : DISC_INDICES_REVERSED;

  const white = discMesh(scene, `${name}-white`, root, materials.white, indices);
  const iris = discMesh(scene, `${name}-iris`, root, materials.iris, indices);
  const pupil = discMesh(scene, `${name}-pupil`, root, materials.pupil, indices);
  const highlight = discMesh(scene, `${name}-highlight`, root, materials.glint, indices);
  const glint = discMesh(scene, `${name}-glint`, root, materials.glint, indices);
  const upperLid = discMesh(scene, `${name}-upper-lid`, root, materials.skin, indices);
  const lowerLid = discMesh(scene, `${name}-lower-lid`, root, materials.skin, indices);
  const lidLine = createStroke(scene, root, `${name}-lid-line`, materials.line, LINE_SAMPLES, placed);
  const meshes = [white, iris, pupil, highlight, glint, upperLid, lowerLid, lidLine.mesh];

  const positions = new Float32Array(3 * DISC_VERTS);
  const normals = new Array<number>(3 * DISC_VERTS);
  const uvs = new Float32Array(2 * DISC_VERTS);
  /**
   * Lay a disc on the dome. `shape` gives each vertex its place in the eye's
   * drawing from its ring fraction and angle; `lift` is the layer's offset.
   */
  const layDisc = (mesh: Mesh, shape: (t: number, a: number) => Pt, lift: number, skin = false) => {
    for (let i = 0; i < DISC_VERTS; i++) {
      const { t, a } = DISC_PARAMS[i];
      const q = shape(t, a);
      const p = place(q.x, q.y, lift);
      positions[3 * i] = p.x;
      positions[3 * i + 1] = p.y;
      positions[3 * i + 2] = p.z;
      if (skin) {
        // A lid is skin: it wears the body's texture at the very place it covers.
        const uv = surface.uvOfFront(spec.cx + q.x, spec.cy - q.y);
        uvs[2 * i] = uv.u;
        uvs[2 * i + 1] = uv.v;
      }
    }
    VertexData.ComputeNormals(positions, indices, normals);
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
    if (skin) mesh.updateVerticesData(VertexBuffer.UVKind, uvs);
    mesh.refreshBoundingInfo();
  };

  const ellipse = (ox: number, oy: number, ax: number, ay: number) => (t: number, a: number) => pt(ox + t * ax * Math.cos(a), oy + t * ay * Math.sin(a));

  const state: EyeState = { closure: 0, irisScale: 1, gaze: { x: 0, y: 0 } };
  let lastKey = '';

  const apply = (next: EyeState) => {
    state.closure = clamp(next.closure, 0, 1);
    state.irisScale = next.irisScale;
    state.gaze = { x: clamp(next.gaze.x, -1, 1), y: clamp(next.gaze.y, -1, 1) };
    const key = `${state.closure.toFixed(4)}|${state.irisScale.toFixed(4)}|${state.gaze.x.toFixed(4)}|${state.gaze.y.toFixed(4)}`;
    if (key === lastKey) return;
    lastKey = key;

    const { k, local, pupilSize } = spec;
    // "Wide" shrinks the inner eye about the white's centre, as the kit does.
    const wide = clamp((1 - state.irisScale) / 0.16, 0, 1);
    const s = lerp(1, 0.84, wide);
    const gx = state.gaze.x * EYES.gazeTravel * k;
    const gy = -state.gaze.y * EYES.gazeTravel * k;
    // Kit offsets have y down; the eye's drawing here has y up.
    const inner = (o: Pt, w: number, h: number, size = 1) => ellipse(o.x * k * s + gx, -o.y * k * s + gy, w * k * s * size, h * k * s * size);

    const closed = state.closure >= 0.999;
    white.setEnabled(!closed);
    iris.setEnabled(!closed);
    pupil.setEnabled(!closed);
    highlight.setEnabled(!closed);
    glint.setEnabled(!closed);
    if (!closed) {
      layDisc(white, ellipse(0, 0, rx, ry), EYE_LAYERS.white);
      layDisc(iris, inner(local.iris, EYES.iris.rx, EYES.iris.ry, pupilSize), EYE_LAYERS.iris);
      layDisc(pupil, inner(local.pupil, EYES.pupil.rx, EYES.pupil.ry, pupilSize), EYE_LAYERS.pupil);
      layDisc(highlight, inner(local.highlight, EYES.highlight.rx, EYES.highlight.ry), EYE_LAYERS.highlight);
      layDisc(glint, inner(local.glint, EYES.glint.r, EYES.glint.r), EYE_LAYERS.glint);
      glint.visibility = EYES.glint.opacity;
    }

    // The lids: the kit's lid shapes, with y turned up.
    const shape = lidShape(state.closure);
    if (!shape) {
      upperLid.setEnabled(false);
      lowerLid.setEnabled(false);
      lidLine.mesh.setEnabled(false);
      return;
    }
    const chordUp = -shape.chord * ry;
    const onOutline = rx * Math.sqrt(Math.max(0, 1 - shape.chord ** 2));
    const reach = shape.reach === null ? onOutline : lerp(onOutline, shape.reach * rx, shape.lower);
    const sagUp = -(shape.chord + shape.sag) * ry;
    const upperEdge = (ex: number) => (Math.abs(ex) >= reach ? chordUp : quadraticAt(pt(-reach, chordUp), pt(0, sagUp), pt(reach, chordUp), (ex + reach) / (2 * reach)).y);
    // The lid discs are a little larger than the white, so their rim covers its edge.
    const rim = 1.04;
    layDisc(
      upperLid,
      (t, a) => {
        const ex = t * rx * rim * Math.cos(a);
        const ey = t * ry * rim * Math.sin(a);
        return pt(ex, Math.max(ey, upperEdge(ex)));
      },
      EYE_LAYERS.lid,
      true,
    );
    upperLid.setEnabled(true);
    if (shape.lower > 0) {
      // The lower lid rises to meet the upper one and tucks a little under it, so no sliver of white shows between them.
      const tuck = 0.1 * ry * shape.lower;
      const lowUp = -lerp(1.15 * ry, shape.chord * ry, shape.lower) + tuck;
      const lowSagUp = lowUp - lerp(0, shape.sag * ry, shape.lower);
      const lowerEdge = (ex: number) => (Math.abs(ex) >= reach ? lowUp : quadraticAt(pt(-reach, lowUp), pt(0, lowSagUp), pt(reach, lowUp), (ex + reach) / (2 * reach)).y);
      layDisc(
        lowerLid,
        (t, a) => {
          const ex = t * rx * rim * Math.cos(a);
          const ey = t * ry * rim * Math.sin(a);
          return pt(ex, Math.min(ey, lowerEdge(ex)));
        },
        EYE_LAYERS.lowerLid,
        true,
      );
      lowerLid.setEnabled(true);
    } else lowerLid.setEnabled(false);

    // The lid's edge, drawn as the kit draws it: a stroke that thickens as the eye shuts.
    const path = Array.from({ length: LINE_SAMPLES }, (_, i) => {
      const ex = lerp(-reach, reach, i / (LINE_SAMPLES - 1));
      return pt(ex, upperEdge(ex));
    });
    lidLine.update(path, shape.lineWidth * rx, EYE_LAYERS.line);
    lidLine.mesh.setEnabled(true);
    lidLine.mesh.visibility = shape.lineOpacity;
  };

  const rig: EyeRig = { root, meshes, spec, dome, place, apply, state };
  apply(state);
  return rig;
}

export { DISC_VERTS as EYE_DISC_VERTICES };
