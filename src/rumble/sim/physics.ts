/**
 * THE MATCH'S PHYSICS WORLD: Havok through Babylon's physics v2, on a scene
 * of its own that is never drawn. Havok needs a Babylon scene to live in
 * and transform nodes for its bodies; nothing else of Babylon's renderer:
 * the scene runs on a `NullEngine` (no canvas, no GPU, no DOM), in a
 * browser and in Node alike. It is stepped only by `step(dt)`, never by a
 * render loop.
 *
 * The Havok instance is passed in: the browser loads its wasm through
 * Vite's asset URL, Node from the package's file (`havokNode.ts`).
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import type { PhysicsEngine } from '@babylonjs/core/Physics/v2/physicsEngine';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';

/** What `HavokPhysics()` resolves to. */
export type HavokInstance = ConstructorParameters<typeof HavokPlugin>[1];

export interface PhysicsWorld {
  scene: Scene;
  plugin: HavokPlugin;
  /** Advance the world by `dt` seconds (Babylon bounds a single step to 0.1 s). */
  step(dt: number): void;
  dispose(): void;
}

export function createPhysicsWorld(havok: HavokInstance, gravity: number): PhysicsWorld {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  // The world steps by the dt it is given.
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -gravity, 0), plugin);
  const physics = scene.getPhysicsEngine() as PhysicsEngine;
  return {
    scene,
    plugin,
    step: (dt) => physics._step(dt),
    dispose: () => {
      scene.dispose();
      engine.dispose();
    },
  };
}
