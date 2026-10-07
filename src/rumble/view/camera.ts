/**
 * ONE SHARED CAMERA for every fighter still in the round: it looks at the
 * centre of the box around them, from a distance that grows with the size
 * of that box within bounds, and follows smoothly. A body that is going
 * over the rim stops counting as soon as it drops below the floor, and an
 * eliminated one never counts. The target stays over the arena: when the
 * fighters spread wider than the distance bound can show, the view keeps
 * the playable arena rather than chasing the middle of a void. Pure, apart
 * from `applyCamera`.
 */
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { CAMERA } from '../tuning';

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface Feet {
  x: number;
  y: number;
  z: number;
}

/** Whether a body's feet still count for the camera: in the round, and not yet below the floor. */
export const framed = (feet: Feet, alive: boolean, c = CAMERA) => alive && feet.y > c.dropBelow;

export function wantedCamera(subjects: readonly Feet[], c = CAMERA): CameraPose {
  if (subjects.length === 0) return { x: 0, y: c.lift, z: 0, radius: c.baseRadius };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let y = 0;
  for (const s of subjects) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z);
    maxZ = Math.max(maxZ, s.z);
    y += s.y;
  }
  y /= subjects.length;
  // The box's diagonal: for two fighters, their separation.
  const spread = Math.hypot(maxX - minX, maxZ - minZ);
  const clamp = (v: number, b: number) => Math.max(-b, Math.min(b, v));
  return {
    x: clamp((minX + maxX) / 2, c.bounds.x),
    // Bodies in the void drag the view down only a little: the arena stays readable.
    y: Math.max(-1, y) + c.lift,
    z: clamp((minZ + maxZ) / 2, c.bounds.z),
    radius: Math.min(c.maxRadius, Math.max(c.minRadius, c.baseRadius + spread * c.radiusPerMetre)),
  };
}

export function followCamera(current: CameraPose, wanted: CameraPose, dt: number, c = CAMERA): CameraPose {
  const kt = 1 - Math.exp(-dt * c.targetFollow);
  const kr = 1 - Math.exp(-dt * c.radiusFollow);
  return {
    x: current.x + (wanted.x - current.x) * kt,
    y: current.y + (wanted.y - current.y) * kt,
    z: current.z + (wanted.z - current.z) * kt,
    radius: current.radius + (wanted.radius - current.radius) * kr,
  };
}

export function applyCamera(camera: ArcRotateCamera, pose: CameraPose) {
  camera.target.set(pose.x, pose.y, pose.z);
  camera.radius = pose.radius;
}
