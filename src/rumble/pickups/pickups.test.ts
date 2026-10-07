/**
 * Orbs and power, as pure logic: who takes an orb, that no orb is taken
 * twice, when it comes back and where it will not, and what a level is
 * worth, bounded.
 */
import { describe, expect, it } from 'vitest';
import { ARENA, onFloor } from '../arena/layout';
import { COMBAT, ORBS, POWER } from '../tuning';
import { collectOrbs, createOrbs, resetOrbs, tickOrbs } from './orbs';
import { powerCap, powerMultiplier } from './power';

const centre = (x: number, z: number, y = 0.525) => ({ x, y, z });
const far = centre(100, 100);

describe('the orbs', () => {
  it('stand at the arena points, on the platform and off the player spawns', () => {
    const orbs = createOrbs();
    expect(orbs).toHaveLength(3);
    const { a, b } = ARENA.spawns;
    for (const o of orbs) {
      expect(onFloor(o, 0.5)).toBe(true);
      expect(o.y).toBe(ORBS.height);
      expect(o.active).toBe(true);
      expect(Math.hypot(o.x - a.x, o.z - a.z)).toBeGreaterThan(2);
      expect(Math.hypot(o.x - b.x, o.z - b.z)).toBeGreaterThan(2);
    }
    // One is contested: in the centre, equally far from both spawns; one in each wing.
    const d = orbs.map((o) => [Math.hypot(o.x - a.x, o.z - a.z), Math.hypot(o.x - b.x, o.z - b.z)]);
    expect(d[0][0]).toBeCloseTo(d[0][1]);
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
