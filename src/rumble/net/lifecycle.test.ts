/**
 * The lobby lifecycle (L1) as pure state: when a countdown starts and is
 * cancelled, when the swap and play happen, the results and the way back,
 * every change announced ahead in ticks.
 */
import { describe, expect, it } from 'vitest';
import { LIFECYCLE, Lifecycle, minHumans, type LifecycleView } from './lifecycle';
import type { MatchResults } from './protocol';

const HZ = 60;
const depart = Math.round(LIFECYCLE.departSeconds * HZ);
const arrive = Math.round(LIFECYCLE.arriveSeconds * HZ);
const results: MatchResults = { winner: 'P1', reason: 'won', arena: 'floating-islands-classic', fighters: [] };
const view = (humans: number[], bots = true): LifecycleView => ({ humans, bots });

describe('the lobby lifecycle (L1)', () => {
  it('needs one person with bots, two without', () => {
    expect(minHumans(true)).toBe(1);
    expect(minHumans(false)).toBe(2);
    const l = new Lifecycle(HZ, 0);
    expect(l.canStart(view([]))).toBe(false);
    expect(l.canStart(view([1]))).toBe(true);
    expect(l.canStart(view([1], false))).toBe(false);
    expect(l.canStart(view([1, 2], false))).toBe(true);
  });

  it('waits in the lobby with nobody seated, and starts a countdown announced in ticks once the minimum is met', () => {
    const l = new Lifecycle(HZ, 100);
    expect(l.advance(101, view([]))).toEqual([]);
    expect(l.phase).toBe('lobby');
    const v0 = l.version;
    l.advance(102, view([7]));
    expect(l.phase).toBe('countdown');
    expect(l.version).toBeGreaterThan(v0);
    expect(l.since).toBe(102);
    expect(l.transition).toEqual({ kind: 'toArena', departAt: 102, swapAt: 102 + depart, arriveBy: 102 + depart + arrive });
    expect(l.deadline).toBe(102 + depart + arrive);
    expect(l.lineup).toEqual([7]);
  });

  it('swaps once on the swap tick, then plays on the deadline', () => {
    const l = new Lifecycle(HZ, 0);
    l.advance(0, view([1]));
    const fx: string[] = [];
    for (let t = 1; t <= depart + arrive; t++) fx.push(...l.advance(t, view([1])).map((e) => `${t}:${e}`));
    expect(fx).toEqual([`${depart}:swapIn`, `${depart + arrive}:play`]);
    expect(l.phase).toBe('playing');
    expect(l.deadline).toBeNull();
    expect(l.transition).toBeNull();
  });

  it('cancels the countdown when someone it started with leaves, or the room falls below the minimum', () => {
    const a = new Lifecycle(HZ, 0);
    a.advance(0, view([1, 2], false));
    expect(a.phase).toBe('countdown');
    a.advance(5, view([1], false));
    expect(a.phase).toBe('lobby');
    expect(a.transition).toBeNull();

    // With bots the minimum still holds, but the countdown was made with both: one leaving cancels it, then it starts again with who is left.
    const b = new Lifecycle(HZ, 0);
    b.advance(0, view([1, 2]));
    b.advance(depart + 3, view([2]));
    expect(b.phase).toBe('lobby');
    b.advance(depart + 4, view([2]));
    expect(b.phase).toBe('countdown');
    expect(b.lineup).toEqual([2]);
  });

  it('a newcomer does not disturb a countdown (it is not in the lineup)', () => {
    const l = new Lifecycle(HZ, 0);
    l.advance(0, view([1]));
    l.advance(1, view([1, 9]));
    expect(l.phase).toBe('countdown');
  });

  it('shows the results, departs before the swap back, returns to the lobby on the deadline, and stops announcing after the arrival', () => {
    const l = new Lifecycle(HZ, 0);
    l.advance(0, view([1]));
    for (let t = 1; t <= depart + arrive; t++) l.advance(t, view([1]));
    const end = 1000;
    expect(l.finish(end, results)).toBe(true);
    const back = end + LIFECYCLE.resultsSeconds * HZ;
    expect(l.phase).toBe('results');
    expect(l.results).toEqual(results);
    expect(l.deadline).toBe(back);
    expect(l.transition).toEqual({ kind: 'toLobby', departAt: back - depart, swapAt: back, arriveBy: back + arrive });
    expect(l.advance(back - 1, view([1]))).toEqual([]);
    expect(l.advance(back, view([1]))).toEqual(['swapOut']);
    expect(l.phase).toBe('lobby');
    // The arrival is still announced; nobody can start before it is over… and the results stay until the next countdown.
    expect(l.transition?.kind).toBe('toLobby');
    expect(l.results).toEqual(results);
    expect(l.advance(back + arrive - 1, view([1]))).toEqual([]);
    expect(l.phase).toBe('lobby');
    l.advance(back + arrive, view([1]));
    expect(l.phase).toBe('countdown');
    expect(l.results).toBeNull();
  });

  it('ignores a finish outside play and a start outside the lobby', () => {
    const l = new Lifecycle(HZ, 0);
    expect(l.finish(1, results)).toBe(false);
    expect(l.start(1, view([1]))).toBe(true);
    expect(l.start(2, view([1]))).toBe(false);
    expect(l.finish(3, results)).toBe(false);
  });
});
