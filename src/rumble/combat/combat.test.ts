/**
 * The combat rules, as plain numbers: punch timing, reach and impact,
 * stun and control, the hold (where it keeps the held body, how it turns,
 * how it pulls, when it breaks), the throw, the tumble and the recovery.
 */
import { describe, expect, it } from 'vitest';
import { facingYaw } from '../control/animationBridge';
import { steer } from '../control/mover';
import { RUMBLE_BODY } from '../profile';
import { COMBAT } from '../tuning';
import {
  canAct,
  controlFactor,
  createCombatState,
  endGrab,
  facingFollowsVelocity,
  holdAnchor,
  holdBreaks,
  holdDirection,
  holdPull,
  inReach,
  isDown,
  isHolding,
  isRecovering,
  isTumbling,
  landPunch,
  release,
  resetCombat,
  startTumble,
  stepHold,
  throwImpact,
  tickCombat,
  tryGrab,
  tryPunch,
  turnAngle,
} from './combat';
import { punchSituational, reactionKind, resolveImpact } from './impact';

const east = { x: 1, z: 0 };
const at = (x: number, z = 0) => ({ x, z });
const feet = (x: number, y = 0, z = 0) => ({ x, y, z });
const walk = RUMBLE_BODY.walkSpeed;

describe('impact', () => {
  it('is base × power × attack × situational, clamped, and reads as a hit or a tumble by the threshold', () => {
    expect(resolveImpact({ base: 4 })).toBe(4);
    expect(resolveImpact({ base: 4, power: 1.5 })).toBe(6);
    expect(resolveImpact({ base: 4, power: 2, attack: 2, situational: 2 })).toBe(COMBAT.impactMax);
    expect(resolveImpact({ base: -1 })).toBe(0);
    expect(reactionKind(COMBAT.tumbleThreshold - 0.01)).toBe('hit');
    expect(reactionKind(COMBAT.tumbleThreshold)).toBe('tumble');
    expect(reactionKind(1, true)).toBe('tumble');
    expect(punchSituational(walk + 0.1, walk)).toBe(COMBAT.punchRunBonus);
    expect(punchSituational(walk, walk)).toBe(1);
  });
});

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
    expect(landPunch(a, at(0), east, 0, 1, v, at(COMBAT.punchRange + 0.05), walk)).toBeNull();
    expect(landPunch(a, at(0), east, 0, 1, v, at(-0.9), walk)).toBeNull();
    const hit = landPunch(a, at(0), east, 0, 1, v, at(0.9), walk);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('hit');
    expect(hit!.impact).toBe(COMBAT.punchImpact);
    expect(hit!.dvx).toBeCloseTo(COMBAT.punchImpact);
    expect(hit!.dvz).toBeCloseTo(0);
    expect(hit!.dvy).toBe(COMBAT.punchLift);
    expect(landPunch(a, at(0), east, 0, 1, v, at(0.9), walk)).toBeNull();
    const b = createCombatState();
    tryPunch(b);
    tickCombat(b, COMBAT.punchActive + 0.01);
    expect(landPunch(b, at(0), east, 0, 1, createCombatState(), at(0.9), walk)).toBeNull();
  });

  it('an ordinary punch is a hit; a running punch, or a stronger attacker, reaches the tumble', () => {
    const plain = createCombatState();
    tryPunch(plain);
    expect(landPunch(plain, at(0), east, 0, 1, createCombatState(), at(0.9), walk)!.kind).toBe('hit');
    const running = createCombatState();
    tryPunch(running);
    const r = landPunch(running, at(0), east, RUMBLE_BODY.runSpeed, 1, createCombatState(), at(0.9), walk)!;
    expect(r.impact).toBeCloseTo(COMBAT.punchImpact * COMBAT.punchRunBonus);
    expect(r.kind).toBe('tumble');
    const strong = createCombatState();
    tryPunch(strong);
    expect(landPunch(strong, at(0), east, 0, 1.5, createCombatState(), at(0.9), walk)!.kind).toBe('tumble');
  });

  it('stuns the victim, who then keeps little control and cannot act until it wears off', () => {
    const a = createCombatState();
    const v = createCombatState();
    tryPunch(a);
    landPunch(a, at(0), east, 0, 1, v, at(0.9), walk);
    expect(v.stun).toBe(COMBAT.hitStun);
    expect(controlFactor(v)).toBe(COMBAT.stunControl);
    expect(canAct(v)).toBe(false);
    tickCombat(v, COMBAT.hitStun + 0.01);
    expect(controlFactor(v)).toBe(1);
    expect(canAct(v)).toBe(true);
  });
});

