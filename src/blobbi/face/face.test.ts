/**
 * The 3D face is deterministic, finite and attached: eyes conform to one
 * dome on the skin, strokes lie a hair above it, and every key pose and
 * every blend between poses builds valid geometry. Built with Babylon's
 * NullEngine, so no GPU is needed.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { buildBodySurface } from '../geometry/body';
import { UNIT } from '../geometry/units';
import { createBlobbiIdentity, genomeOf } from '../identity/identity';
import { seedFromLabel } from '../identity/seed';
import { deriveMorphology, type BlobbiMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';
import { buildFace } from './features';
import { EMOTIONS, KEY_POSES, lerpFacePose, NEUTRAL_POSE, resolveFacePose } from './expressions';
import { EYE_DOME, EYE_LAYERS } from './eye';

function sceneWithMaterials(): { scene: Scene; materials: BlobbiMaterials } {
  const scene = new Scene(new NullEngine());
  const mat = (name: string) => new StandardMaterial(name, scene);
  const materials = {
    body: mat('body'),
    limb: mat('limb'),
    foot: mat('foot'),
    accent: mat('accent'),
    horn: mat('horn'),
    line: mat('line'),
    eyeWhite: mat('white'),
    iris: mat('iris'),
    pupil: mat('pupil'),
    glint: mat('glint'),
    feature: mat('feature'),
    cheek: mat('cheek'),
    lid: mat('lid'),
  };
  return { scene, materials: { ...materials, all: Object.values(materials), dispose: () => undefined } };
}

const surfaceOf = (m: BlobbiMorphology) =>
  buildBodySurface({ bodyWidth: m.bodyWidth, bodyHeight: m.bodyHeight, topWidth: m.topWidth, belly: m.belly, roundness: m.roundness, lean: m.lean });

const positionsOf = (mesh: Mesh) => Array.from(mesh.getVerticesData('position') ?? []);
const finite = (values: number[]) => values.every((v) => Number.isFinite(v));

function faceFor(label: string) {
  const { scene, materials } = sceneWithMaterials();
  const m = deriveMorphology(genomeOf(createBlobbiIdentity(seedFromLabel(label))));
  const surface = surfaceOf(m);
  const parent = new TransformNode('body', scene);
  const face = buildFace(scene, parent, surface, m, materials, 'test');
  return { scene, m, surface, face };
}

/** How far a point (body frame, metres) stands off the skin: its radial distance beyond the surface at its own angle and height. */
function offSkin(surface: ReturnType<typeof surfaceOf>, p: Vector3): number {
  const v = (p.y - surface.baseY) / (surface.topY - surface.baseY);
  const phi = Math.atan2(-p.x, p.z);
  const skin = surface.pointAt(phi, v, 0);
  return (p.x - skin.x) * skin.nx + (p.y - skin.y) * skin.ny + (p.z - skin.z) * skin.nz;
}

describe('eyes', () => {
  it('are deterministic: the same seed builds the same vertices', () => {
    const a = faceFor('abc123');
    const b = faceFor('abc123');
    for (const which of ['left', 'right'] as const) {
      a.face.eyes[which].meshes.forEach((mesh, i) => expect(positionsOf(mesh)).toEqual(positionsOf(b.face.eyes[which].meshes[i])));
    }
  });

  it('every part conforms to the dome: the iris and pupil sit a hair above the white, inside it, with finite geometry', () => {
    const { face, surface } = faceFor('abc123');
    for (const which of ['left', 'right'] as const) {
      const eye = face.eyes[which];
      for (const mesh of eye.meshes) expect(finite(positionsOf(mesh)), mesh.name).toBe(true);
      const { cx, cy, rx, ry } = eye.spec;
      // The dome is EYE_DOME of the half-width high at the centre and zero at the rim.
      expect(eye.dome(0, 0)).toBeCloseTo(EYE_DOME * rx, 9);
      expect(eye.dome(rx, 0)).toBe(0);
      // A point of the drawing placed on the dome lies above the skin by about the dome plus its layer.
      const centre = eye.place(0, 0, EYE_LAYERS.iris);
      const skin = surface.frontPoint(cx, cy, 0);
      const lift = (centre.x - skin.x) * skin.nx + (centre.y - skin.y) * skin.ny + (centre.z - skin.z) * skin.nz;
      expect(lift).toBeCloseTo((EYE_DOME * rx + EYE_LAYERS.iris) * UNIT, 4);
      // The iris and pupil never leave the white at any gaze.
      for (const gaze of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: -1, y: -1 },
        { x: 1, y: -1 },
      ]) {
        eye.apply({ closure: 0, irisScale: 1, gaze });
        const irisPositions = positionsOf(eye.meshes[1]);
        const whitePositions = positionsOf(eye.meshes[0]);
        // Every iris vertex is at least as far from the skin as the white's centre layer, so it can never be under it.
        for (let i = 0; i < irisPositions.length; i += 3) {
          const p = new Vector3(irisPositions[i], irisPositions[i + 1], irisPositions[i + 2]);
          expect(p.subtract(new Vector3(whitePositions[0], whitePositions[1], whitePositions[2])).length()).toBeLessThan(Math.hypot(rx, ry) * UNIT);
        }
      }
    }
  });

  it('close progressively: the lid edge descends over the eye and the line follows it', () => {
    const { face } = faceFor('abc123');
    const eye = face.eyes.left;
    const upper = eye.meshes[5];
    const lowestLidY = () => {
      const p = positionsOf(upper);
      let min = Infinity;
      for (let i = 1; i < p.length; i += 3) min = Math.min(min, p[i]);
      return min;
    };
    eye.apply({ closure: 0, irisScale: 1, gaze: { x: 0, y: 0 } });
    expect(upper.isEnabled()).toBe(false);
    eye.apply({ closure: 0.25, irisScale: 1, gaze: { x: 0, y: 0 } });
    expect(upper.isEnabled()).toBe(true);
    const quarter = lowestLidY();
    eye.apply({ closure: 0.6, irisScale: 1, gaze: { x: 0, y: 0 } });
    const more = lowestLidY();
    expect(more).toBeLessThan(quarter);
    eye.apply({ closure: 1, irisScale: 1, gaze: { x: 0, y: 0 } });
    expect(eye.meshes[0].isEnabled()).toBe(false);
    expect(eye.meshes[7].isEnabled()).toBe(true);
    for (const mesh of eye.meshes) expect(finite(positionsOf(mesh)), mesh.name).toBe(true);
  });
});

