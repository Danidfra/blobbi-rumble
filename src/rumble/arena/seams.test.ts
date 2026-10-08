/**
 * The floor is the union of three slabs: where a wing meets the centre the
 * floor is continuous. M7D: the geometry queries measured each slab alone,
 * so the seams read as rims (a 0.7 m strip "near the void" at x = ±4), and
 * the bots, which look ahead with those queries, would not cross onto the
 * wings. These pin the union.
 */
import { describe, expect, it } from 'vitest';
import { ARENA, onFloor, rimDistance } from './layout';

describe('the floor as one surface', () => {
  it('the seams between the centre and the wings are floor, far from the void', () => {
    for (const x of [-4, 4]) {
      expect(rimDistance({ x, z: 0 })).toBeCloseTo(ARENA.wings.halfDepth, 3);
      expect(onFloor({ x, z: 0 }, 0.35)).toBe(true);
      expect(onFloor({ x: x * 1.05, z: 1.5 }, 1)).toBe(true);
    }
    // The nearest void from beside the seam is the notch corner, not the seam.
    expect(rimDistance({ x: 3.5, z: 2.5 })).toBeCloseTo(Math.hypot(0.5, 0.5), 3);
  });

  it('real rims are still rims: the outer edges, the wings\' front edges and the notch corners', () => {
    expect(rimDistance({ x: 0, z: 3.8 })).toBeCloseTo(0.2, 3);
    expect(rimDistance({ x: 6, z: 2.8 })).toBeCloseTo(0.2, 3);
    expect(rimDistance({ x: 7.3, z: 0 })).toBeCloseTo(0.2, 3);
    expect(rimDistance({ x: -4.2, z: 2.9 })).toBeCloseTo(0.1, 3);
    expect(onFloor({ x: 0, z: 3.8 }, 0.35)).toBe(false);
    expect(onFloor({ x: 4.3, z: 3.3 }, 0.35)).toBe(false);
    expect(rimDistance({ x: 4.3, z: 3.3 })).toBe(0);
    // A footprint (negative inset) still widens each slab, as the ground probes see it.
    expect(onFloor({ x: 0, z: 4.2 }, -0.24)).toBe(true);
    expect(onFloor({ x: 0, z: 4.3 }, -0.24)).toBe(false);
  });
});
