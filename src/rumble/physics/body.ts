/**
 * THE GAMEPLAY BODY: one normalized capsule per character, owned by Havok.
 *
 * The capsule is built from `RUMBLE_BODY` and nothing else: the visual
 * Blobbi it will carry is never consulted, so every character collides,
 * weighs and moves the same. Upright, it has no rotational inertia at all
 * (Havok then never turns it); knocked down, it is given the inertia of a
 * capsule its size and really tumbles, until the game rights it and locks
 * it upright again.
 *
 * The body's transform node is an invisible capsule mesh at the capsule's
 * centre; the visual Blobbi is placed on it each frame.
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsShapeType, PhysicsMotionType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { PhysicsRaycastResult } from '@babylonjs/core/Physics/physicsRaycastResult';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody';
import type { PhysicsEngine } from '@babylonjs/core/Physics/v2/physicsEngine';
import type { Scene } from '@babylonjs/core/scene';
import { LAYER, RUMBLE_BODY, type RumbleBody } from '../profile';

export interface GameplayBody {
  mesh: Mesh;
  aggregate: PhysicsAggregate;
  body: PhysicsBody;
  /** The capsule's centre, world. */
  position(): Vector3;
  /** Where the feet are, world: the centre dropped straight down by the profile's centre height (whatever the tilt). */
  feet(): Vector3;
  velocity(): Vector3;
  /** The capsule's orientation (identity while upright). */
  rotation(): Quaternion;
  /** Whether the ground is within the probe distance below the feet (under the centre or anywhere near it in the footprint). */
  grounded(): boolean;
  /** Lock the body upright (no rotational inertia, orientation snapped to identity) or free it to tumble. */
  setUpright(locked: boolean): void;
  isUpright(): boolean;
  setAngularVelocity(v: Vector3): void;
  /** 1 under gravity, 0 weightless (a held body). */
  setGravityFactor(factor: number): void;
  /** The capsule's friction against whatever it touches (the profile's, unless a pushing contest lowers it). */
  setFriction(friction: number): void;
  /** Put the body back somewhere, upright and at rest (and colliding again, if it was parked). */
  teleport(feet: Vector3): void;
  /** Out of play: moved to `at`, weightless, at rest, colliding with nothing, until the next teleport. */
  park(at: Vector3): void;
  dispose(): void;
}

export function createGameplayBody(scene: Scene, name: string, feetAt: Vector3, profile: RumbleBody = RUMBLE_BODY): GameplayBody {
  const mesh = MeshBuilder.CreateCapsule(name, { height: profile.capsuleHeight, radius: profile.capsuleRadius, tessellation: 12, subdivisions: 2 }, scene);
  mesh.position.set(feetAt.x, feetAt.y + profile.capsuleCenterY, feetAt.z);
  mesh.isVisible = false;
  mesh.isPickable = false;
  const aggregate = new PhysicsAggregate(mesh, PhysicsShapeType.CAPSULE, { mass: profile.mass, friction: profile.friction, restitution: profile.restitution }, scene);
  const body = aggregate.body;
  body.setMotionType(PhysicsMotionType.DYNAMIC);
  body.setLinearDamping(profile.linearDamping);
  body.setAngularDamping(profile.angularDamping);
  aggregate.shape.filterMembershipMask = LAYER.character;
  aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
  // The node may be moved by hand (a respawn, a righting): let the body read it before each step.
  body.disablePreStep = false;
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();

  let upright = false;
  const setUpright = (locked: boolean) => {
    if (locked) {
      // No rotational inertia: the capsule cannot tip, spin or roll. Mass stays.
      body.setMassProperties({ mass: profile.mass, inertia: Vector3.Zero() });
      body.setAngularVelocity(Vector3.Zero());
      mesh.rotationQuaternion!.copyFrom(Quaternion.Identity());
    } else {
      const i = profile.tumbleInertia;
      body.setMassProperties({ mass: profile.mass, inertia: new Vector3(i.x, i.y, i.z) });
    }
    upright = locked;
  };
  setUpright(true);

  const engine = () => scene.getPhysicsEngine() as PhysicsEngine;
  const ray = new PhysicsRaycastResult();
  const from = new Vector3();
  const to = new Vector3();
  // Where the ground is looked for: under the centre, and under four points of the capsule's footprint, so a body resting on
  // the rim with its centre past the edge still stands (with the centre ray alone it was airborne there, its air control too
  // weak against the edge's friction to walk back or jump: stuck on the lip for good).
  const foot = profile.capsuleRadius * 0.6;
  const probes = [
    [0, 0],
    [foot, 0],
    [-foot, 0],
    [0, foot],
    [0, -foot],
  ];
  const grounded = () => {
    const c = mesh.position;
    for (const [dx, dz] of probes) {
      from.set(c.x + dx, c.y, c.z + dz);
      // From the centre's height to just under the feet; only the ground layer counts, so a body never stands on itself.
      to.set(c.x + dx, c.y - profile.capsuleCenterY - profile.groundProbe, c.z + dz);
      engine().raycastToRef(from, to, ray, { collideWith: LAYER.ground });
      if (ray.hasHit) return true;
    }
    return false;
  };

  return {
    mesh,
    aggregate,
    setFriction: (friction) => {
      aggregate.shape.material = { friction, restitution: profile.restitution };
    },
    body,
    position: () => mesh.position.clone(),
    feet: () => new Vector3(mesh.position.x, mesh.position.y - profile.capsuleCenterY, mesh.position.z),
    velocity: () => body.getLinearVelocity(),
    rotation: () => mesh.rotationQuaternion!.clone(),
    grounded,
    setUpright,
    isUpright: () => upright,
    setAngularVelocity: (v) => body.setAngularVelocity(v),
    setGravityFactor: (f) => body.setGravityFactor(f),
    teleport: (feet) => {
      setUpright(true);
      body.setGravityFactor(1);
      aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
      aggregate.shape.filterMembershipMask = LAYER.character;
      mesh.position.set(feet.x, feet.y + profile.capsuleCenterY, feet.z);
      body.setLinearVelocity(Vector3.Zero());
      body.setAngularVelocity(Vector3.Zero());
    },
    park: (at) => {
      setUpright(true);
      body.setGravityFactor(0);
      aggregate.shape.filterCollideMask = 0;
      aggregate.shape.filterMembershipMask = 0;
      mesh.position.copyFrom(at);
      body.setLinearVelocity(Vector3.Zero());
      body.setAngularVelocity(Vector3.Zero());
    },
    dispose: () => {
      aggregate.dispose();
      mesh.dispose();
    },
  };
}