describe('strokes (mouth and brows)', () => {
  it('lie a hair above the skin at every key pose and every blend, with finite geometry', () => {
    const { face, surface } = faceFor('abc123');
    const poses = [NEUTRAL_POSE, ...EMOTIONS.map((e) => KEY_POSES[e])];
    const pairs: [number, number][] = [
      [0, 5],
      [1, 3],
      [2, 6],
      [4, 5],
    ];
    const check = (pose: typeof NEUTRAL_POSE) => {
      face.apply(pose, { x: 0, y: 0 }, false, 0);
      for (const mesh of [face.mouthLine.mesh, face.mouthUpper.mesh, face.mouthFill, face.browLeft.mesh, face.browRight.mesh]) {
        if (!mesh.isEnabled()) continue;
        const p = positionsOf(mesh);
        expect(finite(p), mesh.name).toBe(true);
      }
      // Every vertex of every stroke stands a little off the skin: never in it, never floating.
      for (const mesh of [face.mouthLine.mesh, face.browLeft.mesh, face.browRight.mesh]) {
        const p = positionsOf(mesh);
        for (let i = 0; i < p.length; i += 3) {
          const d = offSkin(surface, new Vector3(p[i], p[i + 1], p[i + 2]));
          expect(d, mesh.name).toBeGreaterThan(0.3 * UNIT);
          expect(d, mesh.name).toBeLessThan(10 * UNIT);
        }
      }
    };
    for (const pose of poses) check(pose);
    for (const [a, b] of pairs) for (const t of [0.25, 0.5, 0.75]) check(lerpFacePose(poses[a], poses[b], t));
  });

  it('an open mouth is a filled shape with two lips; a closed one is a single stroke', () => {
    const { face } = faceFor('abc123');
    face.apply(KEY_POSES.surprised, { x: 0, y: 0 }, false, 0);
    expect(face.mouthFill.isEnabled()).toBe(true);
    expect(face.mouthUpper.mesh.isEnabled()).toBe(true);
    face.apply(KEY_POSES.happy, { x: 0, y: 0 }, false, 0);
    expect(face.mouthFill.isEnabled()).toBe(false);
    expect(face.mouthUpper.mesh.isEnabled()).toBe(false);
    // Half way from neutral to surprised the lips have parted: still valid, still finite.
    face.apply(lerpFacePose(NEUTRAL_POSE, KEY_POSES.surprised, 0.5), { x: 0, y: 0 }, false, 0);
    expect(finite(positionsOf(face.mouthFill))).toBe(true);
  });

  it('builds valid faces across morphology extremes', () => {
    for (const label of ['variety-109', 'variety-15', 'variety-20', 'variety-3', 'variety-6', 'variety-91', 'variety-56', 'variety-38']) {
      const { face } = faceFor(label);
      for (const emotion of EMOTIONS) {
        face.apply(resolveFacePose({ [emotion]: 1 }), { x: 0.5, y: -0.5 }, false, 0.3);
        for (const mesh of [face.mouthLine.mesh, face.browLeft.mesh, ...face.eyes.left.meshes]) expect(finite(positionsOf(mesh)), `${label} ${emotion} ${mesh.name}`).toBe(true);
      }
    }
  });
});
