/**
 * A PLAYER'S INTENT: everything the match takes from whoever plays a
 * fighter, and nothing about how it was produced. A keyboard, a test bot
 * and (later) a network message are all producers of this one shape. It is
 * plain data: a direction in the ground plane (world x and z, unit or
 * zero), a gait, and three action requests. The match decides what any of
 * it achieves.
 *
 * Movement is a state: it holds until the next intent replaces it. The
 * actions (jump, punch, grab) are requests: each is taken by the next
 * simulation step, once, and then cleared.
 */
export interface PlayerIntent {
  /** Unit (or zero) direction in the ground plane, world x and z. */
  x: number;
  z: number;
  run: boolean;
  jump: boolean;
  punch: boolean;
  /** Grab, or throw while holding. */
  grab: boolean;
}

export const IDLE_INTENT: Readonly<PlayerIntent> = Object.freeze({ x: 0, z: 0, run: false, jump: false, punch: false, grab: false });

/** A safe copy of an intent from anywhere: finite numbers, a direction no longer than one, booleans. */
export function sanitizeIntent(i: Partial<PlayerIntent>): PlayerIntent {
  let x = Number.isFinite(i.x) ? (i.x as number) : 0;
  let z = Number.isFinite(i.z) ? (i.z as number) : 0;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z, run: !!i.run, jump: !!i.jump, punch: !!i.punch, grab: !!i.grab };
}
