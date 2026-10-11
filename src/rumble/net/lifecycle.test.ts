/**
 * The lobby lifecycle (L1, L2) as pure state: readiness and the automatic
 * start, the owner's start and its limits, cancellation, ownership and its
 * handoff, the swap and play, the results and the way back, every change
 * announced ahead in ticks.
 */
import { describe, expect, it } from 'vitest';
import { LIFECYCLE, Lifecycle, minHumans, type LifecycleView } from './lifecycle';
import type { MatchResults } from './protocol';

const HZ = 60;
const depart = Math.round(LIFECYCLE.departSeconds * HZ);
const arrive = Math.round(LIFECYCLE.arriveSeconds * HZ);
const results: MatchResults = { winner: 'P1', reason: 'won', arena: 'floating-islands-classic', fighters: [] };
const view = (humans: number[], bots = true, watchers: number[] = []): LifecycleView => ({ humans, members: [...humans, ...watchers], bots });
/** A lifecycle with these people present and ready. */
const readyRoom = (humans: number[], bots = true, start = 0) => {
  const l = new Lifecycle(HZ, start);
  for (const c of humans) l.join(c);
  for (const c of humans) expect(l.setReady(c, true, view(humans, bots))).toBeNull();
  return l;
};
/** Through the countdown into play. */
const play = (l: Lifecycle, v: LifecycleView, from = 0) => {
  l.advance(from, v);
  for (let t = from + 1; t <= from + depart + arrive; t++) l.advance(t, v);
  expect(l.phase).toBe('playing');
};

describe('starting a match (L1, L2)', () => {
  it('needs one person with bots, two without', () => {
    expect(minHumans(true)).toBe(1);
    expect(minHumans(false)).toBe(2);
    const l = new Lifecycle(HZ, 0);
    expect(l.canStart(view([]))).toBe(false);
    expect(l.canStart(view([1]))).toBe(true);
    expect(l.canStart(view([1], false))).toBe(false);
    expect(l.canStart(view([1, 2], false))).toBe(true);
  });

  it('waits until every seated person is ready, then starts by itself, announced in ticks', () => {
    const l = new Lifecycle(HZ, 100);
    l.join(1);
    l.join(2);
    expect(l.advance(101, view([1, 2]))).toEqual([]);
    l.setReady(1, true, view([1, 2]));
    l.advance(102, view([1, 2]));
    expect(l.phase).toBe('lobby');
    const v0 = l.version;
    l.setReady(2, true, view([1, 2]));
    expect(l.version).toBeGreaterThan(v0);
    l.advance(103, view([1, 2]));
    expect(l.phase).toBe('countdown');
    expect(l.forced).toBe(false);
    expect(l.transition).toEqual({ kind: 'toArena', departAt: 103, swapAt: 103 + depart, arriveBy: 103 + depart + arrive });
    expect(l.deadline).toBe(103 + depart + arrive);
    expect(l.lineup).toEqual([1, 2]);
  });

  it('one ready person starts against bots; without bots, one ready person waits for a second', () => {
    const withBots = readyRoom([1]);
    withBots.advance(1, view([1]));
    expect(withBots.phase).toBe('countdown');
    const alone = readyRoom([1], false);
    alone.advance(1, view([1], false));
    expect(alone.phase).toBe('lobby');
  });

  it('only a seated person may be ready, and only in the lobby or the countdown', () => {
    const l = new Lifecycle(HZ, 0);
    l.join(1);
    l.join(9);
    expect(l.setReady(9, true, view([1], true, [9]))).toBe('spectator');
    expect(l.ready.has(9)).toBe(false);
    expect(l.setReady(1, true, view([1], true, [9]))).toBeNull();
    play(l, view([1], true, [9]), 1);
    expect(l.setReady(1, false, view([1], true, [9]))).toBe('phase');
  });

  it('the owner may start while some are not ready, never below the minimum; nobody else may', () => {
    const l = new Lifecycle(HZ, 0);
    l.join(1);
    l.join(2);
    expect(l.owner).toBe(1);
    expect(l.ownerStart(2, 1, view([1, 2], false))).toBe('not-owner');
    expect(l.ownerStart(1, 1, view([1], false))).toBe('too-few');
    expect(l.phase).toBe('lobby');
    expect(l.ownerStart(1, 1, view([1, 2], false))).toBeNull();
    expect(l.phase).toBe('countdown');
    expect(l.forced).toBe(true);
    expect(l.ownerStart(1, 2, view([1, 2], false))).toBe('phase');
  });

  it('the owner’s countdown survives someone not being ready; everyone’s does not', () => {
    const forced = new Lifecycle(HZ, 0);
    forced.join(1);
    forced.join(2);
    forced.ownerStart(1, 0, view([1, 2]));
    forced.advance(1, view([1, 2]));
    expect(forced.phase).toBe('countdown');

    const auto = readyRoom([1, 2]);
    auto.advance(0, view([1, 2]));
    expect(auto.phase).toBe('countdown');
    auto.setReady(2, false, view([1, 2]));
    auto.advance(1, view([1, 2]));
    expect(auto.phase).toBe('lobby');
    // Ready again: it starts again.
    auto.setReady(2, true, view([1, 2]));
    auto.advance(2, view([1, 2]));
    expect(auto.phase).toBe('countdown');
  });

  it('cancels when someone it started with leaves or the room falls below the minimum (owner’s start included); a newcomer does not disturb it', () => {
    const a = readyRoom([1, 2], false);
    a.advance(0, view([1, 2], false));
    a.advance(1, view([1, 2], false, [3]));
    expect(a.phase).toBe('countdown');
    a.leave(2, view([1], false));
    a.advance(5, view([1], false));
    expect(a.phase).toBe('lobby');
    expect(a.transition).toBeNull();

    // With bots the minimum still holds, but the countdown was made with both: one leaving cancels it, then the rest (ready) start again.
    const b = readyRoom([1, 2]);
    b.advance(0, view([1, 2]));
    b.leave(1, view([2]));
    b.advance(depart + 3, view([2]));
    expect(b.phase).toBe('lobby');
    b.advance(depart + 4, view([2]));
    expect(b.phase).toBe('countdown');
    expect(b.lineup).toEqual([2]);

    const c = new Lifecycle(HZ, 0);
    c.join(1);
    c.join(2);
    c.ownerStart(1, 0, view([1, 2], false));
    c.leave(1, view([2], false));
    c.advance(1, view([2], false));
    expect(c.phase).toBe('lobby');
  });

  it('swaps once on the swap tick, then plays on the deadline', () => {
    const l = readyRoom([1]);
    l.advance(0, view([1]));
    const fx: string[] = [];
    for (let t = 1; t <= depart + arrive; t++) fx.push(...l.advance(t, view([1])).map((e) => `${t}:${e}`));
    expect(fx).toEqual([`${depart}:swapIn`, `${depart + arrive}:play`]);
    expect(l.phase).toBe('playing');
    expect(l.deadline).toBeNull();
    expect(l.transition).toBeNull();
  });
});

