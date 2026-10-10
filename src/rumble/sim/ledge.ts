/**
 * LEDGE HOLDS (M11C), as pure state: whether a falling body may catch a
 * ledge, where it hangs, how its endurance drains and returns, and what a
 * step of hanging decides (keep hanging, climb, let go, give out). The
 * fighter owns the body it pins; the match asks these questions.
 *
 * One hold at a time: a fighter is a single pair of hands here, caught on
 * one edge, facing in. Two independent hands (one on a ledge, one on a
 * fighter; hand-over-hand along an edge) would need a hand model through
 * the whole of combat (grabs, carries, struggles), which this does not
 * attempt: the state is kept so that a second hold could be added beside
 * it, but nothing else assumes more than one.
 */
import { findLedge, type Ledge, type Platform } from '../arena/geometry';
import { canAct, isDown, isHolding, type CombatState } from '../combat/combat';
import type { PlayerIntent } from './intent';
import { RUMBLE_BODY } from '../profile';
import { LEDGE } from '../tuning';

export type LedgeTuning = typeof LEDGE;
export type LedgePhase = 'hang' | 'climb';

export interface LedgeHold {
  phase: LedgePhase;
  ledge: Ledge;
  /** Seconds in the phase. */
  t: number;
  /** Seconds the stick has been pushed away from the wall. */
  away: number;
}

export interface LedgeState {
  hold: LedgeHold | null;
  /** Grip endurance, 0..1. */
  endurance: number;
  /** Seconds before another catch is allowed. */
  regrab: number;
}

export const createLedgeState = (): LedgeState => ({ hold: null, endurance: 1, regrab: 0 });

export function resetLedgeState(s: LedgeState) {
  s.hold = null;
  s.endurance = 1;
  s.regrab = 0;
}

export const onLedge = (s: LedgeState) => s.hold !== null;

/** Whether a body in this state may catch a ledge now: free, upright, airborne and falling, rested enough, not just off one. */
export function canCatch(s: LedgeState, c: CombatState, grounded: boolean, vy: number, t: LedgeTuning = LEDGE): boolean {
  if (s.hold || s.regrab > 0 || s.endurance < t.minToCatch) return false;
  if (grounded || vy > -t.minFallSpeed) return false;
  return canAct(c) || (!isDown(c) && !c.held && !isHolding(c) && c.stun <= 0);
}

/**
 * The ledge within the hands' reach of a body (capsule centre `c`, feet at
 * `feetY`), on platforms that can bear it, or null. The top must be a real
 * fall above the feet (not a step down), and the place the body would hang
 * must be clear of every platform's bulk: an edge behind a wall, or one
 * whose hang would sit inside a neighbouring slab, is no ledge.
 */
export function reachableLedge(platforms: readonly Platform[], c: { x: number; y: number; z: number }, feetY: number, skip?: (index: number) => boolean, t: LedgeTuning = LEDGE, leaping?: { vx: number; vz: number }): Ledge | null {
  const clear = (l: Ledge) => {
    const a = hangAnchor(l, t);
    const r = RUMBLE_BODY.capsuleRadius;
    const top = a.y + RUMBLE_BODY.capsuleCenterY;
    const bottom = a.y - RUMBLE_BODY.capsuleCenterY;
    return !platforms.some((p, i) => {
      if (skip?.(i)) return false;
      const inside = Math.abs(a.x - p.x) < p.halfWidth + r * 0.5 && Math.abs(a.z - p.z) < p.halfDepth + r * 0.5;
      return inside && bottom < p.y && top > p.y - p.thickness;
    });
  };
  // M12.1: a body in its own leap catches only an edge it is going toward (falling short of the far side), never the one it
  // leapt away from; walked or run off, it may catch the edge it dropped from.
  const toward = (l: Ledge) => !leaping || leaping.vx * l.inX + leaping.vz * l.inZ >= -t.leapAwaySpeed;
  return findLedge(platforms, c, feetY, { reach: RUMBLE_BODY.capsuleRadius + t.reachOut, minBelow: t.minAbove, maxBelow: t.reachUp, skip, accept: (l) => toward(l) && clear(l) });
}

