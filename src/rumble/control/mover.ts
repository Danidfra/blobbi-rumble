/**
 * STEERING: what velocity change this frame asks of the body. Pure.
 *
 * The body is a real Havok body, so movement is never a teleport: the
 * controller asks for a bounded change of horizontal velocity toward what
 * the keys want (an acceleration on the ground, a fraction of it in the
 * air, braking with no keys), applied as an impulse. A collision can
 * therefore push the player around, and the player can push back with the
 * same bounded authority, which is what makes two capsules shove each other.
 */
import type { MoveIntent } from './input';
import type { RumbleBody } from '../profile';

export interface Steering {
  /** Horizontal velocity change to apply, m/s. */
  dvx: number;
  dvz: number;
  /** Vertical velocity to set for a jump, or null. */
  jumpTo: number | null;
}

export function steer(vx: number, vz: number, intent: MoveIntent, grounded: boolean, dt: number, p: RumbleBody): Steering {
  const wanted = intent.run ? p.runSpeed : p.walkSpeed;
  const moving = intent.x !== 0 || intent.z !== 0;
  const tx = intent.x * wanted;
  const tz = intent.z * wanted;
  const rate = moving ? p.acceleration * (grounded ? 1 : p.airControl) : grounded ? p.braking : 0;
  const maxDelta = rate * dt;
  let dvx = tx - vx;
  let dvz = tz - vz;
  const len = Math.hypot(dvx, dvz);
  if (len > maxDelta && len > 0) {
    dvx *= maxDelta / len;
    dvz *= maxDelta / len;
  }
  return { dvx, dvz, jumpTo: intent.jump && grounded ? p.jumpSpeed : null };
}
