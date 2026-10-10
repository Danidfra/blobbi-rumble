/**
 * COMBAT, as pure state and pure geometry. A fighter's combat state is a
 * few timers, a hold and a tumble; the rules that start a punch, land it,
 * start, turn, pull and break a hold, throw, and knock a body into a tumble
 * and back are functions of plain numbers, so every one of them is tested
 * without an engine.
 *
 * Positions are capsule centres in the ground plane (x, z) unless a `y` is
 * named; a facing is a unit vector in that plane; angles are yaws (the
 * direction (sin a, cos a)).
 */
import { COMBAT, STRUGGLE } from '../tuning';
import { reactionKind, resolveImpact, type ReactionKind } from './impact';

export type Tuning = typeof COMBAT;

export interface Planar {
  x: number;
  z: number;
}
export interface Point {
  x: number;
  y: number;
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
  /** The yaw the held body is kept at, relative to the grabber: turns toward the facing at a bounded rate. */
  holdAngle: number;
  /** Held by another fighter. */
  held: boolean;
  /** Who this fighter holds (a roster index), and who holds it; -1 for nobody. A body has one holder at most. */
  victim: number;
  holder: number;
  /** Knocked off its feet: seconds into the tumble, or -1. */
  tumble: number;
  /** Getting back up: seconds into the recovery, or -1. */
  recovering: number;
  /**
   * The struggle while held (`combat/struggle.ts`): escape progress 0..1,
   * the direction of the last struggle stroke and of the last step's
   * movement (0, 0 for none), and the stroke credit (how many strokes may
   * count right now: it refills at the capped rate). All of it belongs to
   * one hold: `endGrab` clears it.
   */
  struggle: number;
  strokeX: number;
  strokeZ: number;
  moveX: number;
  moveZ: number;
  strokeCredit: number;
  /** Seconds left in which nobody may grab this fighter (after it broke free). Grabs only: blows land as ever. */
  grabImmune: number;
}

export const createCombatState = (): CombatState => ({ punchCooldown: 0, punchTime: -1, punchLanded: false, stun: 0, holding: -1, holdAngle: 0, held: false, victim: -1, holder: -1, tumble: -1, recovering: -1, struggle: 0, strokeX: 0, strokeZ: 0, moveX: 0, moveZ: 0, strokeCredit: STRUGGLE.credit, grabImmune: 0 });

export function resetCombat(s: CombatState) {
  Object.assign(s, createCombatState());
}

/** Advance every timer. A finished tumble becomes a recovery; a finished recovery is over. */
export function tickCombat(s: CombatState, dt: number, t: Tuning = COMBAT) {
  s.punchCooldown = Math.max(0, s.punchCooldown - dt);
  if (s.punchTime >= 0) {
    s.punchTime += dt;
    if (s.punchTime > t.punchActive + t.punchRecovery) s.punchTime = -1;
  }
  s.stun = Math.max(0, s.stun - dt);
  s.grabImmune = Math.max(0, s.grabImmune - dt);
  if (s.holding >= 0) s.holding += dt;
  if (s.tumble >= 0) {
    s.tumble += dt;
    if (s.tumble >= t.tumbleDuration) {
      s.tumble = -1;
      s.recovering = 0;
    }
  } else if (s.recovering >= 0) {
    s.recovering += dt;
    if (s.recovering >= t.recoveryDuration) s.recovering = -1;
  }
}

export const isPunching = (s: CombatState) => s.punchTime >= 0;
export const punchActive = (s: CombatState, t: Tuning = COMBAT) => s.punchTime >= 0 && s.punchTime <= t.punchActive && !s.punchLanded;
export const isStunned = (s: CombatState) => s.stun > 0;
export const isHolding = (s: CombatState) => s.holding >= 0;
export const isTumbling = (s: CombatState) => s.tumble >= 0;
export const isRecovering = (s: CombatState) => s.recovering >= 0;
/** Off its feet, one way or the other: the body is not upright. */
export const isDown = (s: CombatState) => isTumbling(s) || isRecovering(s);

/** A fighter may act (punch, grab) when it is upright, free, not stunned, not held, not holding and not mid-punch. */
export const canAct = (s: CombatState) => !isDown(s) && !isStunned(s) && !s.held && !isHolding(s) && !isPunching(s);

/**
 * How much of its steering authority a fighter has. Tumbling leaves a
 * little (enough to lean toward the arena, never enough to cancel a throw),
 * recovery half, a stun almost none, a hold a fifth.
 */
