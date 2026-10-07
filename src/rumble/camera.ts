/**
 * ONE SHARED CAMERA for two players: it looks at the midpoint of the two,
 * from a distance that grows with their separation within bounds, and
 * follows smoothly. Pure, apart from `applyCamera`.
 */
import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { CAMERA } from './tuning';

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

export function wantedCamera(a: Feet, b: Feet, c = CAMERA): CameraPose {
  const sep = Math.hypot(b.x - a.x, b.z - a.z);
  return {
    x: (a.x + b.x) / 2,
    // Bodies in the void drag the view down only a little: the arena stays readable.
    y: Math.max(-1, (a.y + b.y) / 2) + c.lift,
    z: (a.z + b.z) / 2,
    radius: Math.min(c.maxRadius, Math.max(c.minRadius, c.baseRadius + sep * c.radiusPerMetre)),
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
