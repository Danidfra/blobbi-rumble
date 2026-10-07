/**
 * RING-OUTS, ROUNDS AND THE MATCH, as pure state, for any number of
 * fighters. Falling off the arena eliminates a fighter from the round; the
 * others play on. The last Blobbi standing takes the round's point. If the
 * last fighters left all cross the fall line on the same frame, nobody is
 * left: a draw, no point. First to `ROUND.target` wins; the match then
 * settles and waits for a restart.
 */
import { ROUND } from './tuning';

export type Phase = 'playing' | 'roundOver' | 'matchOver';
/** A fighter's index in the roster. */
export type Player = number;

export interface MatchState {
  /** How many fighters play. */
  players: number;
  score: number[];
  /** Still in this round (not rung out). */
  alive: boolean[];
  phase: Phase;
  /** Seconds left in the round-over pause. */
  timer: number;
  /** Who took the last round, or null for a draw. */
  lastWinner: Player | null;
  round: number;
}

export const createMatch = (players = 2): MatchState => ({ players, score: Array(players).fill(0), alive: Array(players).fill(true), phase: 'playing', timer: 0, lastWinner: null, round: 1 });

export const aliveCount = (m: MatchState) => m.alive.filter(Boolean).length;

/**
 * Report which fighters crossed the fall line THIS frame. Only during play,
 * and only the living count: each one who fell is eliminated. When one is
 * left it takes the point; when none is left (the last ones fell together)
 * the round is a draw. Returns true when the round ended.
 */
export function ringOut(m: MatchState, fell: readonly boolean[], rules = ROUND): boolean {
  if (m.phase !== 'playing') return false;
  let any = false;
  for (let i = 0; i < m.players; i++) {
    if (fell[i] && m.alive[i]) {
      m.alive[i] = false;
      any = true;
    }
  }
  if (!any) return false;
  const left = aliveCount(m);
  if (left > 1) return false;
  if (left === 1) {
    const winner = m.alive.indexOf(true);
    m.lastWinner = winner;
    m.score[winner] += 1;
  } else m.lastWinner = null;
  m.phase = 'roundOver';
  m.timer = rules.resetDelay;
  return true;
}

/**
 * Advance the round-over pause. On the frame it ends: 'round' when a new
 * round should begin (everyone back in), 'over' when the match is decided
 * and the scene should settle (all back at their spawns, at rest, until a
 * restart).
 */
export function tickMatch(m: MatchState, dt: number, rules = ROUND): 'round' | 'over' | null {
  if (m.phase !== 'roundOver') return null;
  m.timer -= dt;
  if (m.timer > 0) return null;
  m.timer = 0;
  m.alive.fill(true);
  if (m.score.some((s) => s >= rules.target)) {
    m.phase = 'matchOver';
    return 'over';
  }
  m.phase = 'playing';
  m.round += 1;
  return 'round';
}

export const matchWinner = (m: MatchState, rules = ROUND): Player | null => {
  const i = m.score.findIndex((s) => s >= rules.target);
  return i < 0 ? null : i;
};

export function restartMatch(m: MatchState) {
  Object.assign(m, createMatch(m.players));
}
