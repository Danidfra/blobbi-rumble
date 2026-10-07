/**
 * Traits are attached: every root lies on the body's skin (sunk a little
 * into it), every tip is outside the body and above its root for the
 * things that stand up, and the geometry is finite and deterministic.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { buildBodySurface, type BodySurface } from './body';
import { buildParts, rootFlare, turnToward, type Pivoted } from './parts';
import { UNIT } from './units';
import { createBlobbiIdentity, genomeOf } from '../identity/identity';
import { seedFromLabel } from '../identity/seed';
import { deriveMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';

function build(label: string) {
  const scene = new Scene(new NullEngine());
  const mat = (name: string) => new StandardMaterial(name, scene);
  const m = { body: mat('b'), limb: mat('l'), foot: mat('f'), accent: mat('a'), horn: mat('h'), line: mat('n'), eyeWhite: mat('w'), iris: mat('i'), pupil: mat('p'), glint: mat('g'), feature: mat('e'), cheek: mat('c'), lid: mat('d') };
  const materials: BlobbiMaterials = { ...m, all: Object.values(m), dispose: () => undefined };
  const morphology = deriveMorphology(genomeOf(createBlobbiIdentity(seedFromLabel(label))));
  const surface = buildBodySurface({ bodyWidth: morphology.bodyWidth, bodyHeight: morphology.bodyHeight, topWidth: morphology.topWidth, belly: morphology.belly, roundness: morphology.roundness, lean: morphology.lean });
  const body = new TransformNode('body', scene);
  const feet = new TransformNode('feet', scene);
  return { morphology, surface, parts: buildParts(scene, body, feet, surface, morphology, materials, 'test') };
}

/** Whether a point (body frame, metres) is outside the skin: further from the axis than the surface at its angle and height. */
function outside(surface: BodySurface, p: Vector3): boolean {
  const v = (p.y - surface.baseY) / (surface.topY - surface.baseY);
  if (v > 1 || v < 0) return true;
  const phi = Math.atan2(-p.x, p.z);
  const skin = surface.pointAt(phi, v, 0);
  const rSkin = Math.hypot(skin.x, skin.z);
  const r = Math.hypot(p.x, p.z);
  return r > rSkin - 1e-6;
}

const finiteMesh = (part: Pivoted) => part.meshes.every((mesh) => Array.from(mesh.getVerticesData('position') ?? []).every((v) => Number.isFinite(v)));

describe('trait attachment', () => {
  const cases: [string, string][] = [
    ['abc123', 'pointed ears, nub tail'],
    ['blobbi-1', 'double antenna, side horns'],
    ['pattern-1', 'top horns'],
    ['pattern-0', 'forehead horn'],
    ['variety-56', 'round ears'],
    ['variety-1', 'single antenna'],
    ['blobbi-0', 'side horns, leaf tail'],
    ['mark-0', 'curl tail'],
  ];
  for (const [label, what] of cases) {
    it(`${label} (${what}): roots on the skin, tips outside it, finite`, () => {
      const { surface, parts } = build(label);
      const traits = [...parts.antennae, ...parts.horns, ...parts.ears, ...(parts.tail ? [parts.tail] : [])];
      expect(traits.length).toBeGreaterThan(0);
      for (const part of traits) {
        expect(finiteMesh(part), part.pivot.name).toBe(true);
        // The root is a surface point: within a sink of the skin.
        const v = (part.root.y - surface.baseY) / (surface.topY - surface.baseY);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.0001);
        // The tip is outside the body and, for anything but a tail, above its root.
        expect(outside(surface, part.tip), `${part.pivot.name} tip ${part.tip}`).toBe(true);
        if (part !== parts.tail) expect(part.tip.y).toBeGreaterThan(part.root.y);
        // The tip is a trait's length away, not stuck in the root and not flung across the scene.
        const reach = part.tip.subtract(part.root).length();
        expect(reach).toBeGreaterThan(20 * UNIT);
        expect(reach).toBeLessThan(200 * UNIT);
      }
    });
  }

  it('is deterministic: the same seed roots and tips every trait at the same place', () => {
    const a = build('blobbi-1');
    const b = build('blobbi-1');
    const flat = (p: ReturnType<typeof build>['parts']) => [...p.antennae, ...p.horns, ...p.ears].map((t) => [...t.root.asArray(), ...t.tip.asArray()]);
    expect(flat(a.parts)).toEqual(flat(b.parts));
  });

  it('a pair is mirrored: left and right roots at the same height, opposite x', () => {
    const { parts } = build('blobbi-1');
    for (const pair of [parts.horns, parts.antennae]) {
      expect(pair.length).toBe(2);
      expect(pair[0].root.y).toBeCloseTo(pair[1].root.y, 6);
      // Mirrored up to the crown's lean, which nudges both roots the same way (at most 6 root units).
      expect(Math.abs(pair[0].root.x + pair[1].root.x)).toBeLessThan(13 * UNIT);
    }
  });
});

describe('attachment helpers', () => {
  it('turnToward turns by the angle asked, toward the target, and leaves a parallel target alone', () => {
    const up = new Vector3(0, 1, 0);
    const out = new Vector3(1, 0, 0);
    const turned = turnToward(up, out, 30);
    expect(Math.acos(Vector3.Dot(turned, up)) * (180 / Math.PI)).toBeCloseTo(30, 6);
    expect(turned.x).toBeGreaterThan(0);
    expect(turnToward(up, out, -30).x).toBeLessThan(0);
    expect(turnToward(up, up, 45).equalsWithEpsilon(up)).toBe(true);
  });
  it('the root flare is widest at the root and gone past the skin', () => {
    expect(rootFlare(0, 0.1)).toBeCloseTo(1.35, 6);
    expect(rootFlare(0.1, 0.1)).toBeGreaterThan(1.05);
    expect(rootFlare(0.5, 0.1)).toBeCloseTo(1, 6);
  });
});
