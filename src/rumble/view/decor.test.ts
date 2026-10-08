/**
 * Decoration stays out of the way: the same spots on every reload, and none
 * near a rim, a spawn, an orb, the sweeper's circle, the seams or the
 * middle, so it never hides what play needs or looks like something to
 * stand on or bump into.
 */
import { describe, expect, it } from 'vitest';
import { onFloor, rimDistance, spawnPoints } from '../arena/layout';
import { ORBS, SWEEPER } from '../tuning';
import { decorAllowed, decorSpots, DECOR_RULES } from './decor';

describe('decoration', () => {
  const spots = decorSpots();

  it('is deterministic and sparse', () => {
    expect(decorSpots()).toEqual(spots);
    expect(spots.length).toBeGreaterThan(25);
    expect(spots.length).toBeLessThanOrEqual(46);
    for (const a of spots) for (const b of spots) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(DECOR_RULES.spacing);
  });

  it('only where play does not need the ground clear', () => {
    for (const s of spots) {
      expect(onFloor(s)).toBe(true);
      expect(rimDistance(s)).toBeGreaterThanOrEqual(DECOR_RULES.rim);
      expect(Math.hypot(s.x - SWEEPER.pivot.x, s.z - SWEEPER.pivot.z)).toBeGreaterThan(SWEEPER.reach + DECOR_RULES.sweeper);
      for (const o of ORBS.points) expect(Math.hypot(s.x - o.x, s.z - o.z)).toBeGreaterThan(DECOR_RULES.orb);
      for (const n of [2, 3, 4] as const) for (const p of spawnPoints(n)) expect(Math.hypot(s.x - p.x, s.z - p.z)).toBeGreaterThan(DECOR_RULES.spawn);
      expect(!(Math.abs(Math.abs(s.x) - 4) < DECOR_RULES.seam && Math.abs(s.z) < 3)).toBe(true);
    }
    // And the rule refuses each such place outright.
    expect(decorAllowed({ x: 0, z: 3.8 })).toBe(false);
    expect(decorAllowed(ORBS.points[2])).toBe(false);
    expect(decorAllowed({ x: SWEEPER.pivot.x + 1, z: 0 })).toBe(false);
    expect(decorAllowed({ x: 4, z: 0 })).toBe(false);
    expect(decorAllowed(spawnPoints(4)[0])).toBe(false);
  });

  it('spreads across the centre and both wings', () => {
    expect(spots.some((s) => s.x < -4)).toBe(true);
    expect(spots.some((s) => Math.abs(s.x) < 4)).toBe(true);
    expect(new Set(spots.map((s) => s.kind)).size).toBeGreaterThanOrEqual(3);
  });
});
