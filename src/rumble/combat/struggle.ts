/**
 * THE STRUGGLE, as pure state: how a held fighter's movement becomes
 * escape progress. Movement only: the same transport-neutral intent a
 * keyboard, a stick or a bot produces, read in whatever frame it comes in
 * (the server never needs to know where "left" is on anyone's screen: left
 * then right are opposite directions under any camera).
 *
 *   a STROKE: the movement becomes strong (from neutral, or by reversing
 *             straight through to the other side)
 *   it COUNTS: its direction is roughly opposite the previous stroke's, and
 *             there is stroke credit (refilled at one per `minInterval`)
 *
 * So holding a direction makes one stroke, left-neutral-left makes strokes
 * that never count, and alternating faster than the cap counts at the
 * cap's rate and no faster (smoothly: a little too fast loses nothing). Progress stays for the hold (one hold is
 * short) and is cleared with it (`endGrab`).
 */
import { STRUGGLE } from '../tuning';
import type { CombatState, Planar } from './combat';

export type StruggleTuning = typeof STRUGGLE;

export interface StruggleStep {
  /** A stroke happened this step, and whether it counted toward escape. */
  stroke: boolean;
  counted: boolean;
  /** Progress reached 1: the hold breaks. */
  escaped: boolean;
}

/** One simulation step of a held fighter's struggle with its movement intent `move`. */
export function stepStruggle(c: CombatState, move: Planar, dt: number, t: StruggleTuning = STRUGGLE): StruggleStep {
  c.strokeCredit = Math.min(t.credit, c.strokeCredit + dt / t.minInterval);
  const len = Math.hypot(move.x, move.z);
  const strong = len >= t.strokeThreshold;
  const dx = strong ? move.x / len : 0;
  const dz = strong ? move.z / len : 0;
  const hadMove = c.moveX !== 0 || c.moveZ !== 0;
  // A stroke: strong movement that was neutral a step ago, or that reversed through to the other side.
  const stroke = strong && (!hadMove || dx * c.moveX + dz * c.moveZ < 0);
  c.moveX = dx;
  c.moveZ = dz;
  if (!stroke) return { stroke: false, counted: false, escaped: false };
  const hadStroke = c.strokeX !== 0 || c.strokeZ !== 0;
  const reverses = hadStroke && dx * c.strokeX + dz * c.strokeZ < t.reverseCos;
  c.strokeX = dx;
  c.strokeZ = dz;
  const counted = reverses && c.strokeCredit >= 1;
  if (counted) {
    c.strokeCredit -= 1;
    c.struggle = Math.min(1, c.struggle + 1 / t.strokes);
  }
  return { stroke: true, counted, escaped: c.struggle >= 1 - 1e-9 };
}
