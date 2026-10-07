/**
 * THE GAMEPLAY PROFILE: what a game should collide and compete with.
 *
 * A Blobbi's VISUAL morphology varies by identity: one is 7% wider, another
 * has longer arms, a third stands a little taller. None of that may become a
 * gameplay advantage. A physics-heavy party game (grabbing, pushing,
 * knock-outs) should therefore NOT derive its colliders, reach or mass from
 * the mesh; it should use the one normalized profile below, the same for
 * every player, and let the visual body merely follow the physics body.
 *
 * `createBlobbi3D` never reads this and never writes it: it is a contract
 * for hosts, kept beside the renderer so the two stay in step. The numbers
 * are a starting point sized to the canonical adult (1.05 m tall, 0.84 m
 * wide); a game tunes them once, for everyone.
 */
export interface BlobbiGameplayProfile {
  /** A capsule standing on the ground: total height and radius, metres. */
  capsuleHeight: number;
  capsuleRadius: number;
  /** Where the capsule's centre sits above the ground, metres. */
  capsuleCenterY: number;
  /** How far in front of the capsule a grab or a push reaches, metres. */
  reach: number;
  /** Mass, kg. */
  mass: number;
  walkSpeed: number;
  runSpeed: number;
  jumpSpeed: number;
}

export const BLOBBI_GAMEPLAY_PROFILE: Readonly<BlobbiGameplayProfile> = Object.freeze({
  capsuleHeight: 1.05,
  capsuleRadius: 0.4,
  capsuleCenterY: 0.525,
  reach: 0.45,
  mass: 40,
  walkSpeed: 1.6,
  runSpeed: 3.2,
  jumpSpeed: 4.6,
});
