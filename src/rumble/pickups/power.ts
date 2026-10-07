/**
 * POWER: a fighter's accumulated level, as a number of orbs taken, and the
 * impact multiplier it stands for. Pure. The multiplier goes into
 * `resolveImpact` as the player power factor; that bounded path is the only
 * place power acts.
 */
import { POWER } from '../tuning';

export type PowerTuning = typeof POWER;

/** The impact multiplier at a level; levels past the table's end stay at its last entry (the cap). */
export function powerMultiplier(level: number, t: PowerTuning = POWER): number {
  const i = Math.max(0, Math.min(t.multipliers.length - 1, Math.floor(level)));
  return t.multipliers[i];
}

/** The level past which more orbs change nothing. */
export const powerCap = (t: PowerTuning = POWER): number => t.multipliers.length - 1;
