/**
 * M12.1: what you carry is drawn in your hands. Your fighter is drawn where
 * your prediction has it, the rest from the server a moment ago; a carried
 * body keeps the server's offset from you at that moment, relative to where
 * you are drawn, and nothing else moves.
 */
import { describe, expect, it } from 'vitest';
import type { FighterSnapshot } from '../sim/snapshot';
import { attachCarried } from './carryView';

const f = (id: string, x: number, y: number, z: number, patch: Partial<FighterSnapshot> = {}) => ({ id, position: { x, y, z }, eliminated: false, ...patch }) as FighterSnapshot;

describe('a carried body drawn with its carrier', () => {
  it('keeps the interpolated offset from the carrier, relative to where the carrier is drawn', () => {
    const interp = [f('P1', 1, 0.5, 0), f('P2', 1.9, 1.05, 0), f('P3', -3, 0.5, 2)];
    // You (P1) are drawn 0.3 m further on than the interpolated state (prediction).
    const drawn = [f('P1', 1.3, 0.5, 0.1), interp[1], interp[2]];
    const out = attachCarried(drawn, interp, 0, 'P2');
    expect(out[1].position.x).toBeCloseTo(2.2, 9);
    expect(out[1].position.y).toBeCloseTo(1.05, 9);
    expect(out[1].position.z).toBeCloseTo(0.1, 9);
    expect(out[0]).toBe(drawn[0]);
    expect(out[2]).toBe(drawn[2]);
  });

  it('changes nothing when you hold nobody, the held body is unknown or out, or would be you', () => {
    const interp = [f('P1', 0, 0.5, 0), f('P2', 1, 1, 0, { eliminated: true })];
    const drawn = [f('P1', 0.2, 0.5, 0), interp[1]];
    for (const holding of [null, 'P9', 'P2', 'P1']) {
      const out = attachCarried(drawn, interp, 0, holding);
      expect(out.map((x) => x.position)).toEqual(drawn.map((x) => x.position));
    }
  });
});
