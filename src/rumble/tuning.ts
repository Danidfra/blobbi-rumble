/**
 * EVERY NUMBER THE GAME IS TUNED WITH, in one place. The body itself is
 * `profile.ts`; this is combat, rounds and the camera. Nothing here comes
 * from an identity or a morphology. Units: metres, seconds, m/s for
 * velocity changes ("impact"), radians.
 */
export const COMBAT = Object.freeze({
  // ── Punch ──
  /** A punch lands on an opponent whose capsule centre is within this distance, metres (capsules touch at 0.8). */
  punchRange: 1.15,
  /** ... and within this half-angle of the attacker's facing (cosine). 0.5 is 60° either side. */
  punchArcCos: 0.5,
  /** The punch's active window (it may land during this), its recovery, and the cooldown from its start, seconds. */
  punchActive: 0.12,
  punchRecovery: 0.2,
  punchCooldown: 0.55,
  /** A punch's base impact: the velocity change it gives, m/s, along the attacker's facing, and its lift. */
  punchImpact: 4.2,
  punchLift: 1.4,
  /** Situational: a punch thrown while moving faster than a walk, along the facing, is this much stronger. */
  punchRunBonus: 1.35,
  /** How long a hit victim has reduced control, seconds, and how much of its steering authority it keeps. */
  hitStun: 0.38,
  stunControl: 0.08,

  // ── Impact ──
  /** No single blow or throw changes a velocity by more than this, m/s, whatever the multipliers. */
  impactMax: 8,
  /** An impact at or above this, m/s, knocks the victim into a tumble instead of a hit reaction. */
  tumbleThreshold: 5.2,

  // ── Grab and hold ──
  /** A grab starts on an opponent within this distance and this facing cosine. */
  grabRange: 1.15,
  grabArcCos: 0.3,
  /** Where the held body is kept: this far ahead of the grabber along the HOLD direction, and this high above its feet. */
  holdDistance: 0.9,
  holdHeight: 0.55,
  /** The hold direction turns toward the grabber's facing at most this fast, rad/s: a held body is swung round, never flipped through. */
  holdTurnRate: 3.5,
  /** The spring that keeps the held body at the anchor (1/s) and the most it may change its velocity per second (m/s²). */
  holdStiffness: 9,
  holdMaxPull: 45,
  /** The share of the pull the grabber feels back: the held body has presence. */
  holdReaction: 0.45,
  /** A carrying grabber moves at this share of its speeds. */
  carrySpeed: 0.85,
  /** The held body's steering authority, the longest a hold lasts, seconds, and how far from the anchor it may be pushed before the hold breaks, metres. */
  grabbedControl: 0.2,
  grabMaxHold: 4,
  grabBreakDistance: 1.6,

  // ── Throw ──
  /** Release: the thrown body leaves along the hold direction at base + gain × grabber speed that way, capped by impactMax, with a lift. */
  throwBase: 3.0,
  throwGain: 1.3,
  throwLift: 1.6,
  /** The spin a throw gives, rad/s, pitching the body over its direction of travel. */
  throwSpin: 7,

  // ── Tumble and recovery ──
  /** A tumble lasts this long, then recovery; the fighter's steering authority in each. */
  tumbleDuration: 0.45,
  tumbleControl: 0.15,
  recoveryDuration: 0.35,
  recoveryControl: 0.35,
  /** The spin a strong punch gives, rad/s, at the tumble threshold (scales with the impact). */
  hitSpin: 5,
  /** How fast a recovering body rights itself: angular rate per radian of tilt (1/s), capped, and the tilt under which it is snapped upright. */
  uprightRate: 9,
  uprightMaxRate: 12,
  uprightSnap: 0.08,
  /** How long the hit squash shows on a victim, seconds. */
  hitSquash: 0.14,
});

export const ROUND = Object.freeze({
  /** First to this many ring-outs wins the match. */
  target: 3,
  /** The pause after a ring-out before the next round, seconds. */
  resetDelay: 1.6,
});

/**
 * POWER: what a collected orb gives. One level per orb; the impact
 * multiplier of each level, the last entry being the cap. Power multiplies
 * the impact of a punch and a throw through `resolveImpact` and nothing
 * else: not speed, reach, hold, mass or recovery.
 */
