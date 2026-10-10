/**
 * THE BANANA AIM (M11F, shared since M12): a player out of the round moves
 * a reticle over the floor with the same movement intent that would move
 * the fighter (keys or the touch stick), at `BANANAS.aimSpeed` at most, and
 * any punch or grab request asks for a throw at the reticle. The client
 * only asks: the server judges every throw (out of the round, the budget,
 * the cooldown, the floor, enough fighters left).
 */
import type { PlayerIntent } from '../sim/intent';
import { BANANAS } from '../tuning';

export interface AimPoint {
  x: number;
  z: number;
}

/** The reticle after `dt` seconds of `move` (a direction no longer than one), kept on the arena by `clamp`. */
export function moveAim(aim: AimPoint, move: Pick<PlayerIntent, 'x' | 'z'>, dt: number, clamp: (p: AimPoint) => AimPoint): AimPoint {
  let x = Number.isFinite(move.x) ? move.x : 0;
  let z = Number.isFinite(move.z) ? move.z : 0;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return clamp({ x: aim.x + x * BANANAS.aimSpeed * dt, z: aim.z + z * BANANAS.aimSpeed * dt });
}

/** Whether this intent asks for a throw, and the last word from the server says one could go (no point asking otherwise). */
export function wantsThrow(intent: Pick<PlayerIntent, 'punch' | 'grab'>, bananas: { left: number; cooldown: number }): boolean {
  return (intent.punch || intent.grab) && bananas.left > 0 && bananas.cooldown <= 0;
}
