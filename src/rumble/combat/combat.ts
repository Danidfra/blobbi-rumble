/**
 * COMBAT, as pure state and pure geometry. A fighter's combat state is a
 * few timers and a hold; the rules that start a punch, land it, start or
 * break a grab, pull the held body and throw it are functions of plain
 * numbers, so every one of them is tested without an engine.
 *
 * Positions are capsule centres in the ground plane (x, z); a facing is a
 * unit vector in that plane.
 */
import { COMBAT } from '../tuning';

export type Tuning = typeof COMBAT;

export interface Planar {
  x: number;
  z: number;
}

export interface CombatState {
  /** Seconds left before the next punch may start. */
  punchCooldown: number;
  /** Seconds since the current punch started, or -1. */
  punchTime: number;
  /** Whether the current punch has already landed. */
  punchLanded: boolean;
  /** Seconds of stun left. */
  stun: number;
  /** Holding the opponent, for this long so far; -1 when not. */
  holding: number;
  /** Held by the opponent. */
  held: boolean;
}

export const createCombatState = (): CombatState => ({ punchCooldown: 0, punchTime: -1, punchLanded: false, stun: 0, holding: -1, held: false });

export function resetCombat(s: CombatState) {
  s.punchCooldown = 0;
  s.punchTime = -1;
  s.punchLanded = false;
  s.stun = 0;
  s.holding = -1;
  s.held = false;
}

export function tickCombat(s: CombatState, dt: number, t: Tuning = COMBAT) {
  s.punchCooldown = Math.max(0, s.punchCooldown - dt);
  if (s.punchTime >= 0) {
    s.punchTime += dt;
    if (s.punchTime > t.punchActive + t.punchRecovery) s.punchTime = -1;
  }
  s.stun = Math.max(0, s.stun - dt);
  if (s.holding >= 0) s.holding += dt;
}

export const isPunching = (s: CombatState) => s.punchTime >= 0;
export const punchActive = (s: CombatState, t: Tuning = COMBAT) => s.punchTime >= 0 && s.punchTime <= t.punchActive && !s.punchLanded;
export const isStunned = (s: CombatState) => s.stun > 0;
export const isHolding = (s: CombatState) => s.holding >= 0;

/** A fighter may act (punch, grab) when it is neither stunned, held, holding nor mid-punch. */
export const canAct = (s: CombatState) => !isStunned(s) && !s.held && !isHolding(s) && !isPunching(s);

/** How much of its steering authority a fighter has: stunned and held bodies keep little, so knockback and pulls are not cancelled. */
export function controlFactor(s: CombatState, t: Tuning = COMBAT): number {
  if (isStunned(s)) return t.stunControl;
  if (s.held) return t.grabbedControl;
  return 1;
}

/** Start a punch if allowed. */
export function tryPunch(s: CombatState, t: Tuning = COMBAT): boolean {
  if (!canAct(s) || s.punchCooldown > 0) return false;
  s.punchTime = 0;
  s.punchLanded = false;
  s.punchCooldown = t.punchCooldown;
  return true;
}

/** Whether `victim` is within the attacker's reach and arc, and the unit direction toward it. */
export function inReach(attacker: Planar, facing: Planar, victim: Planar, range: number, arcCos: number): Planar | null {
  const dx = victim.x - attacker.x;
  const dz = victim.z - attacker.z;
  const d = Math.hypot(dx, dz);
  if (d > range) return null;
  const ux = d > 1e-6 ? dx / d : facing.x;
  const uz = d > 1e-6 ? dz / d : facing.z;
  if (ux * facing.x + uz * facing.z < arcCos) return null;
  return { x: ux, z: uz };
}

export interface Knock {
  /** Velocity change, m/s. */
  dvx: number;
  dvy: number;
  dvz: number;
}

/**
 * Land a punch if it is active and the victim is in reach: marks it landed,
 * stuns the victim, and returns the knockback along the attacker's facing.
 */
export function landPunch(attacker: CombatState, at: Planar, facing: Planar, victim: CombatState, victimAt: Planar, t: Tuning = COMBAT): Knock | null {
  if (!punchActive(attacker, t)) return null;
  if (!inReach(at, facing, victimAt, t.punchRange, t.punchArcCos)) return null;
  attacker.punchLanded = true;
  victim.stun = Math.max(victim.stun, t.hitStun);
  return { dvx: facing.x * t.punchKnock, dvy: t.punchLift, dvz: facing.z * t.punchKnock };
}

/** Start a hold if allowed: the grabber may act, the victim is not held or holding, and is in reach. */
export function tryGrab(grabber: CombatState, at: Planar, facing: Planar, victim: CombatState, victimAt: Planar, t: Tuning = COMBAT): boolean {
  if (!canAct(grabber) || victim.held || isHolding(victim)) return false;
  if (!inReach(at, facing, victimAt, t.grabRange, t.grabArcCos)) return false;
  grabber.holding = 0;
  victim.held = true;
  return true;
}

/** End a hold (release, throw, break, fall or reset). */
export function endGrab(grabber: CombatState, victim: CombatState) {
  grabber.holding = -1;
  victim.held = false;
}

/** Whether a hold must break on its own: it has lasted too long, or the bodies have come apart. */
export function holdBreaks(grabber: CombatState, at: Planar, victimAt: Planar, t: Tuning = COMBAT): boolean {
  if (!isHolding(grabber)) return false;
  if (grabber.holding > t.grabMaxHold) return true;
  return Math.hypot(victimAt.x - at.x, victimAt.z - at.z) > t.grabBreakDistance;
}

export interface Pull {
  /** The held body's velocity change this frame, and the grabber's reaction. */
  victim: Planar;
  grabber: Planar;
}

/**
 * The spring that keeps a held body in front of its grabber: a bounded
 * velocity change toward the hold point, moving with the grabber, and a
 * share of it back on the grabber.
 */
export function holdPull(at: Planar, facing: Planar, vel: Planar, victimAt: Planar, victimVel: Planar, dt: number, t: Tuning = COMBAT): Pull {
  const hx = at.x + facing.x * t.holdDistance;
  const hz = at.z + facing.z * t.holdDistance;
  const wantX = (hx - victimAt.x) * t.holdStiffness + vel.x;
  const wantZ = (hz - victimAt.z) * t.holdStiffness + vel.z;
  let dvx = wantX - victimVel.x;
  let dvz = wantZ - victimVel.z;
  const max = t.holdMaxPull * dt;
  const len = Math.hypot(dvx, dvz);
  if (len > max && len > 0) {
    dvx *= max / len;
    dvz *= max / len;
  }
  return { victim: { x: dvx, z: dvz }, grabber: { x: -dvx * t.holdReaction, z: -dvz * t.holdReaction } };
}

/** The velocity a released body is given, along the grabber's facing, from the grabber's own speed that way: a shove standing still, a throw on the run. */
export function throwVelocity(facing: Planar, grabberVel: Planar, t: Tuning = COMBAT): Knock {
  const along = Math.max(0, grabberVel.x * facing.x + grabberVel.z * facing.z);
  const speed = Math.min(t.throwMax, t.throwBase + t.throwGain * along);
  return { dvx: facing.x * speed, dvy: t.throwLift, dvz: facing.z * speed };
}

/** Throw: end the hold, stun the thrown body, and say how it leaves. */
export function release(grabber: CombatState, victim: CombatState, facing: Planar, grabberVel: Planar, t: Tuning = COMBAT): Knock {
  endGrab(grabber, victim);
  victim.stun = Math.max(victim.stun, t.throwStun);
  return throwVelocity(facing, grabberVel, t);
}
