/**
 * The body surface: deterministic, bounded, and a faithful carrier of the
 * 2D silhouettes into space.
 */
import { describe, expect, it } from 'vitest';
import { createBlobbiIdentity, genomeOf } from '../identity/identity';
import { canonicalGenome } from '../identity/genome';
import { deriveMorphology } from '../morphology/morphology';
import { buildBodySurface, buildBodyVertexData } from './body';
import { CANONICAL_PARAMS } from './silhouette';
import { UNIT } from './units';
import { FRONT_BODY } from './plan';

const SEEDS = ['0211d6400d3adb66bb5571fbdd4a2ed5c0f085989e9eec759d8edb9bccafccf7', '0e7fed6ddf4931589f0811a5cbf98f50d69c39f663940965e4c382acee280e1f'];
const paramsOf = (seed: string) => {
  const m = deriveMorphology(genomeOf(createBlobbiIdentity(seed)));
  return { bodyWidth: m.bodyWidth, bodyHeight: m.bodyHeight, topWidth: m.topWidth, belly: m.belly, roundness: m.roundness, lean: m.lean };
};

describe('body surface', () => {
  it('the canonical body is 1 m tall and as wide as the drawing', () => {
    const s = buildBodySurface(CANONICAL_PARAMS);
    expect(s.topY - s.baseY).toBeCloseTo(1, 6);
    // The widest point of the front silhouette is the plan's half-width.
    let widest = 0;
    for (let v = 0; v <= 1; v += 0.01) widest = Math.max(widest, s.halfWidthAt(v));
    // The cubic bulges a hair past its widest anchor, as the drawn outline does.
    expect(widest).toBeGreaterThan(FRONT_BODY.halfWidth);
    expect(widest).toBeLessThan(FRONT_BODY.halfWidth * 1.02);
    // The profile is a little shallower than the front is wide, as the drawing is.
    const depth = s.depthAt(0.5);
    expect(depth.front + depth.back).toBeLessThan(widest * 2);
    expect(depth.front + depth.back).toBeGreaterThan(widest * 1.6);
  });

  it('is deterministic: the same seed gives the same vertices, bit for bit', () => {
    const a = buildBodyVertexData(buildBodySurface(paramsOf(SEEDS[0])));
    const b = buildBodyVertexData(buildBodySurface(paramsOf(SEEDS[0])));
    expect(a.positions).toEqual(b.positions);
    expect(a.uvs).toEqual(b.uvs);
    expect(a.indices).toEqual(b.indices);
  });

  it('different seeds give different bodies, all finite and standing on the ground', () => {
    const datas = SEEDS.map((seed) => buildBodyVertexData(buildBodySurface(paramsOf(seed))));
    expect(datas[0].positions).not.toEqual(datas[1].positions);
    for (const data of datas) {
      const p = data.positions as number[];
      for (const value of p) expect(Number.isFinite(value)).toBe(true);
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < p.length; i += 3) {
        minY = Math.min(minY, p[i]);
        maxY = Math.max(maxY, p[i]);
      }
      // The base floats just above the ground (the feet carry it) and the crown is about a metre up.
      expect(minY).toBeGreaterThan(0.03);
      expect(minY).toBeLessThan(0.08);
      expect(maxY).toBeGreaterThan(0.95);
      expect(maxY).toBeLessThan(1.15);
    }
  });

  it('a wider genome is a wider body, and a taller one is taller', () => {
    const base = buildBodySurface(CANONICAL_PARAMS);
    const wide = buildBodySurface({ ...CANONICAL_PARAMS, bodyWidth: 1.07 });
    const tall = buildBodySurface({ ...CANONICAL_PARAMS, bodyHeight: 1.05 });
    expect(wide.halfWidthAt(0.5)).toBeGreaterThan(base.halfWidthAt(0.5));
    expect(tall.topY).toBeGreaterThan(base.topY);
    expect(tall.baseY).toBeCloseTo(base.baseY, 9);
  });

  it('maps the face onto the front and a back spot onto the back', () => {
    const s = buildBodySurface(CANONICAL_PARAMS);
    const face = s.uvOfFront(0, 450);
    expect(face.u).toBeCloseTo(0.5, 6);
    const back = s.uvOf(180, 1, 0.4);
    expect(back.u).toBeCloseTo(1, 6);
    const eye = s.frontPoint(104, 420);
    expect(eye.z).toBeGreaterThan(0.25);
    expect(Math.abs(eye.x)).toBeCloseTo(104 * UNIT, 3);
    const crown = s.crownPoint(0, 0);
    expect(crown.y).toBeCloseTo(s.topY, 2);
  });

  it('the canonical genome\'s morphology is the canonical body', () => {
    const m = deriveMorphology(canonicalGenome());
    const s = buildBodySurface({ bodyWidth: m.bodyWidth, bodyHeight: m.bodyHeight, topWidth: m.topWidth, belly: m.belly, roundness: m.roundness, lean: m.lean });
    expect(s.topY - s.baseY).toBeCloseTo(1, 6);
  });
});
