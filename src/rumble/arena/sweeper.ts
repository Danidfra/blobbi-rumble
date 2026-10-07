/**
 * THE SWEEPER, as pure state and geometry: a bar through a pivot in the
 * right wing, turning at a constant rate, low enough to jump. Where it is
 * at any time follows from the time alone; whether it has a fighter, and
 * which way it sends it, follows from the bar's line and the capsule.
 *
 * An environmental hit goes through the same impact path as a blow (base,
 * no player power) and the same reaction (a hit, or a tumble when the bar
 * moves fast enough where it touched), so the fighter answers it exactly
 * as it answers a punch. The scene owns the physical bar that shoves.
 */
import { reactionKind, resolveImpact } from '../combat/impact';
import type { Reaction } from '../combat/combat';
import { COMBAT, SWEEPER } from '../tuning';

export type SweeperTuning = typeof SWEEPER;

export interface SweeperState {
  /** The bar's angle about +y, radians: Babylon's rotation.y, so a point at +x along the bar is at (cos θ, -sin θ). */
  angle: number;
  /** Seconds since the last hit, per fighter index; a hit is not repeated within the cooldown. */
  sinceHit: number[];
}

export const createSweeper = (fighters = 2): SweeperState => ({ angle: 0, sinceHit: Array(fighters).fill(99) });

export function resetSweeper(s: SweeperState) {
  s.angle = 0;
  s.sinceHit.fill(99);
}

export function tickSweeper(s: SweeperState, dt: number, t: SweeperTuning = SWEEPER) {
  s.angle = (s.angle + t.angularSpeed * dt) % (2 * Math.PI);
  for (let i = 0; i < s.sinceHit.length; i++) s.sinceHit[i] += dt;
}

/** The bar's direction (unit, along +x of the bar) at an angle, in Babylon's rotation.y sense. */
export const barDirection = (angle: number) => ({ x: Math.cos(angle), z: -Math.sin(angle) });

/** The velocity of the bar's point at signed distance `s` from the pivot, m/s, in the plane. */
export function barVelocity(angle: number, s: number, t: SweeperTuning = SWEEPER): { x: number; z: number } {
  const w = t.angularSpeed;
  return { x: -Math.sin(angle) * s * w, z: -Math.cos(angle) * s * w };
}

/** The blow's base impact where the bar moves at `speed`: a floor every real strike has, plus the bar's speed there. */
export const sweeperImpact = (speed: number, t: SweeperTuning = SWEEPER) => t.impactFloor + t.impactPerSpeed * speed;

export interface Capsule {
  /** Capsule centre. */
  x: number;
  y: number;
  z: number;
}

export interface SweeperHit {
  /** Signed distance along the bar of the point that struck. */
  along: number;
  /** The bar's speed there, m/s. */
  speed: number;
  reaction: Reaction;
}

/**
 * Whether the bar has this capsule: its axis within the bar's half-width
 * plus the capsule's radius (and a small margin, for the physical bar keeps
 * what it shoves at exactly zero overlap) of the bar's line, inside the
 * bar's reach from the pivot, and the capsule low enough that the bar's
 * box meets the sphere at the capsule's bottom, on the side the bar is
 * moving toward. A capsule jumped clear is not hit; so the bar's height and
 * the jump decide it, not a rule.
 */
export function sweeperHit(s: SweeperState, index: number, c: Capsule, capsuleRadius: number, capsuleCentreY: number, t: SweeperTuning = SWEEPER): SweeperHit | null {
  if (s.sinceHit[index] < t.hitCooldown) return null;
  const d = barDirection(s.angle);
  const rx = c.x - t.pivot.x;
  const rz = c.z - t.pivot.z;
  const along = Math.max(-t.reach, Math.min(t.reach, rx * d.x + rz * d.z));
  const px = t.pivot.x + d.x * along;
  const pz = t.pivot.z + d.z * along;
  const lateral = Math.hypot(c.x - px, c.z - pz);
  // The capsule's bottom is a sphere of the capsule's radius; the bar is a box: they meet when the box's nearest point is within the radius.
  const dh = Math.max(0, lateral - t.halfWidth - t.hitMargin);
  const dv = Math.max(0, c.y - capsuleCentreY + capsuleRadius - t.top);
  if (dh * dh + dv * dv >= capsuleRadius * capsuleRadius) return null;
  const v = barVelocity(s.angle, along, t);
  const speed = Math.hypot(v.x, v.z);
  // Only the bar's leading face strikes: a capsule behind it (landed behind it after a jump, or left there as it passed) is not sent along after it.
  if (speed > 0.05 && (c.x - px) * v.x + (c.z - pz) * v.z < 0) return null;
  const impact = resolveImpact({ base: sweeperImpact(speed, t) });
  const dir = speed > 1e-6 ? { x: v.x / speed, z: v.z / speed } : { x: d.z, z: -d.x };
  const reaction: Reaction = { kind: reactionKind(impact, false, COMBAT), impact, dvx: dir.x * impact, dvy: t.lift, dvz: dir.z * impact, dir };
  s.sinceHit[index] = 0;
  return { along, speed, reaction };
}
