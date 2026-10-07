import { describe, expect, it } from 'vitest';
import { buildBodySurface } from './body';
import { CANONICAL_PARAMS } from './silhouette';

describe('body surface normals', () => {
  it('point out of the face at the mouth, sideways on the flank, backward on the back, and up at the crown', () => {
    const s = buildBodySurface(CANONICAL_PARAMS);
    const face = s.pointAt(0, 0.42);
    expect(face.nz).toBeGreaterThan(0.9);
    expect(Math.abs(face.ny)).toBeLessThan(0.4);
    const flank = s.pointAt(Math.PI / 2, 0.5);
    expect(Math.abs(flank.nx)).toBeGreaterThan(0.9);
    const back = s.pointAt(Math.PI, 0.5);
    expect(back.nz).toBeLessThan(-0.9);
    const crown = s.pointAt(0, 0.985);
    expect(crown.ny).toBeGreaterThan(0.6);
    for (const p of [face, flank, back, crown]) expect(Math.hypot(p.nx, p.ny, p.nz)).toBeCloseTo(1, 9);
  });
  it('an offset moves a point along its normal by exactly that distance', () => {
    const s = buildBodySurface(CANONICAL_PARAMS);
    const a = s.pointAt(0.4, 0.6, 0);
    const b = s.pointAt(0.4, 0.6, 0.01);
    expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeCloseTo(0.01, 9);
  });
});
