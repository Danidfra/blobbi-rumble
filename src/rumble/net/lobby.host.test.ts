/**
 * A lobby room's host (L1): the match stands still in the lobby and the
 * countdown, is swapped onto its arena on the announced tick, plays, shows
 * its results (who drove each fighter, the scores) and goes back to a fresh
 * lobby; ticks keep counting up throughout; a continuous host is untouched.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC, SKYFALL, nextArena } from '../arena/arenas';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { ROUND } from '../tuning';
import { RumbleHost } from './host';
import { LIFECYCLE } from './lifecycle';
import { inputMessage } from './protocol';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const ticks = (h: RumbleHost, n: number) => {
  for (let i = 0; i < n; i++) h.tick();
};
const secs = (h: RumbleHost, s: number) => ticks(h, Math.ceil(s * h.tickHz));
/** Through the countdown into play. */
const toPlay = (h: RumbleHost) => {
  secs(h, LIFECYCLE.departSeconds + LIFECYCLE.arriveSeconds + 0.1);
  expect(h.lobby!.phase).toBe('playing');
};
/** The person on `slot` falls every round: a bot takes the match. */
const loseMatch = (h: RumbleHost, slot: string) => {
  for (let r = 0; r < ROUND.target; r++) {
    const s = h.state().snapshot;
    const pos = s.fighters[s.players.indexOf(slot)].position;
    h.match.debugPlace(slot, { x: pos.x, y: h.match.arena.fallY + 0.5, z: pos.z });
    secs(h, 1 + ROUND.resetDelay + 0.3);
  }
};

describe('a lobby room’s host (L1)', () => {
  it('a continuous host has no lifecycle and no lobby message', () => {
    const h = new RumbleHost({ havok });
    expect(h.lobby).toBeNull();
    h.connect(1);
    expect(h.lobbyFor(1)).toBeNull();
    h.dispose();
  });

  it('stands still in the lobby with nobody in it: time passes, nothing moves', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    const before = h.state().snapshot;
    secs(h, 3);
    const after = h.state().snapshot;
    expect(h.lobby!.phase).toBe('lobby');
    expect(after.tick).toBe(before.tick + 180);
    expect(after.fighters.map((f) => f.position)).toEqual(before.fighters.map((f) => f.position));
    expect(after.sweeper).toEqual(before.sweeper);
    h.dispose();
  });

  it('a person arriving starts the countdown (bots on); inputs move nothing until play; the swap restarts the match on the announced tick', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    const w = h.connect(1);
    expect(w.you).toBe('P1');
    h.tick();
    const l = h.lobbyFor(1)!;
    expect(l).toMatchObject({ t: 'lobby', phase: 'countdown', you: 'P1', lineup: ['P1', 'P2', 'P3', 'P4'], canStart: true, need: 1, settings: { bots: true, arena: CLASSIC.id, rotate: false } });
    expect(l.transition!.kind).toBe('toArena');
    const start = h.state().snapshot.fighters[0].position;
    h.receive(1, JSON.stringify(inputMessage(1, { x: 1, z: 0, run: true }, { jump: true, punch: false, grab: false })));
    while (h.state().tick < l.transition!.swapAt - 1) h.tick();
    expect(h.state().snapshot.fighters[0].position).toEqual(start);
    h.tick();
    expect(h.state().tick).toBe(l.transition!.swapAt);
    while (h.state().tick < l.deadline!) h.tick();
    expect(h.lobby!.phase).toBe('playing');
    // Now input moves the fighter (the countdown's is long stale: a stalled input is let go of, as ever).
    for (let k = 2; k < 30; k++) {
      h.receive(1, JSON.stringify(inputMessage(k, { x: 1, z: 0, run: true }, { jump: false, punch: false, grab: false })));
      h.tick();
    }
    expect(h.state().snapshot.fighters[0].position.x).not.toBeCloseTo(start.x, 1);
    h.dispose();
  });

  it('a won match shows its results (who drove each fighter, the scores, the winner), then a fresh lobby; ticks only go up', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'] });
    h.connect(1);
    toPlay(h);
    loseMatch(h, 'P1');
    expect(h.lobby!.phase).toBe('results');
    const r = h.lobbyFor(1)!.results!;
    expect(r.reason).toBe('won');
    expect(r.winner).not.toBe('P1');
    expect(r.fighters.find((f) => f.id === 'P1')).toEqual({ id: 'P1', who: { who: 'guest' }, score: 0 });
    expect(r.fighters.find((f) => f.id === r.winner)).toMatchObject({ who: { who: 'bot' }, score: ROUND.target });
    const tick = h.state().tick;
    secs(h, LIFECYCLE.resultsSeconds + 0.1);
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.state().tick).toBeGreaterThan(tick);
    const s = h.state().snapshot;
    expect(s.fighters.every((f) => f.score === 0)).toBe(true);
    expect(s.round).toBe(1);
    // The results stay readable in the lobby; after the return's arrival the next countdown starts (the person is still here).
    expect(h.lobbyFor(1)!.results).toEqual(r);
    secs(h, LIFECYCLE.arriveSeconds + 0.1);
    expect(h.lobby!.phase).toBe('countdown');
    h.dispose();
  });

  it('a rotating lobby room moves to the next arena when it returns to the lobby, before the match starts', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'], arena: SKYFALL, rotate: true, random: () => 0.5 });
    h.connect(1);
    toPlay(h);
    loseMatch(h, 'P1');
    secs(h, LIFECYCLE.resultsSeconds + 0.1);
    const next = nextArena(SKYFALL.id, 0.5).id;
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.state().snapshot.arena).toBe(next);
    expect(h.lobbyFor(1)!.settings.arena).toBe(next);
    h.dispose();
  });

  it('an empty room never starts', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    h.disconnect(1);
    secs(h, 10);
    expect(h.lobby!.phase).toBe('lobby');
    h.dispose();
  });
});
