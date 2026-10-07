/**
 * POWER: a fighter's accumulated level, as a number of orbs taken, and the
 * impact multiplier it stands for. Pure. The multiplier goes into
 * `resolveImpact` as the player power factor; that bounded path is the only
 * place power acts.
 */
import { POWER } from '../tuning';

export type PowerTuning = typeof POWER;

const at = (table: readonly number[], level: number) => table[Math.max(0, Math.min(table.length - 1, Math.floor(level)))];

/** The impact multiplier at a level; levels past the table's end stay at its last entry (the cap). */
export const powerMultiplier = (level: number, t: PowerTuning = POWER): number => at(t.multipliers, level);

/** How much harder the fighter pushes, and holds its ground, while its body is against the other's. */
export const pushAuthority = (level: number, t: PowerTuning = POWER): number => at(t.push, level);

/** The walk and run speed multiplier: a powered fighter gains ground slowly, never obviously. */
export const speedMultiplier = (level: number, t: PowerTuning = POWER): number => at(t.speed, level);

/** The level past which more orbs change nothing. */
export const powerCap = (t: PowerTuning = POWER): number => t.multipliers.length - 1;