export function controlFactor(s: CombatState, t: Tuning = COMBAT): number {
  if (isTumbling(s)) return t.tumbleControl;
  if (isRecovering(s)) return t.recoveryControl;
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

/** What a body receives: a velocity change, and how it reacts to it. */
export interface Reaction {
  kind: ReactionKind;
  /** The clamped impact, m/s. */
  impact: number;
  /** Velocity change, m/s. */
  dvx: number;
  dvy: number;
  dvz: number;
  /** The unit direction the blow travels in, in the ground plane. */
  dir: Planar;
}

/**
 * Land a punch if it is active and the victim is in reach: marks it landed,
 * resolves the impact (base, the attacker's power, the running bonus), and
 * returns the reaction: a hit with a short stun, or a tumble at the
 * threshold.
 */
export function landPunch(attacker: CombatState, at: Planar, facing: Planar, attackerSpeedAlong: number, power: number, victim: CombatState, victimAt: Planar, walkSpeed: number, t: Tuning = COMBAT): Reaction | null {
  if (!punchActive(attacker, t)) return null;
  if (!inReach(at, facing, victimAt, t.punchRange, t.punchArcCos)) return null;
  attacker.punchLanded = true;
  const impact = resolveImpact({ base: t.punchImpact, power, situational: attackerSpeedAlong > walkSpeed ? t.punchRunBonus : 1 }, t);
  const kind = reactionKind(impact, false, t);
  victim.stun = Math.max(victim.stun, t.hitStun);
  return { kind, impact, dvx: facing.x * impact, dvy: t.punchLift, dvz: facing.z * impact, dir: { x: facing.x, z: facing.z } };
}

/** Knock a body into a tumble (and out of any hold it had). */
export function startTumble(s: CombatState) {
  s.tumble = 0;
  s.recovering = -1;
  s.holding = -1;
}

/** Whether a body may be taken hold of at all: upright, not held by anyone, not holding anyone itself, and not just broken free. */
export const grabbable = (victim: CombatState) => !victim.held && !isHolding(victim) && !isDown(victim) && victim.grabImmune <= 0;

/**
 * Start a hold if allowed: the grabber may act, the victim is grabbable and
 * in reach. The hold begins where the victim is. `ids` (roster indices)
 * records who holds whom; a held body refuses every other grab, so no body
 * ever has two holders.
 */
export function tryGrab(grabber: CombatState, at: Planar, facing: Planar, victim: CombatState, victimAt: Planar, t: Tuning = COMBAT, ids?: { grabber: number; victim: number }): boolean {
  if (!canAct(grabber) || !grabbable(victim)) return false;
  if (!inReach(at, facing, victimAt, t.grabRange, t.grabArcCos)) return false;
  grabber.holding = 0;
  grabber.holdAngle = Math.atan2(victimAt.x - at.x, victimAt.z - at.z);
  grabber.victim = ids?.victim ?? -1;
  victim.held = true;
  victim.holder = ids?.grabber ?? -1;
  return true;
}

/** End a hold (release, throw, break, fall or reset). */
export function endGrab(grabber: CombatState, victim: CombatState) {
  grabber.holding = -1;
  grabber.victim = -1;
  victim.held = false;
  victim.holder = -1;
  // The struggle belongs to this hold: nothing of it carries into the next.
  victim.struggle = 0;
  victim.strokeX = victim.strokeZ = victim.moveX = victim.moveZ = 0;
  victim.strokeCredit = STRUGGLE.credit;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Turn `current` toward `target` by at most `maxDelta`, the short way round. */
export function turnAngle(current: number, target: number, maxDelta: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

/** The hold direction follows the grabber's facing at a bounded rate: a reversal swings the held body round, never through. */
export function stepHold(grabber: CombatState, facingYaw: number, dt: number, t: Tuning = COMBAT) {
  grabber.holdAngle = turnAngle(grabber.holdAngle, facingYaw, t.holdTurnRate * dt);
}

export const holdDirection = (grabber: CombatState): Planar => ({ x: Math.sin(grabber.holdAngle), z: Math.cos(grabber.holdAngle) });

/**
 * Whether the facing may follow the body's velocity this frame. Not while
 * stunned, held or down (the body is not walking anywhere), and while
 * carrying only when the player steers: the load's reaction on the carrier
 * must not turn it, or the hold direction chases that turn, the anchor
 * swings, and the spring kicks back the other way, a loop that shook a
 * standing carrier at low frame rates.
 */
export function facingFollowsVelocity(c: CombatState, steering: boolean): boolean {
  if (isStunned(c) || c.held || isDown(c)) return false;
  return !isHolding(c) || steering;
}

/** Where the held body is kept: ahead along the hold direction, and lifted. `feet` is the grabber's feet. */
export function holdAnchor(grabberFeet: Point, holdAngle: number, t: Tuning = COMBAT): Point {
  return { x: grabberFeet.x + Math.sin(holdAngle) * t.holdDistance, y: grabberFeet.y + t.holdHeight, z: grabberFeet.z + Math.cos(holdAngle) * t.holdDistance };
}

/** Whether a hold must break on its own: it has lasted too long, or the held body has been pushed too far from its anchor. */
export function holdBreaks(grabber: CombatState, anchor: Point, victimFeet: Point, t: Tuning = COMBAT): boolean {
  if (!isHolding(grabber)) return false;
  if (grabber.holding > t.grabMaxHold) return true;
  return Math.hypot(victimFeet.x - anchor.x, victimFeet.y - anchor.y, victimFeet.z - anchor.z) > t.grabBreakDistance;
}

export interface Pull {
  /** The held body's velocity change this frame (3D), and the grabber's reaction (in the plane). */
  victim: Point;
  grabber: Planar;
}

/**
 * The spring that keeps a held body at its anchor: a bounded velocity
 * change toward the anchor, moving with the grabber, and a share of its
 * horizontal part back on the grabber. The held body is weightless while
 * held, so the spring carries it up as well as along.
 *
 * M12.1: `anchorVel` is the anchor's own velocity (the grabber's, plus the
 * swing of the hold turning round it, plus the grabber's vertical speed),
 * fed forward, so a carried body keeps its place through a turn or a jump
 * instead of trailing 25-30 cm behind and catching up; and the speed at
 * which the spring closes an error is bounded (`holdCatchUp`), so a large
 * one (a grab from mid-air) lifts the body smoothly instead of yanking it
 * at 6 m/s.
 */
export function holdPull(anchor: Point, anchorVel: Planar & { y?: number }, victimFeet: Point, victimVel: Point, dt: number, t: Tuning = COMBAT): Pull {
  let ex = (anchor.x - victimFeet.x) * t.holdStiffness;
  let ey = (anchor.y - victimFeet.y) * t.holdStiffness;
  let ez = (anchor.z - victimFeet.z) * t.holdStiffness;
  const closing = Math.hypot(ex, ey, ez);
  if (closing > t.holdCatchUp) {
    ex *= t.holdCatchUp / closing;
    ey *= t.holdCatchUp / closing;
    ez *= t.holdCatchUp / closing;
  }
  let dvx = ex + anchorVel.x - victimVel.x;
  let dvy = ey + (anchorVel.y ?? 0) - victimVel.y;
  let dvz = ez + anchorVel.z - victimVel.z;
  const max = t.holdMaxPull * dt;
  const len = Math.hypot(dvx, dvy, dvz);
  if (len > max && len > 0) {
    dvx *= max / len;
    dvy *= max / len;
    dvz *= max / len;
  }
  return { victim: { x: dvx, y: dvy, z: dvz }, grabber: { x: -dvx * t.holdReaction, z: -dvz * t.holdReaction } };
}

/** M12.1: the velocity of a hold's anchor: the grabber's, plus the swing of a hold angle turning at `turnRate` rad/s. */
export function anchorVelocity(grabberVel: Point, holdAngle: number, turnRate: number, t: Tuning = COMBAT): Point {
  return {
    x: grabberVel.x + Math.cos(holdAngle) * t.holdDistance * turnRate,
    y: grabberVel.y,
    z: grabberVel.z - Math.sin(holdAngle) * t.holdDistance * turnRate,
  };
}

/** The impact of a throw: base plus gain times the grabber's speed along the hold direction, through the impact path. */
export function throwImpact(dir: Planar, grabberVel: Planar, power = 1, t: Tuning = COMBAT): number {
  const along = Math.max(0, grabberVel.x * dir.x + grabberVel.z * dir.z);
  return resolveImpact({ base: t.throwBase + t.throwGain * along, power }, t);
}

/** Throw: end the hold, and say how the thrown body leaves. It always tumbles. */
export function release(grabber: CombatState, victim: CombatState, dir: Planar, grabberVel: Planar, power = 1, t: Tuning = COMBAT): Reaction {
  endGrab(grabber, victim);
  const impact = throwImpact(dir, grabberVel, power, t);
  return { kind: reactionKind(impact, true, t), impact, dvx: dir.x * impact, dvy: t.throwLift, dvz: dir.z * impact, dir };
}