describe('ownership (L2)', () => {
  it('the first connection owns the room; on leaving, the longest-present seated person takes over, else a watcher, else nobody', () => {
    const l = new Lifecycle(HZ, 0);
    l.join(5);
    l.join(6);
    l.join(7);
    l.join(8);
    expect(l.owner).toBe(5);
    // 6 watches, 7 and 8 are seated: a seated person is preferred.
    l.leave(5, view([7, 8], true, [6]));
    expect(l.owner).toBe(7);
    l.leave(8, view([7], true, [6]));
    expect(l.owner).toBe(7);
    l.leave(7, view([], true, [6]));
    expect(l.owner).toBe(6);
    l.leave(6, view([]));
    expect(l.owner).toBeNull();
    l.join(9);
    expect(l.owner).toBe(9);
  });

  it('settings are the owner’s, in the lobby only', () => {
    const l = new Lifecycle(HZ, 0);
    l.join(1);
    l.join(2);
    expect(l.maySet(2)).toBe('not-owner');
    expect(l.maySet(1)).toBeNull();
    l.ownerStart(1, 0, view([1, 2]));
    expect(l.maySet(1)).toBe('phase');
  });

  it('ownership survives a match, and a leaving owner’s readiness goes with them', () => {
    const l = readyRoom([1, 2]);
    play(l, view([1, 2]));
    expect(l.owner).toBe(1);
    l.leave(1, view([2]));
    expect(l.owner).toBe(2);
    expect(l.ready.has(1)).toBe(false);
  });
});

describe('results and the way back (L1, L2)', () => {
  it('shows the results, departs before the swap back, returns to the lobby on the deadline with everyone unready, and starts nothing before the arrival is over', () => {
    const l = readyRoom([1]);
    play(l, view([1]));
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
    expect(l.ready.size).toBe(0);
    expect(l.transition?.kind).toBe('toLobby');
    expect(l.results).toEqual(results);
    // Ready during the arrival: still nothing until it is over (the owner cannot either).
    l.setReady(1, true, view([1]));
    expect(l.ownerStart(1, back + 1, view([1]))).toBe('busy');
    expect(l.advance(back + arrive - 1, view([1]))).toEqual([]);
    expect(l.phase).toBe('lobby');
    l.advance(back + arrive, view([1]));
    expect(l.transition?.kind).toBe('toArena');
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