export const POWER = Object.freeze({
  /** Combat: the impact multiplier of a punch or a throw. */
  multipliers: [1.0, 1.08, 1.16, 1.24, 1.32, 1.4, 1.48] as readonly number[],
  /** Push authority: how much harder a fighter's steering pushes, and holds its ground, while its capsule is against the other's. */
  push: [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3] as readonly number[],
  /** Movement: the walk and run speeds. Never the jump, never the air share. */
  speed: [1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06] as readonly number[],
});

/**
 * A PUSHING CONTEST. Alone, steering closes the whole velocity error every
 * frame, within its budget: a stiff grip on the wanted velocity that makes
 * two touching fighters cancel each other whatever their power. While the
 * capsules touch, steering is instead a bounded spring toward the wanted
 * velocity, with this gain (1/s), and both the spring and its bound are
 * scaled by push authority: the contest settles where the two pushes
 * balance, so a stronger fighter gains ground slowly instead of winning
 * outright, and equals still stand their ground.
 */
export const PUSH = Object.freeze({
  /** The capsules count as touching within this of each other's surface, metres. */
  contactMargin: 0.06,
  /** The contested steering gain, 1/s: how hard a fighter leans on the velocity it wants while pushing or pushed. */
  gain: 14,
  /** The grip of a fighter that is not steering (braking) while pushed, 1/s: stiffer, so a passive body is shoved about as it was. */
  brakeGain: 28,
  /**
   * The capsules' ground friction while they touch. The profile's friction
   * (a static threshold of ~9 m/s² for the pair) would swallow any authority
   * margin and make every contest a stalemate; while touching, the steering
   * springs are the contest and friction steps aside. Restored when apart.
   */
  contactFriction: 0.02,
});

/**
 * POWER ORBS on the arena: where they are, how they are taken, when they
 * return. One in the centre, ahead of both spawns and equally far from each
 * (contested, safe); one in the right wing inside the sweeper's circle, on
 * the half where the bar's blow sends a fighter back toward the centre
 * (available, but timed against the bar); one deep in the left wing, 0.6 m
 * from the rim (available, but a shove away from the void).
 */
export const ORBS = Object.freeze({
  points: [
    { x: 0, z: 2.2 },
    { x: 6.0, z: -1.3 },
    { x: -6.9, z: 0 },
  ] as readonly { x: number; z: number }[],
  /** The orb floats this high over the platform (its centre), metres. */
  height: 0.6,
  /** Collected when a fighter's capsule centre is within this of the orb's centre, metres (the capsule's radius is 0.4). */
  collectRadius: 0.72,
  /** Back this long after being taken, seconds; a fighter within this of the point defers the return. */
  respawnDelay: 5,
  occupiedRadius: 1.1,
});

/**
 * THE SWEEPER: a low bar turning about a pivot in the right wing. Slow and
 * constant, so it can be learned and jumped; its blow is its own (no
 * player power in it), read from how fast the bar moves where it strikes,
 * through the same bounded impact path and the same hit / tumble rule as a
 * punch. Metres, radians, seconds.
 */
export const SWEEPER = Object.freeze({
  /** The pivot, on the floor of the right wing. */
  pivot: { x: 5.75, z: 0 },
  /** The bar reaches this far from the pivot on both sides. */
  reach: 2.0,
  /** Half of the bar's width across, and its height: it stands from the floor to `top`, low enough for a jump to clear. */
  halfWidth: 0.12,
  top: 0.22,
  /** Radians per second: one turn in about four seconds; the tip moves at 3 m/s, the root barely. */
  angularSpeed: 1.5,
  /** The blow's base impact per m/s of bar speed where it strikes (the tip tumbles, the root only shoves), and its lift. */
  impactPerSpeed: 2.0,
  lift: 1.2,
  /** A capsule this close to the bar's side counts as struck: the physical bar keeps what it shoves at exactly zero overlap. */
  hitMargin: 0.08,
  /** A fighter is not struck again within this, seconds. */
  hitCooldown: 0.6,
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
