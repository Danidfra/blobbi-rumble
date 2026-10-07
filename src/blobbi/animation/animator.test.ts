import { describe, expect, it } from 'vitest';
import { BlobbiAnimator } from './animator';

const step = (a: BlobbiAnimator, frames: number, input: Partial<Parameters<BlobbiAnimator['update']>[0]>) => {
  let pose = a.pose;
  for (let i = 0; i < frames; i++) pose = a.update({ dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0, ...input });
  return pose;
};

describe('animator', () => {
  it('chooses idle, walk and run from the speed, and jump, fall and land from the air', () => {
    const a = new BlobbiAnimator();
    step(a, 5, {});
    expect(a.state).toBe('idle');
    step(a, 5, { speed: 1 });
    expect(a.state).toBe('walk');
    step(a, 5, { speed: 3 });
    expect(a.state).toBe('run');
    step(a, 1, { jumped: true, grounded: false, verticalVelocity: 4 });
    expect(a.state).toBe('jump');
    step(a, 5, { grounded: false, verticalVelocity: -3 });
    expect(a.state).toBe('fall');
    step(a, 1, { landed: true, impact: 5 });
    expect(a.state).toBe('land');
    step(a, 30, {});
    expect(a.state).toBe('idle');
  });

  it('a walk moves the feet against each other and keeps every scale sane', () => {
    const a = new BlobbiAnimator();
    const pose = step(a, 40, { speed: 1.2 });
    expect(Math.sign(pose.leftFoot.forward)).not.toBe(Math.sign(pose.rightFoot.forward));
    for (const s of [pose.body.scaleX, pose.body.scaleY, pose.body.scaleZ]) {
      expect(s).toBeGreaterThan(0.7);
      expect(s).toBeLessThan(1.3);
    }
  });

  it('a pinned state stays pinned whatever the input says', () => {
    const a = new BlobbiAnimator();
    a.setState('run');
    step(a, 10, { speed: 0 });
    expect(a.state).toBe('run');
    a.setState(null);
    step(a, 10, { speed: 0 });
    expect(a.state).toBe('idle');
  });
});
