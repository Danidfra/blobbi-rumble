import { describe, expect, it } from 'vitest';
import { FOLLOW, followCamera, followPose, framed, wantedCamera } from './camera';
import { PLAZA } from '../arena/lobbySpace';
import { CAMERA } from '../tuning';

describe('the shared camera', () => {
  it('two fighters: looks at the midpoint, from a distance that grows with the separation within bounds', () => {
    const near = wantedCamera([{ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    expect(near.x).toBe(0);
    expect(near.y).toBe(CAMERA.lift);
    expect(near.radius).toBeCloseTo(Math.max(CAMERA.minRadius, CAMERA.baseRadius + 2 * CAMERA.radiusPerMetre));
    const far = wantedCamera([{ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }]);
    expect(far.radius).toBe(CAMERA.maxRadius);
    const same = wantedCamera([{ x: 3, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }]);
    expect(same.radius).toBe(Math.max(CAMERA.minRadius, CAMERA.baseRadius));
    expect(same.x).toBe(3);
    expect(same.z).toBe(2);
  });
  it('does not dive after a body in the void', () => {
    const pose = wantedCamera([{ x: 0, y: -30, z: 0 }, { x: 0, y: 0, z: 0 }]);
    expect(pose.y).toBe(-1 + CAMERA.lift);
  });
  it('follows smoothly: part of the way each frame, all of the way eventually', () => {
    const from = { x: 0, y: 0, z: 0, radius: 8 };
    const to = { x: 10, y: 0, z: 0, radius: 12 };
    const one = followCamera(from, to, 1 / 60);
    expect(one.x).toBeGreaterThan(0);
    expect(one.x).toBeLessThan(10);
    let pose = from;
    for (let i = 0; i < 600; i++) pose = followCamera(pose, to, 1 / 60);
    expect(pose.x).toBeCloseTo(10, 3);
    expect(pose.radius).toBeCloseTo(12, 3);
  });

  it('frames every fighter still in: the centre of the box around them, the distance from its diagonal', () => {
    const four = [
      { x: -2, y: 0, z: -1 },
      { x: 2, y: 0, z: -1 },
      { x: -1, y: 0, z: 1 },
      { x: 0, y: 0, z: 1 },
    ];
    const pose = wantedCamera(four);
    // The box is x -2..2, z -1..1: its centre, not the mean of the four (which would sit at x -0.25).
    expect(pose.x).toBeCloseTo(0);
    expect(pose.z).toBeCloseTo(0);
    expect(pose.radius).toBeCloseTo(Math.min(CAMERA.maxRadius, CAMERA.baseRadius + Math.hypot(4, 2) * CAMERA.radiusPerMetre));
    // Three of them: the box shrinks, the view closes in.
    expect(wantedCamera(four.slice(1)).radius).toBeLessThan(pose.radius);
    // One left: framed alone, at the closest distance allowed.
    const one = wantedCamera([{ x: 1, y: 0, z: 1 }]);
    expect(one.x).toBe(1);
    expect(one.radius).toBe(Math.max(CAMERA.minRadius, CAMERA.baseRadius));
  });
  it('stops framing a body going over the rim or out of the round, and keeps the arena when they spread too wide', () => {
    expect(framed({ x: 0, y: 0, z: 0 }, true)).toBe(true);
    expect(framed({ x: 0, y: CAMERA.dropBelow - 0.1, z: 0 }, true)).toBe(false);
    expect(framed({ x: 0, y: 0, z: 0 }, false)).toBe(false);
    // Spread across the whole arena and beyond: never further than the bound, the target clamped over the arena.
    const wide = wantedCamera([
      { x: -7, y: 0, z: 0 },
      { x: 20, y: 0, z: 9 },
    ]);
    expect(wide.radius).toBe(CAMERA.maxRadius);
    expect(wide.x).toBe(CAMERA.bounds.x);
    expect(wide.z).toBe(CAMERA.bounds.z);
    // Nobody to frame: the middle of the arena.
    expect(wantedCamera([])).toMatchObject({ x: 0, z: 0 });
  });
});

describe('the plaza’s follow camera (L4)', () => {
  const bounds = { x: PLAZA.halfWidth, z: PLAZA.halfDepth };
  it('looks at the followed Blobbi from a set distance, a little above its feet', () => {
    expect(followPose({ x: 1.5, y: 0, z: -2 }, bounds)).toEqual({ x: 1.5, y: FOLLOW.lift, z: -2, radius: FOLLOW.radius });
  });
  it('keeps its look point over the plaza (just inside the fence), never out over the void', () => {
    const p = followPose({ x: 30, y: -6, z: -30 }, bounds);
    expect(p.x).toBe(PLAZA.halfWidth - FOLLOW.inset);
    expect(p.z).toBe(-(PLAZA.halfDepth - FOLLOW.inset));
    expect(p.y).toBe(FOLLOW.lift);
  });
  it('follows smoothly (the shared easing), and stays high enough to pass over the plaza’s decoration', () => {
    const a = followPose({ x: 0, y: 0, z: 0 }, bounds);
    const b = followPose({ x: 2, y: 0, z: 0 }, bounds);
    const eased = followCamera(a, b, 1 / 60);
    expect(eased.x).toBeGreaterThan(0);
    expect(eased.x).toBeLessThan(2);
    // The camera's lowest point over the look point: higher than the arch (2.2 m) and the lanterns (1.6 m) from the follow distance.
    expect(FOLLOW.radius * Math.cos(FOLLOW.maxBeta) + FOLLOW.lift).toBeGreaterThan(2.6);
  });
});
