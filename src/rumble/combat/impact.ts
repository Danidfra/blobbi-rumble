/**
 * IMPACT STRENGTH: one explicit, bounded calculation that every blow and
 * throw goes through, so that what a later milestone multiplies (a
 * player's power) has one place to multiply.
 *
 *   base × player power × attack multiplier × situational modifier → clamped
 *
 * The REACTION is read from the clamped impact: an ordinary impact is a hit
 * (knockback, a short stun); at the tumble threshold the victim is knocked
 * off its feet. A throw always tumbles.
 */
import { COMBAT } from '../tuning';

export type Tuning = typeof COMBAT;

export interface ImpactInput {
  /** The attack's own strength, m/s. */
  base: number;
  /** The attacker's power (1 until a later milestone gives it something to grow with). */
  power?: number;
  /** The attack's multiplier (1 for a plain attack). */
  attack?: number;
  /** The moment's modifier (a running punch, a long throw…). */
  situational?: number;
}

export function resolveImpact(input: ImpactInput, t: Tuning = COMBAT): number {
  const raw = input.base * (input.power ?? 1) * (input.attack ?? 1) * (input.situational ?? 1);
  return Math.max(0, Math.min(t.impactMax, raw));
}

export type ReactionKind = 'hit' | 'tumble';

export function reactionKind(impact: number, forceTumble = false, t: Tuning = COMBAT): ReactionKind {
  return forceTumble || impact >= t.tumbleThreshold ? 'tumble' : 'hit';
}

/** The situational modifier of a punch: stronger when the attacker is already moving fast along its facing. */
export function punchSituational(attackerSpeedAlongFacing: number, walkSpeed: number, t: Tuning = COMBAT): number {
  return attackerSpeedAlongFacing > walkSpeed ? t.punchRunBonus : 1;
}
