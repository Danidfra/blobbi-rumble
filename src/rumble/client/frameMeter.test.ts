/**
 * L4.6-FIX1: the FPS counter's numbers come from the frames really drawn:
 * a steady 60 reads 60 and ~17 ms; one stall shows as the worst frame
 * however good the average is; a page that stopped drawing does not keep
 * reporting its last good second.
 */
import { describe, expect, it } from 'vitest';
import { FrameMeter } from './frameMeter';

describe('the frame meter (L4.6-FIX1)', () => {
  it('a steady 60 Hz reads 60 fps, worst ~16.7 ms', () => {
    const m = new FrameMeter();
    for (let i = 0; i <= 120; i++) m.frame(i * (1000 / 60));
    const r = m.read(120 * (1000 / 60));
    expect(r.fps).toBeCloseTo(60, 0);
    expect(r.worstMs).toBeCloseTo(16.67, 1);
  });

  it('one 300 ms stall in an otherwise smooth second is reported as the worst frame (an average would read ~50)', () => {
    const m = new FrameMeter();
    let t = 0;
    for (let i = 0; i < 60; i++) m.frame((t += 1000 / 60));
    m.frame((t += 300));
    for (let i = 0; i < 30; i++) m.frame((t += 1000 / 60));
    const r = m.read(t);
    expect(r.worstMs).toBeCloseTo(300, 0);
    expect(r.fps!).toBeLessThan(55);
  });

  it('only the last second counts, and a page that stopped drawing reports the gap', () => {
    const m = new FrameMeter();
    let t = 0;
    m.frame(t);
    m.frame((t += 400));
    for (let i = 0; i < 90; i++) m.frame((t += 1000 / 60));
    expect(m.read(t).worstMs).toBeLessThan(20);
    expect(m.read(t + 2500).worstMs).toBeGreaterThanOrEqual(2500);
    expect(new FrameMeter().read(0).fps).toBeNull();
  });
});
