/**
 * WHETHER TWO GAMEPLAY CAPSULES TOUCH, from their centres alone: both are
 * the same upright capsule, so the distance between their axis segments
 * decides it. Pure; the scene reads the centres from Havok and asks. A
 * tumbling body is treated as upright, which is close enough to decide a
 * pushing contest.
 */
import { RUMBLE_BODY, type RumbleBody } from '../profile';

export interface Centre {
  x: number;
  y: number;
  z: number;
}

/** The distance between two upright capsules' surfaces (negative when they overlap). */
export function capsuleGap(a: Centre, b: Centre, p: RumbleBody = RUMBLE_BODY): number {
  const half = Math.max(0, p.capsuleHeight / 2 - p.capsuleRadius);
  // Axis segments span centre.y ± half; the closest vertical offset is the gap left after the overlap of those spans.
  const dy = Math.max(0, Math.abs(a.y - b.y) - 2 * half);
  const planar = Math.hypot(a.x - b.x, a.z - b.z);
  return Math.hypot(planar, dy) - 2 * p.capsuleRadius;
}

export const capsulesTouch = (a: Centre, b: Centre, margin: number, p: RumbleBody = RUMBLE_BODY): boolean => capsuleGap(a, b, p) <= margin;

/**
 * For each body, the nearest other body its capsule touches, or -1. Bodies
 * given as null (out of the round) touch nothing. With several fighters a
 * body may touch more than one; its pushing contest is with the nearest.
 */
export function nearestContacts(centres: readonly (Centre | null)[], margin: number, p: RumbleBody = RUMBLE_BODY): number[] {
  return centres.map((a, i) => {
    if (!a) return -1;
    let best = -1;
    let bestGap = Infinity;
    centres.forEach((b, j) => {
      if (j === i || !b) return;
      const gap = capsuleGap(a, b, p);
      if (gap <= margin && gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    });
    return best;
  });
}
