/**
 * The swept traits are attached as an AREA and curve as the kit says:
 * every root vertex is inside the skin, every wall column crosses the skin
 * exactly once, the horn's centre line bends by the curl, the rings follow
 * it in a frame that does not twist, and all of it is finite and the same
 * for the same seed, on bodies of every shape.
 */
import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { buildBodySurface, type BodySurface } from './body';
import { buildParts, type Pivoted } from './parts';
import { buildSweep } from './sweep';
import { UNIT } from './units';
import { createBlobbiIdentity, genomeOf, resolveBlobbiIdentity, type BlobbiIdentity } from '../identity/identity';
import { generateGenome, type BlobbiGenome } from '../identity/genome';
import { seedFromLabel } from '../identity/seed';
import { deriveMorphology } from '../morphology/morphology';
import type { BlobbiMaterials } from '../materials/materials';

function build(genome: BlobbiGenome) {
  const scene = new Scene(new NullEngine());
  const mat = (name: string) => new StandardMaterial(name, scene);
  const m = { body: mat('b'), limb: mat('l'), foot: mat('f'), accent: mat('a'), horn: mat('h'), line: mat('n'), eyeWhite: mat('w'), iris: mat('i'), pupil: mat('p'), glint: mat('g'), feature: mat('e'), cheek: mat('c'), lid: mat('d') };
  const materials: BlobbiMaterials = { ...m, all: Object.values(m), dispose: () => undefined };
  const morphology = deriveMorphology(genome);
  const surface = buildBodySurface({ bodyWidth: morphology.bodyWidth, bodyHeight: morphology.bodyHeight, topWidth: morphology.topWidth, belly: morphology.belly, roundness: morphology.roundness, lean: morphology.lean });
  const parts = buildParts(scene, new TransformNode('body', scene), new TransformNode('feet', scene), surface, morphology, materials, 't');
  return { surface, morphology, parts };
}

const withTraits = (label: string, traits: Partial<BlobbiIdentity['traits']>) => genomeOf(resolveBlobbiIdentity({ seed: seedFromLabel(label), traits }).identity);
const grownParts = (p: ReturnType<typeof build>['parts']): Pivoted[] => [...p.antennae, ...p.horns, ...p.ears].filter((t) => t.sweeps && t.sweeps.length > 0);

/** The depth of a pivot-frame vertex outside the skin, along the mount's normal (negative inside). */
function depthOf(surface: BodySurface, part: Pivoted, v: Vector3, normal: Vector3): number {
  const hit = surface.skinAlong(part.root.add(v), normal, 0.3);
  if (hit) return hit.depth;
  return surface.isOutside(part.root.add(v)) ? 1 : -1;
}
function normalAt(surface: BodySurface, part: Pivoted): Vector3 {
  // The mount's normal: the skin's normal at the root.
  const hit = surface.skinAlong(part.root, new Vector3(0, 1, 0), 0.05) ?? surface.skinAlong(part.root, new Vector3(part.root.x, 0, part.root.z).normalize(), 0.05);
  return hit ? new Vector3(hit.point.nx, hit.point.ny, hit.point.nz) : new Vector3(part.root.x, 0.3, part.root.z).normalize();
}

const BODIES: [string, string][] = [
  ['variety-109', 'wide'],
  ['variety-15', 'narrow'],
  ['variety-20', 'tall'],
  ['variety-3', 'short'],
  ['variety-0', 'round'],
  ['variety-6', 'pointy'],
];
const TRAIT_SETS: [string, Partial<BlobbiIdentity['traits']>][] = [
  ['forehead horn', { horns: 'forehead', ears: 'none', antenna: 'none' }],
  ['top horns', { horns: 'top', ears: 'none', antenna: 'none' }],
  ['side horns', { horns: 'side', ears: 'none', antenna: 'none' }],
  ['pointed ears', { horns: 'none', ears: 'pointed', antenna: 'none' }],
  ['round ears', { horns: 'none', ears: 'round', antenna: 'none' }],
  ['double antenna', { horns: 'none', ears: 'none', antenna: 'double' }],
];

