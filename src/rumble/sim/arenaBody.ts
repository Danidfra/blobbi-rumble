/**
 * THE ARENA'S COLLISION: three static boxes on the ground layer, one per
 * floor slab of `arena/layout.ts`, with the floor's friction. Nothing
 * stops a body going over the rim. What the arena looks like is the
 * client's (`view/arenaView.ts`).
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Scene } from '@babylonjs/core/scene';
import { ARENA, floorSlabs } from '../arena/layout';
import { LAYER } from '../profile';

export const FLOOR_FRICTION = 0.8;

export function createArenaBody(scene: Scene): { dispose(): void } {
  const disposables: { dispose(): void }[] = [];
  floorSlabs().forEach((r, i) => {
    const slab = MeshBuilder.CreateBox(`arena-slab-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: ARENA.thickness }, scene);
    slab.position.set(r.x, -ARENA.thickness / 2, r.z);
    slab.isVisible = false;
    const aggregate = new PhysicsAggregate(slab, PhysicsShapeType.BOX, { mass: 0, friction: FLOOR_FRICTION, restitution: 0 }, scene);
    aggregate.shape.filterMembershipMask = LAYER.ground;
    aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
    disposables.push(aggregate, slab);
  });
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
