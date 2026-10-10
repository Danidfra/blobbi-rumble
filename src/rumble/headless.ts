/**
 * A HEADLESS MATCH: the authoritative match played to the end with no
 * renderer, DOM, keyboard or browser loop. Every player is a local test bot
 * reading the match's own snapshots, exactly as the browser client feeds
 * its bots; the match is stepped at a fixed dt as fast as the machine
 * goes. For tests, measurements and, later, the shape of a server loop.
 */
import { BotInput, botWorldFrom } from './control/bot';
import { nextArena, type ArenaDef } from './arena/arenas';
import { createRumbleMatch, type RumbleMatch } from './sim/match';
import type { HavokInstance } from './sim/physics';
import type { MatchEvent, MatchSnapshot } from './sim/snapshot';

export interface HeadlessOptions {
  havok: HavokInstance;
  players?: 2 | 3 | 4;
  /** The fixed step, seconds. */
  dt?: number;
  /** Give up after this much simulated time, seconds. */
  maxSeconds?: number;
  /** Matches to play back to back on the same match object (restarted between). */
  matches?: number;
  /** Called after every step (for invariant checks). */
  onStep?: (match: RumbleMatch, snapshot: MatchSnapshot, events: readonly MatchEvent[]) => void;
  /** M11A: the arena (the classic island by default), and whether to rotate between matches (deterministically, in order). */
  arena?: ArenaDef;
  rotate?: boolean;
}

export interface HeadlessResult {
  matches: { winner: string | null; rounds: number; ticks: number; seconds: number; scores: Record<string, number>; arena: string }[];
  events: MatchEvent[];
  ticks: number;
  simulatedSeconds: number;
  wallSeconds: number;
}

export function runHeadless(o: HeadlessOptions): HeadlessResult {
  const players = o.players ?? 4;
  const dt = o.dt ?? 1 / 60;
  const maxTicks = Math.round((o.maxSeconds ?? 600) / dt);
  const match = createRumbleMatch({ havok: o.havok, players: Array.from({ length: players }, (_, i) => ({ id: `P${i + 1}` })), ...(o.arena ? { arena: o.arena } : {}) });
  const bots = match.ids.map((_, i) => new BotInput(i + 1));
  const events: MatchEvent[] = [];
  const results: HeadlessResult['matches'] = [];
  const start = performance.now();
  let ticks = 0;
  try {
    for (let m = 0; m < (o.matches ?? 1); m++) {
      if (m > 0) {
        if (o.rotate) events.push(...match.switchArena(nextArena(match.arena.id, (m * 0.37) % 1)));
        events.push(...match.restart());
      }
      bots.forEach((b) => b.reset(1 + 1000 * m));
      const startTick = match.tick;
      let snapshot = match.snapshot();
      let done = false;
      while (!done && ticks < maxTicks) {
        const playing = snapshot.phase === 'playing';
        bots.forEach((b, i) => {
          b.enabled = playing && !snapshot.fighters[i].eliminated;
          b.plan(botWorldFrom(snapshot, match.ids[i]), dt);
          match.setInput(match.ids[i], b.read());
        });
        const stepEvents = match.step(dt);
        ticks++;
        snapshot = match.snapshot();
        for (const e of stepEvents) {
          events.push(e);
          if (e.kind === 'newRound') bots.forEach((b) => b.reset(snapshot.round + 1000 * m));
          if (e.kind === 'match') done = true;
        }
        o.onStep?.(match, snapshot, stepEvents);
      }
      results.push({
        winner: snapshot.matchWinner,
        rounds: snapshot.round,
        ticks: match.tick - startTick,
        seconds: (match.tick - startTick) * dt,
        scores: Object.fromEntries(snapshot.fighters.map((f) => [f.id, f.score])),
        arena: snapshot.arena,
      });
      if (!done) break;
    }
  } finally {
    match.dispose();
  }
  return { matches: results, events, ticks, simulatedSeconds: ticks * dt, wallSeconds: (performance.now() - start) / 1000 };
}
