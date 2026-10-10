/**
 * M11F as pure logic: what throw is accepted and why one is not, where a
 * peel lands, how peels age and go, and who slips on one.
 */
import { describe, expect, it } from 'vitest';
import { FACTORY, SKYFALL } from '../arena/arenas';
import { BANANAS } from '../tuning';
import { createThrowers, judgeThrow, resetThrowers, slips, tickBananas, type Banana } from './bananas';

const ctx = (over: Partial<Parameters<typeof judgeThrow>[4]> = {}) => ({ playing: true, eliminated: true, alive: 3, platforms: SKYFALL.platforms, ...over });

describe('judging a throw', () => {
  it('accepts an out player’s throw onto solid floor, at the floor’s height, within the budget, the cooldown and the cap', () => {
    const [t] = createThrowers(1);
    const r = judgeThrow(t, 0, 0, 0, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.banana).toEqual({ x: 0, y: BANANAS.height, z: 0, age: 0 });
    // On the east island (y 0.5): the peel sits on it.
    const up = judgeThrow(t, 0, 8.6, 1.6, ctx());
    expect(up.ok && up.banana.y).toBeCloseTo(0.5 + BANANAS.height, 6);
  });

  it('refuses: a bad target, between rounds, a player still in, too few left in the round, spent, cooling down, crowded, off the floor, a piece that is gone', () => {
    const [t] = createThrowers(1);
    const why = (r: ReturnType<typeof judgeThrow>) => (r.ok ? 'ok' : r.reason);
    expect(why(judgeThrow(t, 0, NaN, 0, ctx()))).toBe('bad target');
    expect(why(judgeThrow(t, 0, 'x' as unknown as number, 0, ctx()))).toBe('bad target');
    expect(why(judgeThrow(t, 0, 0, 0, ctx({ playing: false })))).toBe('phase');
    expect(why(judgeThrow(t, 0, 0, 0, ctx({ eliminated: false })))).toBe('in play');
    expect(why(judgeThrow(t, 0, 0, 0, ctx({ alive: BANANAS.minAlive - 1 })))).toBe('few alive');
    expect(why(judgeThrow({ thrown: BANANAS.perRound, since: 99 }, 0, 0, 0, ctx()))).toBe('spent');
    expect(why(judgeThrow({ thrown: 1, since: BANANAS.cooldown - 0.1 }, 0, 0, 0, ctx()))).toBe('cooldown');
    expect(why(judgeThrow(t, BANANAS.maxActive, 0, 0, ctx()))).toBe('crowded');
    expect(why(judgeThrow(t, 0, 0, 30, ctx()))).toBe('off floor');
    expect(why(judgeThrow(t, 0, 2, -4.95, ctx()))).toBe('off floor');
    const pad = SKYFALL.platforms[SKYFALL.dynamics[2].platform];
    expect(why(judgeThrow(t, 0, pad.x, pad.z, ctx()))).toBe('ok');
    expect(why(judgeThrow(t, 0, pad.x, pad.z, ctx({ unusable: (i) => i === SKYFALL.dynamics[2].platform })))).toBe('off floor');
    // The factory's belts and crate are floor too.
    expect(why(judgeThrow(t, 0, 0, 2.3, ctx({ platforms: FACTORY.platforms })))).toBe('ok');
  });
});

describe('peels on the floor', () => {
  it('age and go after their time, oldest first; throwers’ cooldowns run; a reset forgets the throws', () => {
    const bananas: Banana[] = [
      { x: 0, y: 0, z: 0, owner: 0, age: BANANAS.lifetime - 0.5 },
      { x: 1, y: 0, z: 0, owner: 1, age: 1 },
    ];
    const throwers = createThrowers(2);
    throwers[0].thrown = 2;
    throwers[0].since = 0;
    expect(tickBananas(bananas, throwers, 0.4)).toEqual([]);
    expect(tickBananas(bananas, throwers, 0.2)).toEqual([0]);
    expect(bananas).toHaveLength(1);
    expect(bananas[0].owner).toBe(1);
    expect(throwers[0].since).toBeCloseTo(0.6, 6);
    resetThrowers(throwers);
    expect(throwers[0]).toEqual({ thrown: 0, since: 99 });
  });

  it('a fighter moving over a peel slips; standing on one, or walking past, or off its feet, does not; two cannot slip on the same peel', () => {
    const bananas: Banana[] = [{ x: 2, y: BANANAS.height, z: 0, owner: 3, age: 1 }];
    const walker = (x: number, speed = 2, canSlip = true, y = 0) => ({ x, y, z: 0, speed, canSlip });
    expect(slips(bananas, [walker(2.1), walker(2.7), walker(2, 0.2), walker(2, 2, false), null, walker(2, 2, true, 1)])).toEqual([0, -1, -1, -1, -1, -1]);
    expect(slips(bananas, [walker(2.1), walker(1.9)])).toEqual([0, -1]);
  });
});