describe('the hold', () => {
  it('starts only inside its range and arc, never on a held, holding or downed opponent, and begins where the opponent is', () => {
    const g = createCombatState();
    const v = createCombatState();
    expect(tryGrab(g, at(0), east, v, at(COMBAT.grabRange + 0.05))).toBe(false);
    expect(tryGrab(g, at(0), east, v, at(-0.9))).toBe(false);
    const down = createCombatState();
    startTumble(down);
    expect(tryGrab(g, at(0), east, down, at(0.9))).toBe(false);
    expect(tryGrab(g, at(0), east, v, { x: 0.6, z: 0.6 })).toBe(true);
    expect(isHolding(g)).toBe(true);
    expect(v.held).toBe(true);
    expect(g.holdAngle).toBeCloseTo(Math.PI / 4);
    expect(controlFactor(v)).toBe(COMBAT.grabbedControl);
    expect(tryGrab(v, at(0.9), { x: -1, z: 0 }, g, at(0))).toBe(false);
    expect(tryPunch(g)).toBe(false);
    expect(tryPunch(v)).toBe(false);
    endGrab(g, v);
    expect(isHolding(g)).toBe(false);
    expect(v.held).toBe(false);
  });

  it('keeps the held body ahead along the hold direction and lifted', () => {
    const a = holdAnchor(feet(1, 0, 2), Math.PI / 2);
    expect(a.x).toBeCloseTo(1 + COMBAT.holdDistance);
    expect(a.z).toBeCloseTo(2);
    expect(a.y).toBeCloseTo(COMBAT.holdHeight);
    expect(COMBAT.holdHeight).toBeGreaterThan(0.3);
    expect(COMBAT.holdDistance).toBeGreaterThanOrEqual(2 * RUMBLE_BODY.capsuleRadius);
  });

  it('turns toward the facing at a bounded rate, the short way, never through: a 180° reversal swings round', () => {
    expect(turnAngle(0, 0.1, 1)).toBeCloseTo(0.1);
    expect(turnAngle(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(turnAngle(0, -1, 0.25)).toBeCloseTo(-0.25);
    // 3 to -3 is 0.283 the short way (through ±π), so one step of 0.5 arrives, wrapped.
    expect(turnAngle(3, -3, 0.5)).toBeCloseTo(-3, 6);
    expect(turnAngle(3, -3, 0.1)).toBeCloseTo(3.1, 6);
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    expect(g.holdAngle).toBeCloseTo(Math.PI / 2);
    // The grabber reverses: the facing is now -x. The anchor stays a full hold distance from the grabber every frame
    // and moves by at most the turn rate, so it sweeps round the side and never crosses the grabber.
    const dt = 1 / 60;
    let last = holdAnchor(feet(0), g.holdAngle);
    let maxStep = 0;
    let minDistance = Infinity;
    for (let i = 0; i < 120; i++) {
      stepHold(g, -Math.PI / 2, dt);
      const a = holdAnchor(feet(0), g.holdAngle);
      maxStep = Math.max(maxStep, Math.hypot(a.x - last.x, a.z - last.z));
      minDistance = Math.min(minDistance, Math.hypot(a.x, a.z));
      last = a;
    }
    expect(minDistance).toBeCloseTo(COMBAT.holdDistance, 6);
    expect(maxStep).toBeLessThanOrEqual(COMBAT.holdDistance * COMBAT.holdTurnRate * dt + 1e-9);
    expect(g.holdAngle).toBeCloseTo(-Math.PI / 2);
    expect(holdDirection(g).x).toBeCloseTo(-1);
    // Within the time a reversal takes, the hold is still valid.
    expect(g.holding).toBeLessThan(COMBAT.grabMaxHold);
  });

  it('breaks on its own after the longest hold or when the held body is pushed off its anchor', () => {
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    const anchor = holdAnchor(feet(0), g.holdAngle);
    expect(holdBreaks(g, anchor, feet(anchor.x, anchor.y, anchor.z))).toBe(false);
    expect(holdBreaks(g, anchor, feet(anchor.x + COMBAT.grabBreakDistance + 0.1, anchor.y, anchor.z))).toBe(true);
    tickCombat(g, COMBAT.grabMaxHold + 0.01);
    expect(holdBreaks(g, anchor, feet(anchor.x, anchor.y, anchor.z))).toBe(true);
  });

  it('pulls the held body toward the anchor in three dimensions, bounded, with a reaction on the grabber', () => {
    const dt = 1 / 60;
    const anchor = feet(COMBAT.holdDistance, COMBAT.holdHeight, 0);
    const still = holdPull(anchor, at(0), anchor, feet(0), dt);
    expect(Math.hypot(still.victim.x, still.victim.y, still.victim.z)).toBeCloseTo(0);
    // Below and behind the anchor: pulled up and forward; the grabber feels the horizontal part back.
    const low = holdPull(anchor, at(0), feet(COMBAT.holdDistance - 0.3, 0, 0), feet(0), dt);
    expect(low.victim.y).toBeGreaterThan(0);
    expect(low.victim.x).toBeGreaterThan(0);
    expect(low.grabber.x).toBeCloseTo(-low.victim.x * COMBAT.holdReaction);
    const far = holdPull(anchor, at(0), feet(COMBAT.holdDistance + 5, 0, 0), feet(0), dt);
    expect(Math.hypot(far.victim.x, far.victim.y, far.victim.z)).toBeCloseTo(COMBAT.holdMaxPull * dt);
    // The hold moves with the grabber.
    const moving = holdPull(anchor, at(2), anchor, feet(0), 1);
    expect(moving.victim.x).toBeCloseTo(2);
  });

  it('turns the carrier only by its own steering: the load cannot turn it', () => {
    const c = createCombatState();
    expect(facingFollowsVelocity(c, false)).toBe(true);
    c.holding = 0;
    expect(facingFollowsVelocity(c, false)).toBe(false);
    expect(facingFollowsVelocity(c, true)).toBe(true);
    const held = createCombatState();
    held.held = true;
    expect(facingFollowsVelocity(held, true)).toBe(false);
  });

  /**
   * The carrier and its load as points, with the game's own rules: braking
   * steering, the hold spring and its reaction, the hold direction chasing
   * the facing. A standing carrier whose hold direction is off its facing
   * (as after a turn) must settle, even at a low frame rate, where each
   * frame's reaction is large.
   */
  function standingHold(dt: number, loadTurnsCarrier: boolean) {
    const g = { x: 0, z: 0, vx: 0, vz: 0 };
    const v = { x: Math.sin(Math.PI / 2) * COMBAT.holdDistance, y: COMBAT.holdHeight, z: 0, vx: 0, vy: 0, vz: 0 };
    let yaw = 0;
    const c = createCombatState();
    c.holding = 0;
    c.holdAngle = Math.PI / 2;
    let maxSpeed = 0;
    let yawSpan = 0;
    const frames = Math.round(2 / dt);
    for (let i = 0; i < frames; i++) {
      c.holding += dt;
      const s = steer(g.vx, g.vz, { x: 0, z: 0, run: false, jump: false }, true, dt, RUMBLE_BODY);
      g.vx += s.dvx;
      g.vz += s.dvz;
      // As the game orders it: steer, then the hold (direction, anchor, pull, reaction), then the facing from the body's velocity.
      stepHold(c, yaw, dt);
      const anchor = holdAnchor(feet(g.x, 0, g.z), c.holdAngle);
      const pull = holdPull(anchor, at(g.vx, g.vz), feet(v.x, v.y, v.z), feet(v.vx, v.vy, v.vz), dt);
      v.vx += pull.victim.x;
      v.vy += pull.victim.y;
      v.vz += pull.victim.z;
      g.vx += pull.grabber.x;
      g.vz += pull.grabber.z;
      const before = yaw;
      if (loadTurnsCarrier || facingFollowsVelocity(c, false)) yaw = facingYaw(g.vx, g.vz, yaw, dt);
      g.x += g.vx * dt;
      g.z += g.vz * dt;
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.z += v.vz * dt;
      if (i * dt > 1) {
        maxSpeed = Math.max(maxSpeed, Math.hypot(g.vx, g.vz));
        yawSpan = Math.max(yawSpan, Math.abs(yaw - before));
      }
    }
    return { maxSpeed, yawSpan, holdAngle: c.holdAngle, yaw };
  }

  it('a standing carrier does not shake: the hold settles at 60 and at 16 frames per second', () => {
    for (const dt of [1 / 60, 1 / 16]) {
      const settled = standingHold(dt, false);
      expect(settled.maxSpeed).toBeLessThan(0.02);
      expect(settled.yawSpan).toBe(0);
      expect(settled.holdAngle).toBeCloseTo(settled.yaw);
    }
    // The loop this guards against: with the load's reaction turning the carrier, the same hold shakes at a low frame rate.
    const shaking = standingHold(1 / 16, true);
    expect(shaking.maxSpeed).toBeGreaterThan(0.3);
    expect(shaking.yawSpan).toBeGreaterThan(0.3);
  });
});

describe('throw and tumble', () => {
  it('throws along the hold direction through the impact path, always into a tumble', () => {
    expect(throwImpact(east, at(0))).toBeCloseTo(COMBAT.throwBase);
    expect(throwImpact(east, at(3))).toBeCloseTo(Math.min(COMBAT.impactMax, COMBAT.throwBase + 3 * COMBAT.throwGain));
    expect(throwImpact(east, at(100))).toBe(COMBAT.impactMax);
    expect(throwImpact(east, at(-3))).toBeCloseTo(COMBAT.throwBase);
    expect(throwImpact(east, at(0), 1.5)).toBeCloseTo(COMBAT.throwBase * 1.5);
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    const k = release(g, v, holdDirection(g), at(1));
    expect(k.kind).toBe('tumble');
    expect(k.dvx).toBeGreaterThan(COMBAT.throwBase);
    expect(k.dvy).toBe(COMBAT.throwLift);
    expect(isHolding(g)).toBe(false);
    expect(v.held).toBe(false);
  });

  it('a tumble runs its course into a recovery and then back to normal, with control reduced on the way', () => {
    const s = createCombatState();
    startTumble(s);
    expect(isTumbling(s)).toBe(true);
    expect(isDown(s)).toBe(true);
    expect(canAct(s)).toBe(false);
    expect(controlFactor(s)).toBe(COMBAT.tumbleControl);
    expect(COMBAT.tumbleControl).toBeLessThan(0.3);
    tickCombat(s, COMBAT.tumbleDuration + 0.001);
    expect(isTumbling(s)).toBe(false);
    expect(isRecovering(s)).toBe(true);
    expect(controlFactor(s)).toBe(COMBAT.recoveryControl);
    tickCombat(s, COMBAT.recoveryDuration + 0.001);
    expect(isDown(s)).toBe(false);
    expect(controlFactor(s)).toBe(1);
    expect(canAct(s)).toBe(true);
    expect(s).toEqual(createCombatState());
  });

  it('a tumbling player can lean but cannot cancel or reverse a throw', () => {
    // Thrown at a typical throw speed, holding straight back for the whole tumble: the steering is bounded by
    // the tumble's share of the acceleration, so the body keeps most of its momentum.
    const p = { ...RUMBLE_BODY, acceleration: RUMBLE_BODY.acceleration * COMBAT.tumbleControl, braking: RUMBLE_BODY.braking * COMBAT.tumbleControl };
    const thrown = throwImpact(east, at(1.5));
    let vx = thrown;
    const dt = 1 / 60;
    for (let t = 0; t < COMBAT.tumbleDuration; t += dt) vx += steer(vx, 0, { x: -1, z: 0, run: true, jump: false }, true, dt, p).dvx;
    expect(vx).toBeGreaterThan(thrown * 0.55);
    // But holding back did make a difference.
    let free = thrown;
    for (let t = 0; t < COMBAT.tumbleDuration; t += dt) free += steer(free, 0, { x: 0, z: 0, run: false, jump: false }, false, dt, p).dvx;
    expect(vx).toBeLessThan(free);
  });

  it('a knock-down ends a hold the victim had, and a reset clears everything', () => {
    const g = createCombatState();
    const v = createCombatState();
    tryGrab(g, at(0), east, v, at(0.9));
    startTumble(g);
    expect(isHolding(g)).toBe(false);
    g.stun = 1;
    g.held = true;
    g.recovering = 0.1;
    resetCombat(g);
    expect(g).toEqual(createCombatState());
  });
});

describe('inReach', () => {
  it('gives the unit direction to the opponent', () => {
    const d = inReach(at(0), east, { x: 0.6, z: 0.6 }, 2, 0);
    expect(d!.x).toBeCloseTo(Math.SQRT1_2);
    expect(d!.z).toBeCloseTo(Math.SQRT1_2);
  });
});
