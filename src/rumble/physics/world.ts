/**
 * HAVOK IN THE BROWSER: the wasm is located through Vite's asset URL so it
 * loads in development and in a build alike. The match builds its own
 * physics world from the instance (`sim/physics.ts`).
 */
import HavokPhysics from '@babylonjs/havok';
import havokWasmUrl from '@babylonjs/havok/lib/esm/HavokPhysics.wasm?url';
import type { HavokInstance } from '../sim/physics';

export function loadHavok(): Promise<HavokInstance> {
  return HavokPhysics({ locateFile: () => havokWasmUrl }) as Promise<HavokInstance>;
}
