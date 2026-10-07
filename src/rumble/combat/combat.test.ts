/**
 * The combat rules, as plain numbers: punch timing and reach, knockback,
 * stun and control, grab reach and release, the hold's pull, the throw.
 */
import { describe, expect, it } from 'vitest';
import { COMBAT } from '../tuning';
import {
  canAct,
  controlFactor,
  createCombatState,
  endGrab,
  holdBreaks,
  holdPull,
  inReach,
  isHolding,
  landPunch,
  release,
  resetCombat,
  throwVelocity,
  tickCombat,
  tryGrab,
  tryPunch,
} from './combat';

const east = { x: 1, z: 0 };
const at = (x: number, z = 0) => ({ x, z });

describe('punch', () => {
  it('starts once, then waits out its cooldown', () => {
    const s = createCombatState();
    expect(tryPunch(s)).toBe(true);
    expect(tryPunch(s)).toBe(false);
    tickCombat(s, COMBAT.punchActive + COMBAT.punchRecovery + 0.01);
    expect(canAct(s)).toBe(true);
    expect(tryPunch(s)).toBe(false);
    tickCombat(s, COMBAT.punchCooldown);
    expect(tryPunch(s)).toBe(true);
  });

  it('lands only inside its range and arc, only while active, and only once', () => {
    const a = createCombatState();
    const v = createCombatState();
    tryPunch(a);
    expect(landPunch(a, at(0), east, v, at(COMBAT.punchRange + 0.05))).toBeNull();
    expect(landPunch(a, at(0), east, v, at(-0.9))).toBeNull();
    const hit = landPunch(a, at(0), east, v, at(0.9));
    expect(hit).not.toBeNull();
    expect(hit!.dvx).toBeCloseTo(COMBAT.punchKnock);
    expect(hit!.dvz).toBeCloseTo(0);
    expect(hit!.dvy).toBe(COMBAT.punchLift);
    expect(landPunch(a, at(0), east, v, at(0.9))).toBeNull();
    const b = createCombatState();
    tryPunch(b);
    tickCombat(b, COMBAT.punchActive + 0.01);
    expect(landPunch(b, at(0), east, createCombatState(), at(0.9))).toBeNull();
  });

  it('knocks along the attacker\'s facing, whichever way the victim is offset within the arc', () => {
    const a = createCombatState();
    tryPunch(a);
    const north = { x: 0, z: 1 };
    const hit = landPunch(a, at(0), north, createCombatState(), { x: 0.4, z: 0.8 });
    expect(hit!.dvx).toBeCloseTo(0);
    expect(hit!.dvz).toBeCloseTo(COMBAT.punchKnock);
  });

  it('stuns the victim, who then keeps little control and cannot act until it wears off', () => {
    const a = createCombatState();
    const v = createCombatState();
    tryPunch(a);
    landPunch(a, at(0), east, v, at(0.9));
    expect(v.stun).toBe(COMBAT.hitStun);
    expect(controlFactor(v)).toBe(COMBAT.stunControl);
    expect(canAct(v)).toBe(false);
    expect(tryPunch(v)).toBe(false);
    tickCombat(v, COMBAT.hitStun + 0.01);
    expect(controlFactor(v)).toBe(1);
    expect(canAct(v)).toBe(true);
  });
});

describe('grab', () => {
  it('starts only inside its range and arc, and never on a held or holding opponent', () => {
    const g = createCombatState();
    const v = createCombatState();
    expect(tryGrab(g, at(0), east, v, at(COMBAT.grabRange + 0.05))).toBe(false);
    expect(tryGrab(g, at(0), east, v, at(-0.9))).toBe(false);
    expect(tryGrab(g, at(0), east, v, at(0.9))).toBe(true);
    expect(isHolding(g)).toBe(true);
    expect(v.held).toBe(true);
    expect(controlFactor(v)).toBe(COMBAT.grabbedControl);
    // Neither may grab or punch while the hold lasts.
    expect(tryGrab(v, at(0.9), { x: -1, z: 0 }, g, at(0))).toBe(false);
    expect(tryPunch(g)).toBe(false);
    expect(tryPunch(v)).toBe(false);
    endGrab(g, v);
    expect(isHolding(g)).toBe(false);
    expect(v.held).toBe(false);
    expect(controlFactor(v)).toBe(1);
  });

  it('breaks on its own after the longest hold or when the bodies come apart', () => {
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    expect(holdBreaks(g, at(0), at(0.9))).toBe(false);
    expect(holdBreaks(g, at(0), at(COMBAT.grabBreakDistance + 0.1))).toBe(true);
    tickCombat(g, COMBAT.grabMaxHold + 0.01);
    expect(holdBreaks(g, at(0), at(0.9))).toBe(true);
  });

  it('pulls the held body toward the hold point, bounded, with a reaction on the grabber', () => {
    const dt = 1 / 60;
    // Held body sitting exactly at the hold point, both still: no pull.
    const still = holdPull(at(0), east, at(0), at(COMBAT.holdDistance), at(0), dt);
    expect(Math.hypot(still.victim.x, still.victim.z)).toBeCloseTo(0);
    // Held body behind the point: pulled forward, the grabber pulled back by the reaction share.
    const behind = holdPull(at(0), east, at(0), at(COMBAT.holdDistance - 0.3), at(0), dt);
    expect(behind.victim.x).toBeGreaterThan(0);
    expect(behind.grabber.x).toBeCloseTo(-behind.victim.x * COMBAT.holdReaction);
    // Never more than the bound per frame.
    const far = holdPull(at(0), east, at(0), at(COMBAT.holdDistance + 5), at(0), dt);
    expect(Math.hypot(far.victim.x, far.victim.z)).toBeCloseTo(COMBAT.holdMaxPull * dt);
    // The hold moves with the grabber: a walking grabber's velocity is part of what the held body is asked to match.
    const moving = holdPull(at(0), east, at(2), at(COMBAT.holdDistance), at(0), 1);
    expect(moving.victim.x).toBeCloseTo(2);
  });

  it('throws along the facing: a shove standing still, more on the run, never past the cap, and stuns', () => {
    const still = throwVelocity(east, at(0));
    expect(still.dvx).toBeCloseTo(COMBAT.throwBase);
    const run = throwVelocity(east, at(3));
    expect(run.dvx).toBeCloseTo(Math.min(COMBAT.throwMax, COMBAT.throwBase + 3 * COMBAT.throwGain));
    expect(throwVelocity(east, at(100)).dvx).toBe(COMBAT.throwMax);
    // Running away from the facing adds nothing.
    expect(throwVelocity(east, at(-3)).dvx).toBeCloseTo(COMBAT.throwBase);
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    const k = release(g, v, east, at(1));
    expect(k.dvx).toBeGreaterThan(COMBAT.throwBase);
    expect(isHolding(g)).toBe(false);
    expect(v.held).toBe(false);
    expect(v.stun).toBe(COMBAT.throwStun);
  });
});

describe('state', () => {
  it('a reset clears everything transient', () => {
    const s = createCombatState();
    tryPunch(s);
    s.stun = 1;
    s.holding = 0.5;
    s.held = true;
    resetCombat(s);
    expect(s).toEqual(createCombatState());
  });
  it('inReach gives the unit direction to the opponent', () => {
    const d = inReach(at(0), east, { x: 0.6, z: 0.6 }, 2, 0);
    expect(d!.x).toBeCloseTo(Math.SQRT1_2);
    expect(d!.z).toBeCloseTo(Math.SQRT1_2);
  });
});
