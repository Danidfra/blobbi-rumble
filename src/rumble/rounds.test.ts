import { describe, expect, it } from 'vitest';
import { createMatch, matchWinner, restartMatch, ringOut, tickMatch } from './rounds';
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
});
