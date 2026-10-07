import { describe, expect, it } from 'vitest';
import { aliveCount, createMatch, matchWinner, restartMatch, ringOut, tickMatch } from './rounds';
import { ROUND } from './tuning';

describe('rounds', () => {
  it('the one who stays scores; the pause ends in a new round', () => {
    const m = createMatch();
    expect(ringOut(m, [true, false])).toBe(true);
    expect(m.score).toEqual([0, 1]);
    expect(m.lastWinner).toBe(1);
    expect(m.phase).toBe('roundOver');
    expect(ringOut(m, [false, true])).toBe(false);
    expect(m.score).toEqual([0, 1]);
    expect(tickMatch(m, ROUND.resetDelay / 2)).toBeNull();
    expect(tickMatch(m, ROUND.resetDelay)).toBe('round');
    expect(m.phase).toBe('playing');
    expect(m.round).toBe(2);
  });

  it('both falling in one frame is a draw: no point, still a round', () => {
    const m = createMatch();
    expect(ringOut(m, [true, true])).toBe(true);
    expect(m.score).toEqual([0, 0]);
    expect(m.lastWinner).toBeNull();
    expect(m.phase).toBe('roundOver');
  });

  it('first to the target wins: the match says so once, so the scene settles, then waits for a restart', () => {
    const m = createMatch();
    for (let i = 0; i < ROUND.target - 1; i++) {
      ringOut(m, [false, true]);
      expect(tickMatch(m, ROUND.resetDelay + 0.01)).toBe('round');
    }
    ringOut(m, [false, true]);
    expect(tickMatch(m, ROUND.resetDelay + 0.01)).toBe('over');
    expect(m.phase).toBe('matchOver');
    expect(matchWinner(m)).toBe(0);
    // Nothing more happens on its own: no second 'over', no scoring.
    expect(tickMatch(m, 10)).toBeNull();
    expect(ringOut(m, [true, false])).toBe(false);
    restartMatch(m);
    expect(m).toEqual(createMatch());
  });

  it('four fighters: each ring-out eliminates one, the others play on, the last standing scores', () => {
    const m = createMatch(4);
    expect(m.alive).toEqual([true, true, true, true]);
    expect(ringOut(m, [false, true, false, false])).toBe(false);
    expect(m.phase).toBe('playing');
    expect(aliveCount(m)).toBe(3);
    // An eliminated fighter reported again changes nothing.
    expect(ringOut(m, [false, true, false, false])).toBe(false);
    expect(aliveCount(m)).toBe(3);
    expect(ringOut(m, [true, false, false, false])).toBe(false);
    expect(aliveCount(m)).toBe(2);
    expect(m.score).toEqual([0, 0, 0, 0]);
    expect(ringOut(m, [false, false, false, true])).toBe(true);
    expect(m.lastWinner).toBe(2);
    expect(m.score).toEqual([0, 0, 1, 0]);
    expect(m.phase).toBe('roundOver');
    // During the pause nothing scores; the next round brings everyone back.
    expect(ringOut(m, [false, false, true, false])).toBe(false);
    expect(tickMatch(m, ROUND.resetDelay + 0.01)).toBe('round');
    expect(m.alive).toEqual([true, true, true, true]);
    expect(m.round).toBe(2);
  });

  it('two out in one frame of four leaves two playing; the last two out together is a draw', () => {
    const m = createMatch(4);
    expect(ringOut(m, [true, false, true, false])).toBe(false);
    expect(aliveCount(m)).toBe(2);
    expect(ringOut(m, [false, true, false, true])).toBe(true);
    expect(m.lastWinner).toBeNull();
    expect(m.score).toEqual([0, 0, 0, 0]);
    expect(m.phase).toBe('roundOver');
  });

  it('three going out at once from four leaves one: the survivor scores', () => {
    const m = createMatch(4);
    expect(ringOut(m, [true, true, false, true])).toBe(true);
    expect(m.lastWinner).toBe(2);
    expect(m.score[2]).toBe(1);
  });

  it('three fighters, first to the target, then a restart keeps the roster size', () => {
    const m = createMatch(3);
    for (let r = 0; r < ROUND.target; r++) {
      ringOut(m, [true, false, false]);
      ringOut(m, [false, false, true]);
      tickMatch(m, ROUND.resetDelay + 0.01);
    }
    expect(m.phase).toBe('matchOver');
    expect(matchWinner(m)).toBe(1);
    restartMatch(m);
    expect(m).toEqual(createMatch(3));
  });
});
