/**
 * Power as physical authority, as pure logic: the level tables, the
 * contested steering, capsule contact, and the two-body contests the
 * mechanic exists for, simulated with the game's own steering on two point
 * masses in inelastic contact (no Havok, so no solver numbers to chase).
 */
import { describe, expect, it } from 'vitest';
import { capsuleGap, capsulesTouch } from '../physics/contact';
import { powerCap, pushAuthority, speedMultiplier } from '../pickups/power';
import { RUMBLE_BODY } from '../profile';
import { POWER, PUSH } from '../tuning';
import { steer, type Contest, type SteerIntent } from './mover';

const p = RUMBLE_BODY;
const dt = 1 / 60;
const east: SteerIntent = { x: 1, z: 0, run: false, jump: false };
const west: SteerIntent = { x: -1, z: 0, run: false, jump: false };
const still: SteerIntent = { x: 0, z: 0, run: false, jump: false };
const contest = (authority: number, toward: 1 | -1, shoving: boolean): Contest => ({ gain: PUSH.gain, brakeGain: PUSH.brakeGain, authority, toward: { x: toward, z: 0 }, shoving });

describe('power as authority', () => {
  it('push authority and movement speed grow one step per level, cap with the table, and are 1 at zero', () => {
    expect(pushAuthority(0)).toBe(1);
    expect(speedMultiplier(0)).toBe(1);
    for (let level = 1; level <= powerCap(); level++) {
      expect(pushAuthority(level)).toBeGreaterThan(pushAuthority(level - 1));
      expect(speedMultiplier(level)).toBeGreaterThan(speedMultiplier(level - 1));
    }
    expect(pushAuthority(powerCap() + 3)).toBe(POWER.push[POWER.push.length - 1]);
    expect(speedMultiplier(powerCap() + 3)).toBe(POWER.speed[POWER.speed.length - 1]);
    // The hierarchy: combat impact > push authority > movement speed.
    expect(POWER.multipliers[powerCap()]).toBeGreaterThan(POWER.push[powerCap()]);
    expect(POWER.push[powerCap()]).toBeGreaterThan(POWER.speed[powerCap()]);
    expect(POWER.speed[powerCap()]).toBeLessThanOrEqual(1.06);
  });

  it('uncontested steering is exactly what it was, whatever the authority', () => {
    const plain = steer(0.3, 0, east, true, dt, p);
    expect(plain.dvx).toBeCloseTo(p.acceleration * dt);
    expect(steer(0.3, 0, east, true, dt, p, undefined)).toEqual(plain);
    // Jump and air share never read a contest.
    expect(steer(0, 0, { ...east, jump: true }, true, dt, p, contest(1.3, 1, true)).jumpTo).toBe(p.jumpSpeed);
    expect(steer(0, 0, east, false, dt, p).dvx).toBeCloseTo(p.acceleration * p.airControl * dt);
  });

  it('contested steering is a bounded spring whose force and bound scale with authority; braking grips harder', () => {
    const weak = steer(0, 0, east, true, dt, p, contest(1, 1, false));
    const strong = steer(0, 0, east, true, dt, p, contest(1.3, 1, false));
    expect(weak.dvx).toBeCloseTo(PUSH.gain * p.walkSpeed * dt);
    expect(strong.dvx).toBeCloseTo(1.3 * PUSH.gain * p.walkSpeed * dt);
    // Far from the wanted velocity the bound holds, scaled by authority.
    expect(steer(-5, 0, east, true, dt, p, contest(1.3, 1, false)).dvx).toBeCloseTo(1.3 * p.acceleration * dt);
    // Pushed while not steering: a stiffer grip, within the braking bound.
    expect(steer(0.5, 0, still, true, dt, p, contest(1, 1, false)).dvx).toBeCloseTo(-Math.min(PUSH.brakeGain * 0.5 * dt, p.braking * dt));
  });

  it('in a shoving match the wanted speed into the other body is capped at the walk, sideways is free', () => {
    const run: SteerIntent = { x: 1, z: 0, run: true, jump: false };
    const shove = steer(0, 0, run, true, 1, p, { ...contest(1, 1, true), gain: 1 });
    expect(shove.dvx).toBeCloseTo(p.walkSpeed);
    const side = steer(0, 0, { x: 0, z: 1, run: true, jump: false }, true, 1, p, { ...contest(1, 1, true), gain: 1 });
    expect(side.dvz).toBeCloseTo(p.runSpeed);
    // Not a shoving match (pushing someone from behind): the run counts in full.
    expect(steer(0, 0, run, true, 1, p, { ...contest(1, 1, false), gain: 1 }).dvx).toBeCloseTo(p.runSpeed);
  });

  it('head-on: keys held nearly into the other body push along the contact line; a diagonal or a sidestep is left alone', () => {
    // The other body is a little off the key direction (about 11°), as it is a moment into any real contest.
    const toward = { x: Math.cos(0.2), z: Math.sin(0.2) };
    const c = { ...contest(1, 1, true), toward, gain: 1, headOnCos: PUSH.headOnCos };
    const straight = steer(0, 0, { x: 1, z: 0, run: false, jump: false }, true, 1, p, c);
    // Along the line, at the walk: no sideways part left to shear the two apart.
    expect(straight.dvx / Math.hypot(straight.dvx, straight.dvz)).toBeCloseTo(toward.x);
    expect(straight.dvz / Math.hypot(straight.dvx, straight.dvz)).toBeCloseTo(toward.z);
    // An unasked sideways drift is resisted, not followed.
    expect(steer(0, 0.4, { x: 1, z: 0, run: false, jump: false }, true, 1 / 60, p, c).dvz).toBeLessThan(0);
    // A diagonal is the player's escape: untouched.
    const d = Math.SQRT1_2;
    const diag = steer(0, 0, { x: d, z: -d, run: false, jump: false }, true, 1, p, c);
    const plain = steer(0, 0, { x: d, z: -d, run: false, jump: false }, true, 1, p, { ...c, headOnCos: undefined });
    expect(diag).toEqual(plain);
    // Not a shoving match (the other is not pushing back): no cone.
    expect(steer(0, 0, { x: 1, z: 0, run: false, jump: false }, true, 1, p, { ...c, shoving: false }).dvz).toBeCloseTo(0);
  });

  it('two upright capsules touch when their axes are within two radii, in the plane and in height', () => {
    const a = { x: 0, y: 0.525, z: 0 };
    expect(capsuleGap(a, { x: 0.8, y: 0.525, z: 0 })).toBeCloseTo(0);
    expect(capsulesTouch(a, { x: 0.85, y: 0.525, z: 0 }, PUSH.contactMargin)).toBe(true);
    expect(capsulesTouch(a, { x: 0.9, y: 0.525, z: 0 }, PUSH.contactMargin)).toBe(false);
    // Lifted (a held body): still touching only if the axis segments come close.
    expect(capsulesTouch(a, { x: 0.8, y: 0.525 + 0.25, z: 0 }, PUSH.contactMargin)).toBe(true);
    // A held body: lifted 0.55 m and 0.9 m ahead, as the hold keeps it, it is clear of the carrier.
    expect(capsulesTouch(a, { x: 0.9, y: 0.525 + 0.55, z: 0 }, PUSH.contactMargin)).toBe(false);
    expect(capsulesTouch(a, { x: 0, y: 0.525 + 1.05, z: 0 }, PUSH.contactMargin)).toBe(true);
    expect(capsulesTouch(a, { x: 0, y: 0.525 + 1.2, z: 0 }, PUSH.contactMargin)).toBe(false);
  });

  /**
   * Two point masses in sustained contact along x: each steers with the
   * game's own `steer`, the pair shares one velocity (an inelastic contact),
   * and the ground is the contested friction plus the profile's damping.
   * Returns the pair's velocity after two seconds.
   */
  function pairVelocity(levelA: number, levelB: number, intentA: SteerIntent, intentB: SteerIntent): number {
    let v = 0;
    const walkA = p.walkSpeed * speedMultiplier(levelA);
    const walkB = p.walkSpeed * speedMultiplier(levelB);
    const pa = { ...p, walkSpeed: walkA, runSpeed: p.runSpeed * speedMultiplier(levelA) };
    const pb = { ...p, walkSpeed: walkB, runSpeed: p.runSpeed * speedMultiplier(levelB) };
    const shoving = intentA.x > 0.3 && intentB.x < -0.3;
    for (let i = 0; i < 120; i++) {
      const a = steer(v, 0, intentA, true, dt, pa, contest(pushAuthority(levelA), 1, shoving));
      const b = steer(v, 0, intentB, true, dt, pb, contest(pushAuthority(levelB), -1, shoving));
      // The pair: the mean of the two velocity changes, less friction and damping on both bodies.
      v += (a.dvx + b.dvx) / 2;
      const friction = PUSH.contactFriction * p.gravity * dt;
      v = Math.sign(v) * Math.max(0, Math.abs(v) - friction);
      v *= 1 - p.linearDamping * dt;
    }
    return v;
  }

  it('equals stand their ground head-on and walk together in the same direction', () => {
    expect(Math.abs(pairVelocity(0, 0, east, west))).toBeLessThan(0.01);
    expect(Math.abs(pairVelocity(6, 6, east, west))).toBeLessThan(0.01);
    expect(pairVelocity(0, 0, east, east)).toBeGreaterThan(p.walkSpeed * 0.9);
  });

  it('head-on, the stronger fighter gains ground slowly, more with every level, and never fast', () => {
    let last = 0;
    for (let level = 2; level <= powerCap(); level++) {
      const v = pairVelocity(level, 0, east, west);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
    expect(last).toBeGreaterThan(0.15);
    expect(last).toBeLessThan(0.4);
    // The same from the other side, and running changes nothing in a shove.
    expect(pairVelocity(0, 6, east, west)).toBeCloseTo(-last, 2);
    expect(pairVelocity(6, 0, { ...east, run: true }, { ...west, run: true })).toBeCloseTo(last, 2);
  });

  it('pushing a passive body: a little faster with power, a little slower against it', () => {
    const equal = pairVelocity(0, 0, east, still);
    expect(equal).toBeGreaterThan(0.3);
    expect(equal).toBeLessThan(0.8);
    expect(pairVelocity(6, 0, east, still)).toBeGreaterThan(equal);
    expect(pairVelocity(0, 6, east, still)).toBeLessThan(equal);
  });
});
