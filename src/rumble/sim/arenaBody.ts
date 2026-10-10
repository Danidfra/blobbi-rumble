/**
 * THE ARENA'S COLLISION (M11A): one static box on the ground layer per
 * platform of the arena's definition, at its top height, with the floor's
 * friction. Nothing stops a body going over a rim. A DYNAMIC platform
 * (M11B) is an animated body instead, so the match can lower it while it
 * falls (what stands on it goes with it) and take it out of play when it
 * is gone: its collider is exactly where the view draws it, or nowhere.
 * What the arena looks like is the client's (`view/arenaView.ts`).
 *
 * M12.1: a piece only ever SWEEPS DOWN (a real fall, with the velocity
 * that carries what stands on it). Anything else is a teleport at rest: a
 * piece going back up (a round reset in the middle of a fall, its return
 * after a hole) is put there, never swept there, and a piece that does not
 * move this step has no velocity. Havok keeps an animated body's velocity
 * after a target transform; a reset mid-fall swept a tile up 1.76 m in one
 * step (+106 m/s) and left it at rest with that velocity, so every fighter
 * that touched the tile afterwards was hit by a floor rising at 100 m/s and
 * flung 50 m/s into the air.
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsMotionType, PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import type { ArenaDef } from '../arena/arenas';
import { LAYER } from '../profile';

export const FLOOR_FRICTION = 0.8;
/** Ice has this much grip for the floor's part (the body's own friction is lowered too, by the match). */
export const ICE_FLOOR_FRICTION = 0.05;

export interface ArenaBody {
  /** Put a dynamic piece `drop` metres below its rest; `solid` false takes it out of play entirely. */
  setPiece(dynamicIndex: number, drop: number, solid: boolean): void;
  /** A dynamic piece's velocity as Havok has it (for checks), m/s. */
  pieceVelocity(dynamicIndex: number): { x: number; y: number; z: number } | null;
  dispose(): void;
}

export function createArenaBody(scene: Scene, def: ArenaDef): ArenaBody {
  const disposables: { dispose(): void }[] = [];
  const plugin = scene.getPhysicsEngine()!.getPhysicsPlugin() as HavokPlugin;
  const dynamicOf = new Map<number, number>();
  def.dynamics.forEach((d, i) => dynamicOf.set(d.platform, i));
  const pieces: { mesh: Mesh; aggregate: PhysicsAggregate; rest: Vector3; solid: boolean; moving: boolean }[] = [];
  const identity = Quaternion.Identity();
  def.platforms.forEach((r, i) => {
    const mesh = MeshBuilder.CreateBox(`arena-${def.id}-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: r.thickness }, scene);
    mesh.position.set(r.x, r.y - r.thickness / 2, r.z);
    mesh.isVisible = false;
    const friction = r.kind === 'ice' ? ICE_FLOOR_FRICTION : FLOOR_FRICTION;
    const aggregate = new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 0, friction, restitution: 0 }, scene);
    aggregate.shape.filterMembershipMask = LAYER.ground;
    aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
    disposables.push(aggregate, mesh);
    const dyn = dynamicOf.get(i);
    if (dyn !== undefined) {
      // Animated: Havok moves it to where it is told, so a body standing on it is carried down with it.
      aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);
      aggregate.body.disablePreStep = true;
      if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
      pieces[dyn] = { mesh, aggregate, rest: mesh.position.clone(), solid: true, moving: false };
    }
  });
  /** Put a piece at `target` with no velocity at all (a teleport, never a sweep). */
  const place = (p: (typeof pieces)[number], target: Vector3) => {
    const body = p.aggregate.body;
    // Re-aim the animated body's target where it is going, then zero what that leaves, then teleport.
    body.setTargetTransform(target, identity);
    body.setLinearVelocity(Vector3.Zero());
    body.setAngularVelocity(Vector3.Zero());
    p.mesh.position.copyFrom(target);
    body.disablePreStep = false;
    plugin.setPhysicsBodyTransformation(body, p.mesh);
    body.disablePreStep = true;
    p.moving = false;
  };
  return {
    setPiece: (dynamicIndex, drop, solid) => {
      const p = pieces[dynamicIndex];
      if (!p) return;
      const target = new Vector3(p.rest.x, p.rest.y - drop, p.rest.z);
      if (solid !== p.solid) {
        p.solid = solid;
        // Out of play: collides with nothing (and sits far below); back: a teleport to rest, colliding again.
        p.aggregate.shape.filterCollideMask = solid ? LAYER.ground | LAYER.character : 0;
        place(p, target);
        return;
      }
      if (!solid) return;
      const dy = target.y - p.mesh.position.y;
      if (Math.abs(dy) < 1e-4) {
        // Not moving this step: no velocity left over from the last one.
        if (p.moving) place(p, target);
        return;
      }
      // Up (a reset mid-fall): put back, never swept up through whatever is above it.
      if (dy > 0) {
        place(p, target);
        return;
      }
      // Down: a real fall, swept, so what stands on it goes down with it.
      p.mesh.position.copyFrom(target);
      p.aggregate.body.setTargetTransform(target, identity);
      p.moving = true;
    },
    pieceVelocity: (dynamicIndex) => {
      const p = pieces[dynamicIndex];
      if (!p) return null;
      const v = p.aggregate.body.getLinearVelocity();
      return { x: v.x, y: v.y, z: v.z };
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
