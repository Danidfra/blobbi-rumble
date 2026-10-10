/**
 * M12.1, the touch camera look: one finger owns it, others cannot steal or
 * drive it; a drag is a yaw change (horizontal only); letting go drops what
 * is not taken; and whatever the camera's yaw, pushing the stick up still
 * walks away from the camera and right still goes to the camera's right
 * (movement is camera-relative, never inverted by a turned view).
 */
import { describe, expect, it } from 'vitest';
import { NET_BINDINGS, cameraRelative, moveIntent } from './input';
import { LOOK, LookDrag, easeYaw } from './look';
import { TouchPad } from './touch';

describe('the look drag', () => {
  it('one finger owns it: a second finger neither steals it nor turns the view', () => {
    const l = new LookDrag();
    expect(l.down(1, 100)).toBe(true);
    expect(l.down(2, 300)).toBe(false);
    l.move(2, 900);
    expect(l.take()).toBe(0);
    l.move(1, 150);
    expect(l.take()).toBeCloseTo(-50 * LOOK.radiansPerPixel, 9);
    l.up(2);
    expect(l.active).toBe(true);
    l.up(1);
    expect(l.active).toBe(false);
    // Free again: another finger may take it.
    expect(l.down(2, 0)).toBe(true);
  });

  it('a drag right and back left nets nothing; vertical movement does nothing (horizontal orbit only)', () => {
    const l = new LookDrag();
    l.down(4, 200);
    l.move(4, 260);
    l.move(4, 200);
    expect(l.take()).toBeCloseTo(0, 12);
    l.move(4, NaN);
    expect(l.take()).toBe(0);
  });

  it('cancel or releaseAll lets go, and what was not taken is dropped', () => {
    const l = new LookDrag();
    l.down(1, 0);
    l.move(1, 40);
    l.releaseAll();
    expect(l.take()).toBe(0);
    expect(l.active).toBe(false);
  });

  it('the camera eases to its target quickly, without overshoot', () => {
    let y = 0;
    const seen: number[] = [];
    for (let k = 0; k < 12; k++) {
      y = easeYaw(y, 1, 1 / 60);
      seen.push(y);
    }
    expect(seen.every((v, i) => v <= 1 && (i === 0 || v >= seen[i - 1]))).toBe(true);
    // Within a tenth of the way left after ~0.08 s: no felt lag.
    expect(easeYaw(easeYaw(easeYaw(easeYaw(easeYaw(0, 1, 1 / 60), 1, 1 / 60), 1, 1 / 60), 1, 1 / 60), 1, 1 / 60)).toBeGreaterThan(0.85);
  });
});

describe('movement after the camera turns', () => {
  it('stick up is away from the camera and stick right is the camera’s right, at every yaw', () => {
    const pad = new TouchPad();
    pad.radius = 60;
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * Math.PI * 2 - Math.PI;
      const forward = cameraRelative(0, 1, yaw);
      const right = cameraRelative(1, 0, yaw);
      pad.releaseAll();
      pad.stickDown(1, 100, 100);
      pad.stickMove(1, 100, 40);
      const up = moveIntent(new Set(), yaw, NET_BINDINGS, {}, pad.movement());
      expect(up.x * forward.x + up.z * forward.z).toBeCloseTo(1, 3);
      pad.stickMove(1, 160, 100);
      const r = moveIntent(new Set(), yaw, NET_BINDINGS, {}, pad.movement());
      expect(r.x * right.x + r.z * right.z).toBeCloseTo(1, 3);
      // Right is to the right of forward (no mirror): forward × right points down (y), as on screen.
      expect(forward.z * right.x - forward.x * right.z).toBeGreaterThan(0);
    }
  });
});
