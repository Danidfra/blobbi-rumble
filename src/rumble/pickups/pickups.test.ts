/**
 * Orbs and power, as pure logic: who takes an orb, that no orb is taken
 * twice, when it comes back and where it will not, and what a level is
 * worth, bounded.
 */
import { describe, expect, it } from 'vitest';
import { ARENA, onFloor, spawnPoints } from '../arena/layout';
import { COMBAT, ORBS, POWER } from '../tuning';
import { collectOrbs, createOrbs, resetOrbs, tickOrbs } from './orbs';
import { powerCap, powerMultiplier } from './power';

const centre = (x: number, z: number, y = 0.525) => ({ x, y, z });
const far = centre(100, 100);

describe('the orbs', () => {
  it('stand at the arena points, on the platform and off every spawn: three, whatever the number of fighters', () => {
    const orbs = createOrbs();
    expect(orbs).toHaveLength(3);
    for (const count of [2, 3, 4] as const) {
      const spawns = spawnPoints(count);
      for (const o of orbs) {
        expect(onFloor(o, 0.5)).toBe(true);
        expect(o.y).toBe(ORBS.height);
        expect(o.active).toBe(true);
        for (const s of spawns) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(2);
      }
      // One is contested: in the middle, equally far from every spawn.
      const d = spawns.map((s) => Math.hypot(orbs[0].x - s.x, orbs[0].z - s.z));
      for (const x of d) expect(x).toBeCloseTo(d[0], 1);
    }
    // And one in each wing.
    expect(orbs[1].x).toBeGreaterThan(ARENA.centre.halfWidth);
    expect(orbs[2].x).toBeLessThan(-ARENA.centre.halfWidth);
  });

  it('is taken by a fighter within reach, once, and not from further away', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    expect(collectOrbs(orbs, [centre(o.x + ORBS.collectRadius + 0.05, o.z), far])).toEqual([-1, -1, -1]);
    expect(orbs[0].active).toBe(true);
    expect(collectOrbs(orbs, [far, centre(o.x + 0.3, o.z)])).toEqual([1, -1, -1]);
    expect(orbs[0].active).toBe(false);
    expect(orbs[0].timer).toBe(ORBS.respawnDelay);
    // Gone: nobody takes it again.
    expect(collectOrbs(orbs, [centre(o.x, o.z), centre(o.x, o.z)])).toEqual([-1, -1, -1]);
  });

  it('gives a contested orb to the nearer fighter, and to P1 on an exact tie: never to both', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    expect(collectOrbs(orbs, [centre(o.x + 0.4, o.z), centre(o.x - 0.2, o.z)])).toEqual([1, -1, -1]);
    resetOrbs(orbs);
    expect(collectOrbs(orbs, [centre(o.x + 0.3, o.z), centre(o.x - 0.3, o.z)])).toEqual([0, -1, -1]);
  });

  it('is not taken from the air above it', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    expect(collectOrbs(orbs, [centre(o.x, o.z, o.y + ORBS.collectRadius + 0.3), far])).toEqual([-1, -1, -1]);
  });

  it('comes back after its delay, and waits while someone stands on its point', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    collectOrbs(orbs, [centre(o.x, o.z), far]);
    expect(tickOrbs(orbs, ORBS.respawnDelay - 0.1, [far, far])).toEqual([]);
    expect(orbs[0].active).toBe(false);
    // Time is up but the point is occupied: it waits, and awards nobody.
    expect(tickOrbs(orbs, 0.2, [centre(o.x + 0.5, o.z), far])).toEqual([]);
    expect(orbs[0].active).toBe(false);
    expect(collectOrbs(orbs, [centre(o.x + 0.5, o.z), far])).toEqual([-1, -1, -1]);
    // The point clears: back.
    expect(tickOrbs(orbs, 0.016, [far, far])).toEqual([0]);
    expect(orbs[0].active).toBe(true);
    expect(orbs[0].timer).toBe(0);
  });

  it('all come back on a reset', () => {
    const orbs = createOrbs();
    collectOrbs(orbs, orbs.map((o) => centre(o.x, o.z)));
    expect(orbs.every((o) => !o.active)).toBe(true);
    resetOrbs(orbs);
    expect(orbs.every((o) => o.active && o.timer === 0)).toBe(true);
  });

  it('four fighters on one orb: the nearest takes it, an exact tie goes to the lowest index, and nobody else collects', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    const four = [centre(o.x + 0.5, o.z), centre(o.x - 0.45, o.z), centre(o.x, o.z + 0.3), centre(o.x, o.z - 0.6)];
    expect(collectOrbs(orbs, four)).toEqual([2, -1, -1]);
    resetOrbs(orbs);
    // P2, P3 and P4 exactly as near: P2 (index 1).
    expect(collectOrbs(orbs, [centre(o.x + 0.6, o.z), centre(o.x - 0.4, o.z), centre(o.x, o.z + 0.4), centre(o.x, o.z - 0.4)])).toEqual([1, -1, -1]);
    // Different orbs the same frame: each to its own nearest.
    resetOrbs(orbs);
    const [, swept, exposed] = orbs;
    expect(collectOrbs(orbs, [far, centre(exposed.x, exposed.z), centre(o.x, o.z), centre(swept.x + 0.2, swept.z)])).toEqual([2, 3, 1]);
  });

  it('a fighter out of the round (null) takes nothing and keeps nothing from returning', () => {
    const orbs = createOrbs();
    const o = orbs[0];
    expect(collectOrbs(orbs, [null, centre(o.x + 0.6, o.z), null, null])).toEqual([1, -1, -1]);
    resetOrbs(orbs);
    expect(collectOrbs(orbs, [null, null, null, null])).toEqual([-1, -1, -1]);
    collectOrbs(orbs, [centre(o.x, o.z)]);
    expect(tickOrbs(orbs, ORBS.respawnDelay + 0.1, [null, null, null, null])).toEqual([0]);
  });
});

describe('power', () => {
  it('grows one step per level through the table and caps at its end', () => {
    expect(powerMultiplier(0)).toBe(1);
    for (let level = 1; level < POWER.multipliers.length; level++) {
      expect(powerMultiplier(level)).toBeGreaterThan(powerMultiplier(level - 1));
      expect(powerMultiplier(level) - powerMultiplier(level - 1)).toBeCloseTo(0.08);
    }
    expect(powerMultiplier(powerCap())).toBe(POWER.multipliers[POWER.multipliers.length - 1]);
    expect(powerMultiplier(powerCap() + 5)).toBe(powerMultiplier(powerCap()));
    expect(powerMultiplier(-1)).toBe(1);
  });

  it('is conservative: one orb is noticeable, not decisive; the cap stays under the impact bound', () => {
    expect(powerMultiplier(1)).toBeLessThan(1.1);
    expect(powerMultiplier(powerCap()) * COMBAT.punchImpact * COMBAT.punchRunBonus).toBeLessThan(COMBAT.impactMax * 1.2);
  });
});
