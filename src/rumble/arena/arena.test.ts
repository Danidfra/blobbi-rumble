/**
 * The arena's shape and the sweeper, as pure logic: where the floor is,
 * that the spawns and orbs stand on it and clear of each other and of the
 * bar, how the bar turns and resets, whom it strikes and whom it misses,
 * and that its blow is bounded and owes nothing to a player's power.
 */
import { describe, expect, it } from 'vitest';
import { RUMBLE_BODY } from '../profile';
import { COMBAT, ORBS, SWEEPER } from '../tuning';
import { ARENA, arenaExtent, floorSlabs, onFloor, rimDistance, rimSegments, spawnPoints } from './layout';
import { barDirection, barVelocity, createSweeper, resetSweeper, sweeperHit, sweeperImpact, tickSweeper } from './sweeper';

const R = RUMBLE_BODY.capsuleRadius;
const CY = RUMBLE_BODY.capsuleCenterY;
const standing = (x: number, z: number, feetY = 0) => ({ x, y: feetY + CY, z });

describe('the arena', () => {
  it('is three slabs, a wide centre and two narrower wings, over a void', () => {
    const slabs = floorSlabs();
    expect(slabs).toHaveLength(3);
    expect(slabs[1].halfDepth).toBeLessThan(slabs[0].halfDepth);
    expect(slabs[2].halfDepth).toBeLessThan(slabs[0].halfDepth);
    expect(onFloor({ x: 0, z: 0 })).toBe(true);
    expect(onFloor({ x: 6, z: 0 })).toBe(true);
    expect(onFloor({ x: 6, z: 3.5 })).toBe(false);
    expect(onFloor({ x: 0, z: 3.5 })).toBe(true);
    expect(onFloor({ x: arenaExtent().halfWidth + 0.1, z: 0 })).toBe(false);
    expect(rimDistance({ x: 0, z: 0 })).toBeCloseTo(ARENA.centre.halfDepth, 3);
    expect(rimDistance({ x: 6, z: 0 })).toBeCloseTo(arenaExtent().halfWidth - 6, 3);
    expect(rimDistance({ x: 9, z: 0 })).toBe(0);
  });

  it('draws its rim only along the outer edges: the joins between slabs are floor on both sides', () => {
    const segments = rimSegments();
    expect(segments.length).toBeGreaterThan(8);
    for (const [from, to] of segments) {
      const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
      expect(onFloor(mid, -1e-6)).toBe(true);
      // Just outside the segment is the void, on one side or the other.
      const nx = -(to.z - from.z);
      const nz = to.x - from.x;
      const len = Math.hypot(nx, nz) || 1;
      const outA = onFloor({ x: mid.x + (nx / len) * 0.05, z: mid.z + (nz / len) * 0.05 });
      const outB = onFloor({ x: mid.x - (nx / len) * 0.05, z: mid.z - (nz / len) * 0.05 });
      expect(outA !== outB).toBe(true);
    }
    // The join of the centre and the right wing is not a rim.
    const joinX = ARENA.centre.halfWidth;
    expect(segments.some(([a, b]) => Math.abs(a.x - joinX) < 1e-6 && Math.abs(b.x - joinX) < 1e-6 && Math.abs(a.z) < ARENA.wings.halfDepth && Math.abs(b.z) < ARENA.wings.halfDepth)).toBe(false);
  });

  it('spawns, for two, three and four: in the centre, well off the rim, apart, clear of the orbs and of the sweeper, all as far from the middle orb, facing it', () => {
    for (const count of [2, 3, 4] as const) {
      const spawns = spawnPoints(count);
      expect(spawns).toHaveLength(count);
      const toMiddleOrb = spawns.map((s) => Math.hypot(ORBS.points[0].x - s.x, ORBS.points[0].z - s.z));
      for (const s of spawns) {
        expect(onFloor(s)).toBe(true);
        expect(Math.abs(s.x)).toBeLessThan(ARENA.centre.halfWidth);
        expect(rimDistance(s)).toBeGreaterThanOrEqual(1.5);
        for (const o of ORBS.points) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(2);
        expect(Math.hypot(SWEEPER.pivot.x - s.x, SWEEPER.pivot.z - s.z)).toBeGreaterThan(SWEEPER.reach + R + 0.5);
        // Facing the middle: never toward a rim or the sweeper.
        const f = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
        const m = Math.hypot(s.x, s.z);
        expect((f.x * -s.x + f.z * -s.z) / m).toBeCloseTo(1);
        expect(onFloor({ x: s.x + f.x * 2, z: s.z + f.z * 2 }, 1)).toBe(true);
      }
      for (const d of toMiddleOrb) expect(d).toBeCloseTo(toMiddleOrb[0], 1);
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) expect(Math.hypot(spawns[i].x - spawns[j].x, spawns[i].z - spawns[j].z)).toBeGreaterThan(3);
    }
  });

  it('the orbs are placed with intent: one safe in the centre, one inside the sweeper, one near the rim', () => {
    const [centre, swept, exposed] = ORBS.points;
    expect(rimDistance(centre)).toBeGreaterThan(1.5);
    expect(Math.hypot(swept.x - SWEEPER.pivot.x, swept.z - SWEEPER.pivot.z)).toBeLessThan(SWEEPER.reach);
    // On the half of the circle where the bar's blow goes back toward the centre: the velocity there has a negative x.
    const s = createSweeper(1);
    s.angle = Math.atan2(-(swept.z - SWEEPER.pivot.z), swept.x - SWEEPER.pivot.x);
    const struck = sweeperHit(s, 0, standing(swept.x, swept.z), R, CY)!;
    expect(struck.reaction.dir.x).toBeLessThan(0);
    expect(Math.hypot(centre.x - SWEEPER.pivot.x, centre.z - SWEEPER.pivot.z)).toBeGreaterThan(SWEEPER.reach + 1);
    expect(rimDistance(exposed)).toBeLessThan(1);
    expect(rimDistance(exposed)).toBeGreaterThan(0.4);
  });

  it('the sweeper sits on its wing and its bar never leaves the floor by much', () => {
    expect(onFloor(SWEEPER.pivot, 1)).toBe(true);
    expect(SWEEPER.pivot.x).toBeGreaterThan(ARENA.centre.halfWidth);
    expect(SWEEPER.reach).toBeLessThanOrEqual(ARENA.wings.halfDepth);
  });
});

