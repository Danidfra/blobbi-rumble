import { describe, expect, it } from 'vitest';
import { followCamera, wantedCamera } from './camera';
import { CAMERA } from './tuning';

describe('the shared camera', () => {
  it('looks at the midpoint, from a distance that grows with the separation within bounds', () => {
    const near = wantedCamera({ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(near.x).toBe(0);
    expect(near.y).toBe(CAMERA.lift);
    expect(near.radius).toBeCloseTo(Math.max(CAMERA.minRadius, CAMERA.baseRadius + 2 * CAMERA.radiusPerMetre));
    const far = wantedCamera({ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 });
    expect(far.radius).toBe(CAMERA.maxRadius);
    const same = wantedCamera({ x: 3, y: 0, z: 2 }, { x: 3, y: 0, z: 2 });
    expect(same.radius).toBe(Math.max(CAMERA.minRadius, CAMERA.baseRadius));
    expect(same.x).toBe(3);
    expect(same.z).toBe(2);
  });
  it('does not dive after a body in the void', () => {
    const pose = wantedCamera({ x: 0, y: -30, z: 0 }, { x: 0, y: 0, z: 0 });
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
});
