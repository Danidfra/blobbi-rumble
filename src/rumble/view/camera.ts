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

/** The camera's numbers (`CAMERA` in tuning.ts), with an arena's bounds and distance limit (M11A). */
export interface CameraRules {
  alpha: number;
  beta: number;
  baseRadius: number;
  radiusPerMetre: number;
  minRadius: number;
  maxRadius: number;
  targetFollow: number;
  radiusFollow: number;
  lift: number;
  dropBelow: number;
  bounds: { x: number; z: number };
}

/** Whether a body's feet still count for the camera: in the round, and not yet below the floor. */
export const framed = (feet: Feet, alive: boolean, c: CameraRules = CAMERA) => alive && feet.y > c.dropBelow;

export function wantedCamera(subjects: readonly Feet[], c: CameraRules = CAMERA): CameraPose {
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

export function followCamera(current: CameraPose, wanted: CameraPose, dt: number, c: CameraRules = CAMERA): CameraPose {
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

/**
 * M12: the field of view for a screen's shape. Babylon fixes the vertical
 * angle, so a landscape screen (the intended one) only ever sees more to
 * the sides. A screen narrower than `minAspect` (a phone held upright)
 * would lose the arena's sides instead: below it, the horizontal angle is
 * fixed at what `minAspect` shows, so the whole width stays in view and
 * the view grows taller rather than narrower.
 */
export function fovFor(aspect: number, verticalFov: number, minAspect = 1.25): { mode: 'vertical' | 'horizontal'; fov: number } {
  if (!(aspect > 0) || aspect >= minAspect) return { mode: 'vertical', fov: verticalFov };
  return { mode: 'horizontal', fov: 2 * Math.atan(minAspect * Math.tan(verticalFov / 2)) };
}