describe('root attachment is an area', () => {
  for (const [body, shape] of BODIES) {
    for (const [what, traits] of TRAIT_SETS) {
      it(`${what} on a ${shape} body (${body}): every root vertex inside, every wall column crosses the skin once`, () => {
        const { surface, parts } = build(withTraits(body, traits));
        const grown = grownParts(parts);
        expect(grown.length).toBeGreaterThan(0);
        for (const part of grown) {
          const n = normalAt(surface, part);
          for (const sweep of part.sweeps!) {
            const rings = sweep.rings;
            const segments = rings[0].length;
            for (let j = 0; j < segments; j++) {
              // Inside at the root, by at least a third of the sink.
              const rootDepth = depthOf(surface, part, rings[0][j], n);
              expect(rootDepth, `${part.pivot.name} root vertex ${j}`).toBeLessThan(-2 * UNIT);
              // Once out, never back in: one crossing per column.
              let out = false;
              let crossings = 0;
              for (let i = 0; i < rings.length; i++) {
                const d = depthOf(surface, part, rings[i][j], n);
                const isOut = d > 0;
                if (isOut !== out) {
                  crossings++;
                  out = isOut;
                }
              }
              expect(crossings, `${part.pivot.name} column ${j}`).toBe(1);
            }
            for (const ring of rings) for (const v of ring) expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
          }
        }
      });
    }
  }
});

describe('the horn curve', () => {
  const genome = withTraits('blobbi-1', { horns: 'side' });
  it('bends by the curl: the tip tangent is turned from the root tangent by the morphology\'s curvature', () => {
    const { parts, morphology } = build(genome);
    const expected = Math.abs(morphology.horns!.curvature) * Math.min(1, Math.max(0.3, morphology.horns!.length / (1.25 * morphology.horns!.width)));
    expect(expected).toBeGreaterThan(3);
    for (const horn of parts.horns) {
      const t = horn.sweeps![0].tangents;
      const turned = (Math.acos(Math.min(1, Vector3.Dot(t[0], t[t.length - 1]))) * 180) / Math.PI;
      // Sampled tangents (central differences) read a little under the analytic turn.
      expect(Math.abs(turned - expected)).toBeLessThan(2.5);
      expect(turned).toBeGreaterThan(expected * 0.8);
    }
  });
  it('a horn with no curl is straight', () => {
    const base = generateGenome(seedFromLabel('blobbi-1'));
    const straight: BlobbiGenome = { ...base, traits: { ...base.traits, horns: { ...base.traits.horns, kind: 'side', curvature: 0 } } };
    const { parts } = build(straight);
    for (const horn of parts.horns) {
      const t = horn.sweeps![0].tangents;
      expect((Math.acos(Math.min(1, Vector3.Dot(t[0], t[t.length - 1]))) * 180) / Math.PI).toBeLessThan(0.5);
    }
  });
  it('the rings follow the centre line in its plane, and the frame does not twist', () => {
    const { parts } = build(genome);
    for (const horn of parts.horns) {
      const sweep = horn.sweeps![0];
      for (let i = sweep.freeFrom; i < sweep.rings.length; i++) {
        const ring = sweep.rings[i];
        const centroid = ring.reduce((a, p) => a.add(p), Vector3.Zero()).scale(1 / ring.length);
        const radius = ring[0].subtract(centroid).length();
        expect(centroid.subtract(sweep.centres[i]).length()).toBeLessThan(radius * 0.05 + 1e-6);
        for (const p of ring) expect(Math.abs(Vector3.Dot(p.subtract(centroid), sweep.tangents[i]))).toBeLessThan(radius * 0.05 + 1e-6);
        if (i > sweep.freeFrom) {
          // The first vertex of consecutive rings stays on the same side: no roll between rings.
          const a = sweep.rings[i - 1][0].subtract(sweep.centres[i - 1]).normalize();
          const b = ring[0].subtract(centroid).normalize();
          expect(Vector3.Dot(a, b)).toBeGreaterThan(0.95);
        }
      }
    }
  });
});

describe('sweeps are deterministic and finite', () => {
  it('the same seed builds the same vertices, bit for bit', () => {
    const a = build(genomeOf(createBlobbiIdentity(seedFromLabel('blobbi-1'))));
    const b = build(genomeOf(createBlobbiIdentity(seedFromLabel('blobbi-1'))));
    const flat = (p: Pivoted[]) => p.flatMap((t) => t.sweeps!.flatMap((s) => s.vertexData.positions as number[]));
    expect(flat(grownParts(a.parts))).toEqual(flat(grownParts(b.parts)));
  });
  it('a bare sweep with no conform is a clean tube: rings centred on the path, radii as asked', () => {
    const path = Array.from({ length: 11 }, (_, i) => new Vector3(0, i * 0.01, 0.002 * i * i));
    const sweep = buildSweep({ path, radiusAt: (t) => 0.01 * (1 - 0.5 * t) });
    expect(sweep.rings.length).toBe(11);
    sweep.rings.forEach((ring, i) => {
      for (const p of ring) expect(p.subtract(path[i]).length()).toBeCloseTo(0.01 * (1 - 0.5 * (i / 10)), 9);
    });
    for (const v of sweep.vertexData.positions as number[]) expect(Number.isFinite(v)).toBe(true);
  });
});
