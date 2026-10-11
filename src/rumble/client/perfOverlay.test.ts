/** The performance overlay's measurement and text (`perfOverlay.ts`), without a browser. */
import { describe, expect, it } from 'vitest';
import { FrameMeter, perfLines } from './perfOverlay';

describe('the frame meter', () => {
  it('measures the frame intervals of the last second: FPS, mean and worst', () => {
    const m = new FrameMeter(1000);
    expect(m.stats).toEqual({ fps: 0, mean: 0, worst: 0 });
    let t = 0;
    for (let i = 0; i < 61; i++) m.tick((t = i * (1000 / 60)));
    expect(m.stats.fps).toBeCloseTo(60, 0);
    expect(m.stats.mean).toBeCloseTo(16.67, 1);
    // One long frame shows as the worst, then ages out of the window.
    m.tick((t += 100));
    expect(m.stats.worst).toBeCloseTo(100, 5);
    for (let i = 0; i < 120; i++) m.tick((t += 1000 / 60));
    expect(m.stats.worst).toBeLessThan(17);
    expect(m.stats.fps).toBeCloseTo(60, 0);
  });
});

describe('the overlay text', () => {
  const base = { fps: 59.6, frameMs: 16.78, worstMs: 33.4, drawCalls: 143.2, triangles: 52_345, width: 1920, height: 1080, scale: 1.5, webgl: 2 };
  it('shows FPS, frame time, draw calls, triangles, resolution, WebGL and the latency', () => {
    expect(perfLines({ ...base, rtt: 42.4 })).toEqual(['60 fps · frame 16.8 ms (worst 33.4)', '143 draw calls · 52.3k triangles', '1920×1080 px (×1.50) · WebGL 2', 'latency 42 ms']);
  });
  it('says when there is no latency yet, and when the game is offline', () => {
    expect(perfLines({ ...base, rtt: Number.NaN })[3]).toBe('latency …');
    expect(perfLines({ ...base })[3]).toBe('offline game');
    expect(perfLines({ ...base, webgl: 1, triangles: 900 })[1]).toBe('143 draw calls · 900 triangles');
  });
});
