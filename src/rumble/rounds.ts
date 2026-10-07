/**
 * RING-OUT, ROUNDS AND THE MATCH, as pure state. Falling off the arena is
 * the only way to score: the one who stays scores. Both falling in the
 * same frame is a draw and no point. First to `ROUND.target` wins; the
 * match then waits for a restart.
 */
import { ROUND } from './tuning';

export type Phase = 'playing' | 'roundOver' | 'matchOver';
export type Player = 0 | 1;

export interface MatchState {
  score: [number, number];
  phase: Phase;
  /** Seconds left in the round-over pause. */
  timer: number;
  /** Who took the last round, or null for a draw. */
  lastWinner: Player | null;
  round: number;
}

export const createMatch = (): MatchState => ({ score: [0, 0], phase: 'playing', timer: 0, lastWinner: null, round: 1 });

/**
 * Report which players crossed the fall line THIS frame. Only during play;
 * a single faller gives the other the point, both at once is a draw.
 * Returns true when the round ended.
 */
export function ringOut(m: MatchState, fell: [boolean, boolean], rules = ROUND): boolean {
  if (m.phase !== 'playing' || (!fell[0] && !fell[1])) return false;
  if (fell[0] && fell[1]) m.lastWinner = null;
  else {
    const winner: Player = fell[0] ? 1 : 0;
    m.lastWinner = winner;
    m.score[winner] += 1;
  }
  m.phase = 'roundOver';
  m.timer = rules.resetDelay;
  return true;
}

/** Advance the round-over pause. Returns true on the frame a new round should begin (or the match is decided). */
export function tickMatch(m: MatchState, dt: number, rules = ROUND): boolean {
  if (m.phase !== 'roundOver') return false;
  m.timer -= dt;
  if (m.timer > 0) return false;
  m.timer = 0;
  if (m.score[0] >= rules.target || m.score[1] >= rules.target) {
    m.phase = 'matchOver';
    return false;
  }
  m.phase = 'playing';
  m.round += 1;
  return true;
}

export const matchWinner = (m: MatchState, rules = ROUND): Player | null => (m.score[0] >= rules.target ? 0 : m.score[1] >= rules.target ? 1 : null);

export function restartMatch(m: MatchState) {
  m.score = [0, 0];
  m.phase = 'playing';
  m.timer = 0;
  m.lastWinner = null;
  m.round = 1;
}
