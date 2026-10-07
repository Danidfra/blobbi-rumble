/**
 * HAVOK IN NODE: the wasm read from the installed package, for tests and
 * any future server. Node-only (it reads a file); the browser client loads
 * Havok through `physics/world.ts` instead.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import HavokPhysics from '@babylonjs/havok';
import type { HavokInstance } from './physics';

let loading: Promise<HavokInstance> | null = null;

export function loadHavokNode(): Promise<HavokInstance> {
  if (!loading) {
    const require = createRequire(import.meta.url);
    const file = readFileSync(require.resolve('@babylonjs/havok/lib/esm/HavokPhysics.wasm'));
    const wasmBinary = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    loading = HavokPhysics({ wasmBinary }) as Promise<HavokInstance>;
  }
  return loading;
}
