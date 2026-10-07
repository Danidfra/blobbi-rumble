/**
 * THE RUMBLE BODY: every number the gameplay physics is tuned with, in one
 * place, the same for every player. The capsule, mass and speeds are the
 * kit's `BLOBBI_GAMEPLAY_PROFILE` (the normalized body the renderer declares
 * beside the visual Blobbi and never reads), copied here so the
 * authoritative simulation does not depend on the renderer package at all;
 * a test pins the copy to the kit's values. The rest is what a
 * Havok-backed controller needs. Nothing here comes from a seed or a
 * morphology: a wide, narrow, tall or horned Blobbi has this body.
 */

/** The kit's `BLOBBI_GAMEPLAY_PROFILE` (@blobbi-kit/3d 0.1.x), pinned by a test. */
export const GAMEPLAY_PROFILE = Object.freeze({ capsuleHeight: 1.05, capsuleRadius: 0.4, capsuleCenterY: 0.525, mass: 40, walkSpeed: 1.6, runSpeed: 3.2, jumpSpeed: 4.6 });

export interface RumbleBody {
  capsuleHeight: number;
  capsuleRadius: number;
  capsuleCenterY: number;
  mass: number;
  walkSpeed: number;
  runSpeed: number;
  jumpSpeed: number;
  /** How quickly the horizontal velocity closes on what the keys ask for, m/s² (on the ground). */
  acceleration: number;
  /** How quickly it bleeds off with no keys held, m/s² (on the ground). */
  braking: number;
  /** The share of `acceleration` available in the air. */
  airControl: number;
  /** The capsule's friction against the platform and other bodies. */
  friction: number;
  restitution: number;
  /** Havok linear damping, a mild drag that settles pushed bodies, and angular damping for a tumbling body. */
  linearDamping: number;
  angularDamping: number;
  /** The rotational inertia a body is given while it tumbles, kg·m² about each axis (a capsule this size); upright it has none. */
  tumbleInertia: { x: number; y: number; z: number };
  /** Gravity, m/s² (a little stronger than Earth's: party games fall quickly). */
  gravity: number;
  /** How far under a character's feet the ground may be and still count, metres. */
  groundProbe: number;
}

export const RUMBLE_BODY: Readonly<RumbleBody> = Object.freeze({
  capsuleHeight: GAMEPLAY_PROFILE.capsuleHeight,
  capsuleRadius: GAMEPLAY_PROFILE.capsuleRadius,
  capsuleCenterY: GAMEPLAY_PROFILE.capsuleCenterY,
  mass: GAMEPLAY_PROFILE.mass,
  walkSpeed: GAMEPLAY_PROFILE.walkSpeed,
  runSpeed: GAMEPLAY_PROFILE.runSpeed,
  jumpSpeed: GAMEPLAY_PROFILE.jumpSpeed,
  acceleration: 28,
  braking: 22,
  airControl: 0.3,
  friction: 0.35,
  restitution: 0.05,
  linearDamping: 0.6,
  angularDamping: 1.2,
  tumbleInertia: { x: 5, y: 3, z: 5 },
  gravity: 14,
  groundProbe: 0.08,
});

/** Collision layers: what a raycast for the ground should see. */
export const LAYER = { ground: 1, character: 2 } as const;
