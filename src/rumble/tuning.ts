/**
 * EVERY NUMBER THE GAME IS TUNED WITH, in one place. The body itself is
 * `profile.ts`; this is combat, rounds and the camera. Nothing here comes
 * from an identity or a morphology.
 */
export const COMBAT = Object.freeze({
  /** A punch lands on an opponent whose capsule centre is within this distance, metres (capsules touch at 0.8). */
  punchRange: 1.15,
  /** ... and within this half-angle of the attacker's facing (cosine). 0.5 is 60° either side. */
  punchArcCos: 0.5,
  /** The punch's active window (it may land during this), its recovery, and the cooldown from its start, seconds. */
  punchActive: 0.12,
  punchRecovery: 0.2,
  punchCooldown: 0.55,
  /** Knockback: horizontal velocity change along the attacker's facing, and a small lift, m/s. */
  punchKnock: 4.2,
  punchLift: 1.4,
  /** How long a hit victim has reduced control, seconds, and how much of its steering authority it keeps. */
  hitStun: 0.38,
  stunControl: 0.08,
  /** A grab starts on an opponent within this distance and this facing cosine. */
  grabRange: 1.15,
  grabArcCos: 0.3,
  /** Where the held opponent is kept: this far in front of the grabber, metres. */
  holdDistance: 0.9,
  /** The spring that keeps them there (1/s) and the most it may change their velocity per second (m/s²). */
  holdStiffness: 9,
  holdMaxPull: 45,
  /** The share of the pull the grabber feels back: the held body has presence. */
  holdReaction: 0.45,
  /** The held body's steering authority and the longest a hold lasts before it lets go, seconds. */
  grabbedControl: 0.2,
  grabMaxHold: 2.5,
  /** A hold breaks if the bodies get this far apart (a wall, a punch from the side). */
  grabBreakDistance: 2.2,
  /** Release: the thrown body leaves along the grabber's facing at base + gain × grabber speed, capped, with a lift; then it is stunned. */
  throwBase: 2.2,
  throwGain: 1.3,
  throwMax: 6.5,
  throwLift: 1.3,
  throwStun: 0.45,
});

export const ROUND = Object.freeze({
  /** First to this many ring-outs wins the match. */
  target: 3,
  /** The pause after a ring-out before the next round, seconds. */
  resetDelay: 1.6,
});

export const CAMERA = Object.freeze({
  /** Looking along +z from -z (alpha) and from this far above level (beta). */
  alpha: -Math.PI / 2,
  beta: 1.05,
  /** Distance: base plus this per metre of separation, within the bounds. */
  baseRadius: 7.5,
  radiusPerMetre: 0.9,
  minRadius: 7,
  maxRadius: 14,
  /** How quickly the target and the distance follow (1/s). */
  targetFollow: 6,
  radiusFollow: 3,
  /** The point of interest is lifted this much above the midpoint of the feet. */
  lift: 0.5,
});