describe('the sweeper', () => {
  it('turns at a constant rate from a known start, and resets to it', () => {
    const s = createSweeper(2);
    expect(s.angle).toBe(0);
    tickSweeper(s, 0.5);
    expect(s.angle).toBeCloseTo(SWEEPER.angularSpeed * 0.5);
    for (let i = 0; i < 600; i++) tickSweeper(s, 1 / 60);
    expect(s.angle).toBeCloseTo((SWEEPER.angularSpeed * 10.5) % (2 * Math.PI), 6);
    s.sinceHit[0] = 0;
    resetSweeper(s);
    expect(s.angle).toBe(0);
    expect(s.sinceHit[0]).toBeGreaterThan(SWEEPER.hitCooldown);
  });

  it('the bar\'s direction and velocity agree with Babylon\'s rotation about y', () => {
    // rotation.y = θ turns +x toward -z; the velocity of a point along the bar is the derivative.
    const eps = 1e-5;
    const d0 = barDirection(0.7);
    const d1 = barDirection(0.7 + eps);
    const v = barVelocity(0.7, 1.5);
    expect(v.x).toBeCloseTo(((d1.x - d0.x) / eps) * 1.5 * SWEEPER.angularSpeed, 3);
    expect(v.z).toBeCloseTo(((d1.z - d0.z) / eps) * 1.5 * SWEEPER.angularSpeed, 3);
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(1.5 * SWEEPER.angularSpeed);
  });

  it('strikes a standing fighter under the bar, misses one beside it, beyond its reach, or jumped clear', () => {
    const s = createSweeper(2);
    const p = SWEEPER.pivot;
    // At angle 0 the bar lies along x through the pivot.
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z), R, CY)).not.toBeNull();
    s.sinceHit[0] = 99;
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z + R + SWEEPER.halfWidth + SWEEPER.hitMargin + 0.05), R, CY)).toBeNull();
    expect(sweeperHit(s, 0, standing(p.x + SWEEPER.reach + R + SWEEPER.halfWidth + SWEEPER.hitMargin + 0.05, p.z), R, CY)).toBeNull();
    // In the air with the feet above the bar's top: clear. Just too low: struck.
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z, SWEEPER.top + 0.01), R, CY)).toBeNull();
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z, SWEEPER.top - 0.05), R, CY)).not.toBeNull();
    // Off the bar's line the capsule's underside curves up: beside the bar it clears at a lower height.
    // (At angle 0 the +x arm moves toward -z: that side is the leading face.)
    s.sinceHit[0] = 99;
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z - 0.5, SWEEPER.top - 0.1), R, CY)).toBeNull();
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z - 0.5, 0), R, CY)).not.toBeNull();
  });

  it('strikes only with its leading face: a capsule just behind the bar (landed there after a jump) is not sent after it', () => {
    const s = createSweeper(1);
    const p = SWEEPER.pivot;
    expect(sweeperHit(s, 0, standing(p.x + 1.5, p.z + 0.5), R, CY)).toBeNull();
    expect(sweeperHit(s, 0, standing(p.x - 1.5, p.z - 0.5), R, CY)).toBeNull();
    // The other arm moves the other way: its leading face is on the +z side.
    expect(sweeperHit(s, 0, standing(p.x - 1.5, p.z + 0.5), R, CY)).not.toBeNull();
  });

  it('every strike of the leading face is readable: the root shoves, the middle hits about like a punch, the outer part tumbles', () => {
    const s = createSweeper(3);
    const p = SWEEPER.pivot;
    const at = (r: number, i: number) => sweeperHit(s, i, standing(p.x + r, p.z - 0.3), R, CY)!.reaction;
    const root = at(0.7, 0);
    const middle = at(1.1, 1);
    const tip = at(SWEEPER.reach - 0.05, 2);
    expect(root.kind).toBe('hit');
    expect(root.impact).toBeGreaterThan(COMBAT.punchImpact * 0.6);
    expect(middle.kind).toBe('hit');
    expect(Math.abs(middle.impact - COMBAT.punchImpact)).toBeLessThan(0.8);
    expect(tip.kind).toBe('tumble');
    expect(tip.impact).toBeGreaterThan(middle.impact);
    expect(tip.impact).toBeLessThan(COMBAT.impactMax);
  });

  it('a hit is not repeated within its cooldown, per fighter', () => {
    const s = createSweeper(2);
    const c = standing(SWEEPER.pivot.x + 1.5, SWEEPER.pivot.z);
    expect(sweeperHit(s, 0, c, R, CY)).not.toBeNull();
    expect(sweeperHit(s, 0, c, R, CY)).toBeNull();
    expect(sweeperHit(s, 1, c, R, CY)).not.toBeNull();
    tickSweeper(s, SWEEPER.hitCooldown + 0.01);
    s.angle = 0;
    expect(sweeperHit(s, 0, c, R, CY)).not.toBeNull();
  });

  it('sends the fighter the way the bar moves there, harder at the tip than at the root, through the bounded impact path, with no player power', () => {
    const s = createSweeper(2);
    const p = SWEEPER.pivot;
    const tip = sweeperHit(s, 0, standing(p.x + SWEEPER.reach - 0.05, p.z), R, CY)!;
    const root = sweeperHit(s, 1, standing(p.x + 0.4, p.z), R, CY)!;
    expect(tip.reaction.impact).toBeGreaterThan(root.reaction.impact);
    expect(tip.reaction.impact).toBeLessThanOrEqual(COMBAT.impactMax);
    expect(tip.reaction.impact).toBeCloseTo(Math.min(COMBAT.impactMax, sweeperImpact(tip.speed)));
    expect(tip.reaction.kind).toBe('tumble');
    expect(root.reaction.kind).toBe('hit');
    // Along the bar's velocity at the point of contact (the derivative of the rotation).
    const v = barVelocity(0, tip.along);
    const n = Math.hypot(v.x, v.z);
    expect(tip.reaction.dir.x).toBeCloseTo(v.x / n);
    expect(tip.reaction.dir.z).toBeCloseTo(v.z / n);
    expect(tip.reaction.dvy).toBe(SWEEPER.lift);
    // The blow is the environment's: nothing of a fighter's power is read (the signature has no power at all).
    expect(sweeperHit.length).toBeLessThanOrEqual(6);
  });
});
