/**
 * M12 graphics quality as pure rules: what each choice draws on which
 * device (never from a user agent), and the automatic budget that follows
 * measured frames within the profile's bounds, with hysteresis.
 */
import { describe, expect, it } from 'vitest';
import { BUDGET, FrameBudget, PROFILES, parseQuality, profileFor, ratioFor } from './quality';
import { fovFor } from './camera';

describe('graphics profiles', () => {
  it('a chosen level is that level on any device; auto reads the pointer, cores and memory', () => {
    expect(profileFor('low', { coarse: false })).toBe(PROFILES.low);
    expect(profileFor('high', { coarse: true, cores: 2 })).toBe(PROFILES.high);
    expect(profileFor('auto', { coarse: false, cores: 8 })).toBe(PROFILES.high);
    expect(profileFor('auto', { coarse: true, cores: 8, memory: 4 })).toBe(PROFILES.medium);
    expect(profileFor('auto', { coarse: true, cores: 2 })).toBe(PROFILES.low);
    expect(profileFor('auto', { coarse: false, memory: 2 })).toBe(PROFILES.low);
  });

  it('every level keeps the shadows (a coarser map, never none), and costs less going down', () => {
    expect(PROFILES.high.shadowMap).toBeGreaterThan(PROFILES.medium.shadowMap);
    expect(PROFILES.medium.shadowMap).toBeGreaterThan(PROFILES.low.shadowMap);
    expect(PROFILES.low.shadowMap).toBeGreaterThan(0);
    expect(PROFILES.high.maxRatio).toBeGreaterThan(PROFILES.medium.maxRatio);
    expect(PROFILES.medium.maxRatio).toBeGreaterThan(PROFILES.low.maxRatio);
  });

  it('draws at the screen’s ratio within the cap, never above what the screen has', () => {
    expect(ratioFor(PROFILES.high, 3)).toBe(2);
    expect(ratioFor(PROFILES.high, 2)).toBe(2);
    expect(ratioFor(PROFILES.high, 1)).toBe(1);
    expect(ratioFor(PROFILES.medium, 3)).toBe(1.5);
    expect(ratioFor(PROFILES.low, 3)).toBe(1);
    expect(ratioFor(PROFILES.medium, 0)).toBe(1);
  });

  it('a saved choice is read back; anything else is auto', () => {
    expect(parseQuality('medium')).toBe('medium');
    expect(parseQuality('ultra')).toBe('auto');
    expect(parseQuality(null)).toBe('auto');
  });
});

describe('the frame budget (auto)', () => {
  const feed = (b: FrameBudget, dt: number, seconds: number) => {
    const out: number[] = [];
    for (let t = 0; t < seconds; t += dt) {
      const r = b.sample(dt);
      if (r !== null) out.push(r);
    }
    return out;
  };

  it('slow frames lower the ratio a step per window, down to the floor and no further', () => {
    const b = new FrameBudget(2, 1, 2);
    const changes = feed(b, 1 / 25, BUDGET.window * 10);
    expect(changes[0]).toBe(2 - BUDGET.step);
    expect(b.ratio).toBe(1);
    expect(Math.min(...changes)).toBe(1);
  });

  it('easy frames raise it back only after several easy windows, never past the cap', () => {
    const b = new FrameBudget(1, 1, 1.5);
    expect(feed(b, 1 / 60, BUDGET.window * (BUDGET.easyWindows - 0.5))).toEqual([]);
    feed(b, 1 / 60, BUDGET.window * 20);
    expect(b.ratio).toBe(1.5);
  });

  it('a steady 60 fps changes nothing at the cap, and stalls (a hidden tab) are not counted', () => {
    const b = new FrameBudget(2, 1, 2);
    expect(feed(b, 1 / 60, 20)).toEqual([]);
    expect(b.sample(3)).toBeNull();
    expect(b.sample(-1)).toBeNull();
    expect(b.sample(NaN)).toBeNull();
  });
});

describe('the field of view for a screen’s shape', () => {
  const V = 0.8;
  it('landscape keeps the vertical angle (more to the sides, the same height)', () => {
    for (const a of [1.25, 16 / 9, 2.16, 2.5]) expect(fovFor(a, V)).toEqual({ mode: 'vertical', fov: V });
  });
  it('a narrow (upright) screen keeps the arena’s width: the horizontal angle a 1.25 screen shows', () => {
    const f = fovFor(9 / 19.5, V);
    expect(f.mode).toBe('horizontal');
    expect(Math.tan(f.fov / 2)).toBeCloseTo(1.25 * Math.tan(V / 2), 9);
    expect(fovFor(0, V).mode).toBe('vertical');
  });
});