/** Where the capsule's centre hangs from a ledge: just clear of the wall, feet `hangDrop` below the top. */
export function hangAnchor(l: Ledge, t: LedgeTuning = LEDGE): { x: number; y: number; z: number } {
  const out = RUMBLE_BODY.capsuleRadius + t.hangOut;
  return { x: l.x - l.inX * out, y: l.y - t.hangDrop + RUMBLE_BODY.capsuleCenterY, z: l.z - l.inZ * out };
}

/** Where the capsule's centre ends a climb: on top, a little in from the edge. */
export function climbTarget(l: Ledge, t: LedgeTuning = LEDGE): { x: number; y: number; z: number } {
  const inward = RUMBLE_BODY.capsuleRadius + t.climbIn;
  return { x: l.x + l.inX * inward, y: l.y + t.climbOver + RUMBLE_BODY.capsuleCenterY, z: l.z + l.inZ * inward };
}

/**
 * M12.1: where the capsule's centre is at progress `u` (0..1) of a climb.
 * Two legs that never cut the platform's corner: first straight UP, clear
 * of the wall, until the feet are just over the top; then IN over the top
 * to the climb's end. (A straight line from the hang to the top took the
 * capsule through the corner: Havok pushed it out, and the drive that
 * chased the line lurched it at 12-18 m/s.) It also reads as a climb: a
 * pull up, then a step over.
 */
export function climbPoint(l: Ledge, u: number, t: LedgeTuning = LEDGE): { x: number; y: number; z: number } {
  const a = hangAnchor(l, t);
  const b = climbTarget(l, t);
  const k = Math.max(0, Math.min(1, u));
  if (k <= t.climbRise) {
    const w = k / t.climbRise;
    return { x: a.x, y: a.y + (b.y - a.y) * w, z: a.z };
  }
  const w = (k - t.climbRise) / (1 - t.climbRise);
  return { x: a.x + (b.x - a.x) * w, y: b.y, z: a.z + (b.z - a.z) * w };
}

export type LedgeOutcome = 'hanging' | 'climbing' | 'climbed' | 'let go' | 'tired';

/**
 * One step of a hold. Hanging: endurance drains; a jump starts the climb;
 * a grab, or the stick held away from the wall for a moment, lets go; no endurance
 * left gives out. Climbing: runs its time, then is done. The caller moves
 * the body and clears the hold on 'climbed', 'let go' and 'tired'.
 */
export function tickLedge(s: LedgeState, dt: number, intent: PlayerIntent, t: LedgeTuning = LEDGE): LedgeOutcome {
  const h = s.hold;
  if (!h) return 'let go';
  h.t += dt;
  if (h.phase === 'climb') return h.t >= t.climbTime ? 'climbed' : 'climbing';
  s.endurance = Math.max(0, s.endurance - dt / t.endurance);
  if (s.endurance <= 0) return 'tired';
  const away = -(intent.x * h.ledge.inX + intent.z * h.ledge.inZ);
  h.away = away >= t.awayPush ? h.away + dt : 0;
  if (intent.grab || h.away >= t.awayHold) return 'let go';
  if (intent.jump) {
    h.phase = 'climb';
    h.t = 0;
    return 'climbing';
  }
  return 'hanging';
}

/** Between holds: endurance returns on the floor; the regrab delay runs down. */
export function restLedge(s: LedgeState, dt: number, grounded: boolean, t: LedgeTuning = LEDGE) {
  s.regrab = Math.max(0, s.regrab - dt);
  if (!s.hold && grounded) s.endurance = Math.min(1, s.endurance + dt * t.regain);
}

/** Take the ledge. */
export function catchLedge(s: LedgeState, ledge: Ledge): LedgeHold {
  s.hold = { phase: 'hang', ledge, t: 0, away: 0 };
  return s.hold;
}

/** Off the ledge, by choice, fatigue, a blow or the ledge going: no catch again for a moment. */
export function dropLedge(s: LedgeState, t: LedgeTuning = LEDGE) {
  s.hold = null;
  s.regrab = t.regrab;
}
