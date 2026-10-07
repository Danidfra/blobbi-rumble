/**
 * THE PHYSICS WORLD: Babylon's official Havok integration, enabled on a
 * scene. The wasm is located through Vite's asset URL so it loads in
 * development and in a build alike.
 */
import HavokPhysics from '@babylonjs/havok';
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';

export async function enableHavok(scene: Scene, gravity: number): Promise<HavokPlugin> {
  const havok = await HavokPhysics({ locateFile: () => havokWasmUrl });
  // The world steps by the frame's real delta (clamped by Babylon), so play speed does not follow the refresh rate.
  const plugin = new HavokPlugin(true, havok);
  scene.enablePhysics(new Vector3(0, -gravity, 0), plugin);
  return plugin;
}
