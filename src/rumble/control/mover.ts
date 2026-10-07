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

/** What steering reads of an intent: the direction, the run flag and the jump request. */
export type SteerIntent = Pick<MoveIntent, 'x' | 'z' | 'run' | 'jump'>;
import type { RumbleBody } from '../profile';

export interface Steering {
  /** Horizontal velocity change to apply, m/s. */
  dvx: number;
  dvz: number;
  /** Vertical velocity to set for a jump, or null. */
  jumpTo: number | null;
}

/**
 * A pushing contest: while the body is against the other fighter's, the
 * steering is a bounded spring with this gain (1/s), and its force and
 * bound are both scaled by the fighter's push authority. Absent, steering
 * is the stiff grip above.
 */
export interface Contest {
  gain: number;
  /** The gain while not steering (braking against the push). */
  brakeGain: number;
  authority: number;
  /** The unit direction to the other body, in the plane. */
  toward: { x: number; z: number };
  /**
   * A shoving match: both are pushing into each other. Then the wanted
   * speed into the other body is capped at the walk speed, for a sustained
   * shove is a leg push whatever gait the keys ask for; a run only tells in
   * the moment of impact, and when pushing someone from behind.
   */
  shoving: boolean;
}

export function steer(vx: number, vz: number, intent: SteerIntent, grounded: boolean, dt: number, p: RumbleBody, contest?: Contest): Steering {
  const wanted = intent.run ? p.runSpeed : p.walkSpeed;
  const moving = intent.x !== 0 || intent.z !== 0;
  let tx = intent.x * wanted;
  let tz = intent.z * wanted;
  if (contest?.shoving) {
    const along = tx * contest.toward.x + tz * contest.toward.z;
    if (along > p.walkSpeed) {
      tx -= (along - p.walkSpeed) * contest.toward.x;
      tz -= (along - p.walkSpeed) * contest.toward.z;
    }
  }
  const rate = (moving ? p.acceleration * (grounded ? 1 : p.airControl) : grounded ? p.braking : 0) * (contest?.authority ?? 1);
  const maxDelta = rate * dt;
  // Contested: a spring toward the wanted velocity, not the whole error at once.
  const grip = contest ? Math.min(1, (moving ? contest.gain : contest.brakeGain) * contest.authority * dt) : 1;
  let dvx = (tx - vx) * grip;
  let dvz = (tz - vz) * grip;
  const len = Math.hypot(dvx, dvz);
  if (len > maxDelta && len > 0) {
    dvx *= maxDelta / len;
    dvz *= maxDelta / len;
  }
  return { dvx, dvz, jumpTo: intent.jump && grounded ? p.jumpSpeed : null };
}
