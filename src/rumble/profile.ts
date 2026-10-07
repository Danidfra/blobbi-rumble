/**
 * THE RUMBLE BODY: every number the gameplay physics is tuned with, in one
 * place, the same for every player. It starts from the kit's
 * `BLOBBI_GAMEPLAY_PROFILE` (the normalized capsule, mass and speeds that
 * the renderer declares beside the visual Blobbi and never reads) and adds
 * what a Havok-backed controller needs. Nothing here comes from a seed or a
 * morphology: a wide, narrow, tall or horned Blobbi has this body.
 */
import { BLOBBI_GAMEPLAY_PROFILE } from '@blobbi-kit/3d';

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
  /** Havok linear damping, a mild drag that settles pushed bodies. */
  linearDamping: number;
  /** Gravity, m/s² (a little stronger than Earth's: party games fall quickly). */
  gravity: number;
  /** How far under a character's feet the ground may be and still count, metres. */
  groundProbe: number;
}

export const RUMBLE_BODY: Readonly<RumbleBody> = Object.freeze({
  capsuleHeight: BLOBBI_GAMEPLAY_PROFILE.capsuleHeight,
  capsuleRadius: BLOBBI_GAMEPLAY_PROFILE.capsuleRadius,
  capsuleCenterY: BLOBBI_GAMEPLAY_PROFILE.capsuleCenterY,
  mass: BLOBBI_GAMEPLAY_PROFILE.mass,
  walkSpeed: BLOBBI_GAMEPLAY_PROFILE.walkSpeed,
  runSpeed: BLOBBI_GAMEPLAY_PROFILE.runSpeed,
  jumpSpeed: BLOBBI_GAMEPLAY_PROFILE.jumpSpeed,
  acceleration: 28,
  braking: 22,
  airControl: 0.3,
  friction: 0.35,
  restitution: 0.05,
  linearDamping: 0.6,
  gravity: 14,
  groundProbe: 0.08,
});

/** Collision layers: what a raycast for the ground should see. */
export const LAYER = { ground: 1, character: 2 } as const;
