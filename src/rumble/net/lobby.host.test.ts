/**
 * A lobby room's host (L1, L2): the match stands still in the lobby and the
 * countdown, is swapped onto its arena on the announced tick, plays, shows
 * its results and goes back to a fresh lobby; readiness, the owner's start
 * and settings, bots on or off, seats only between matches, watchers
 * seated in the lobby, forfeits, and score ownership. A continuous host is
 * untouched but for one fix: a drop-in player never inherits a score.
 * L3: the lobby shows the next lineup; the lobby message names the
 * watchers and whether the countdown is the owner's; nobody is 'none'.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC, FACTORY, SKYFALL, nextArena } from '../arena/arenas';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { ROUND } from '../tuning';
import { RumbleHost, type ConnectionId } from './host';
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
const ready = (h: RumbleHost, ...conns: ConnectionId[]) => {
  for (const c of conns) expect(h.command(c, { t: 'ready', ready: true })).toBeNull();
};
/** Through the countdown into play. */
const toPlay = (h: RumbleHost) => {
  h.tick();
  expect(h.lobby!.phase).toBe('countdown');
  secs(h, LIFECYCLE.departSeconds + LIFECYCLE.arriveSeconds + 0.1);
  expect(h.lobby!.phase).toBe('playing');
};
/** The fighter on `slot` falls (its round ends if one is left). */
const fall = (h: RumbleHost, slot: string) => {
  const s = h.state().snapshot;
  const pos = s.fighters[s.players.indexOf(slot)].position;
  h.match.debugPlace(slot, { x: pos.x, y: h.match.arena.fallY + 0.5, z: pos.z });
};
/** `slot` falls every round: the other fighter of a two-fighter match takes it. */
const loseMatch = (h: RumbleHost, slot: string) => {
  for (let r = 0; r < ROUND.target; r++) {
    fall(h, slot);
    secs(h, 1 + ROUND.resetDelay + 0.3);
  }
};

describe('a continuous room (the OPEN room)', () => {
  it('has no lifecycle and no lobby message', () => {
    const h = new RumbleHost({ havok });
    expect(h.lobby).toBeNull();
    h.connect(1);
    expect(h.lobbyFor(1)).toBeNull();
    expect(h.command(1, { t: 'ready', ready: true })).toBe('no-lobby');
    h.dispose();
  });

  it('a drop-in player takes over a bot’s fighter with no score of the bot’s (L2 fix)', () => {
    const h = new RumbleHost({ havok, players: ['P1', 'P2'] });
    h.connect(1);
    // P1 (the person) falls: P2's bot takes the round.
    fall(h, 'P1');
    secs(h, 1 + ROUND.resetDelay + 0.3);
    expect(h.state().snapshot.fighters[1].score).toBe(1);
    h.connect(2);
    expect(h.slot(2)).toBe('P2');
    h.tick();
    expect(h.state().snapshot.fighters[1].score).toBe(0);
    expect(h.state().control).toEqual({ P1: 'human', P2: 'human' });
    h.dispose();
  });
});

describe('a lobby room: the lifecycle (L1)', () => {
  it('stands still in the lobby: time passes, nothing moves', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    const before = h.state().snapshot;
    secs(h, 3);
    const after = h.state().snapshot;
    expect(h.lobby!.phase).toBe('lobby');
    expect(after.tick).toBe(before.tick + 180);
    expect(after.fighters.map((f) => f.position)).toEqual(before.fighters.map((f) => f.position));
    expect(after.sweeper).toEqual(before.sweeper);
    h.dispose();
  });

  it('a ready person starts the countdown (bots on); inputs move nothing until play; the swap is on the announced tick', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    expect(h.connect(1).you).toBe('P1');
    ready(h, 1);
    h.tick();
    const l = h.lobbyFor(1)!;
    expect(l).toMatchObject({ t: 'lobby', phase: 'countdown', you: 'P1', owner: 'P1', youOwn: true, seated: ['P1'], ready: ['P1'], lineup: ['P1', 'P2', 'P3', 'P4'], canStart: true, need: 1, settings: { bots: true, arena: CLASSIC.id, rotate: false } });
    expect(l.transition!.kind).toBe('toArena');
    const start = h.state().snapshot.fighters[0].position;
    h.receive(1, JSON.stringify(inputMessage(1, { x: 1, z: 0, run: true }, { jump: true, punch: false, grab: false })));
    while (h.state().tick < l.transition!.swapAt) h.tick();
    expect(h.state().snapshot.fighters[0].position).toEqual(start);
    while (h.state().tick < l.deadline!) h.tick();
    expect(h.lobby!.phase).toBe('playing');
    for (let k = 2; k < 30; k++) {
      h.receive(1, JSON.stringify(inputMessage(k, { x: 1, z: 0, run: true }, { jump: false, punch: false, grab: false })));
      h.tick();
    }
    expect(h.state().snapshot.fighters[0].position.x).not.toBeCloseTo(start.x, 1);
    h.dispose();
  });

  it('a won match shows its results (who drove each fighter, the scores, the winner), then a fresh lobby, everyone unready; ticks only go up', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'] });
    h.connect(1);
    ready(h, 1);
    toPlay(h);
    loseMatch(h, 'P1');
    expect(h.lobby!.phase).toBe('results');
    const r = h.lobbyFor(1)!.results!;
    expect(r).toMatchObject({ reason: 'won', winner: 'P2' });
    expect(r.fighters).toEqual([
      { id: 'P1', who: { who: 'guest' }, score: 0 },
      { id: 'P2', who: { who: 'bot' }, score: ROUND.target },
    ]);
    const tick = h.state().tick;
    secs(h, LIFECYCLE.resultsSeconds + 0.1);
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.state().tick).toBeGreaterThan(tick);
    expect(h.state().snapshot.fighters.every((f) => f.score === 0)).toBe(true);
    expect(h.lobbyFor(1)!.ready).toEqual([]);
    expect(h.lobbyFor(1)!.results).toEqual(r);
    // Unready: no new countdown by itself, even after the return's arrival.
    secs(h, LIFECYCLE.arriveSeconds + 1);
    expect(h.lobby!.phase).toBe('lobby');
    h.dispose();
  });

  it('a rotating lobby room moves to the next arena when it returns to the lobby', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'], arena: SKYFALL, rotate: true, random: () => 0.5 });
    h.connect(1);
    ready(h, 1);
    toPlay(h);
    loseMatch(h, 'P1');
    secs(h, LIFECYCLE.resultsSeconds + 0.1);
    const next = nextArena(SKYFALL.id, 0.5).id;
    expect(h.state().snapshot.arena).toBe(next);
    expect(h.lobbyFor(1)!.settings.arena).toBe(next);
    h.dispose();
  });

  it('nobody left in a match (bots on): abandoned, no winner', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    ready(h, 1);
    toPlay(h);
    h.disconnect(1);
    h.tick();
    expect(h.lobby!.phase).toBe('results');
    expect(h.lobby!.results).toMatchObject({ reason: 'abandoned', winner: null });
    h.dispose();
  });
});

describe('a lobby room: seats, watchers and late joiners (L2)', () => {
  it('a fifth person in the lobby watches; a seat freed in the lobby goes to the longest-waiting watcher', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    for (let c = 1; c <= 6; c++) h.connect(c);
    expect([1, 2, 3, 4].map((c) => h.slot(c))).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(h.slot(5)).toBeNull();
    h.disconnect(2);
    expect(h.slot(5)).toBe('P2');
    expect(h.slot(6)).toBeNull();
    expect(h.lobbyFor(5)!.you).toBe('P2');
    h.dispose();
  });

  it('someone arriving during a match watches it (no bot’s fighter, no score), and is seated when the room is back in its lobby', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'] });
    h.connect(1);
    ready(h, 1);
    toPlay(h);
    fall(h, 'P1');
    secs(h, 1 + ROUND.resetDelay + 0.3);
    expect(h.connect(2).you).toBeNull();
    expect(h.lobbyFor(2)!.you).toBeNull();
    expect(h.command(2, { t: 'ready', ready: true })).toBe('spectator');
    expect(h.state().control).toEqual({ P1: 'human', P2: 'bot' });
    loseMatch(h, 'P1');
    // P2's points are the bot's, and say so.
    expect(h.lobby!.results!.fighters.find((f) => f.id === 'P2')).toEqual({ id: 'P2', who: { who: 'bot' }, score: ROUND.target });
    expect(h.slot(2)).toBeNull();
    secs(h, LIFECYCLE.resultsSeconds + 0.1);
    expect(h.slot(2)).toBe('P2');
    expect(h.lobbyFor(2)!.you).toBe('P2');
    expect(h.state().snapshot.fighters[1].score).toBe(0);
    h.dispose();
  });

  it('someone arriving during the countdown watches; the countdown goes on', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    ready(h, 1);
    h.tick();
    expect(h.connect(2).you).toBeNull();
    h.tick();
    expect(h.lobby!.phase).toBe('countdown');
    h.dispose();
  });
});

describe('a lobby room: starting, the owner, cancelling (L2)', () => {
  it('starts only when everyone seated is ready; the owner may start anyway; nobody else may', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    h.connect(2);
    ready(h, 1);
    secs(h, 1);
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.command(2, { t: 'start' })).toBe('not-owner');
    expect(h.command(1, { t: 'start' })).toBeNull();
    expect(h.lobby!.phase).toBe('countdown');
    // The owner's countdown does not wait for P2.
    secs(h, LIFECYCLE.departSeconds + LIFECYCLE.arriveSeconds + 0.1);
    expect(h.lobby!.phase).toBe('playing');
    expect(h.command(1, { t: 'start' })).toBe('phase');
    expect(h.command(1, { t: 'ready', ready: false })).toBe('phase');
    h.dispose();
  });

  it('someone becoming unready cancels everyone’s countdown; the owner leaving during a countdown cancels it and hands the room on', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    h.connect(2);
    h.connect(3);
    ready(h, 1, 2, 3);
    h.tick();
    expect(h.lobby!.phase).toBe('countdown');
    expect(h.command(3, { t: 'ready', ready: false })).toBeNull();
    h.tick();
    expect(h.lobby!.phase).toBe('lobby');
    ready(h, 3);
    h.tick();
    expect(h.lobby!.phase).toBe('countdown');
    h.disconnect(1);
    h.tick();
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.lobbyFor(2)).toMatchObject({ owner: 'P2', youOwn: true });
    expect(h.lobbyFor(3)).toMatchObject({ owner: 'P2', youOwn: false });
    // The rest are still ready: it starts again with them.
    h.tick();
    expect(h.lobby!.phase).toBe('countdown');
    h.dispose();
  });
});

describe('a lobby room: settings and bots (L2)', () => {
  it('settings are the owner’s, in the lobby only; an arena is shown at once; a bad one is refused', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    h.connect(2);
    expect(h.command(2, { t: 'settings', bots: false })).toBe('not-owner');
    expect(h.command(1, { t: 'settings', arena: 'nowhere' })).toBe('malformed');
    expect(h.command(1, { t: 'settings', arena: FACTORY.id, rotate: true })).toBeNull();
    h.tick();
    expect(h.state().snapshot.arena).toBe(FACTORY.id);
    expect(h.lobbyFor(2)!.settings).toEqual({ bots: true, arena: FACTORY.id, rotate: true });
    h.command(1, { t: 'start' });
    expect(h.command(1, { t: 'settings', bots: false })).toBe('phase');
    secs(h, LIFECYCLE.departSeconds + LIFECYCLE.arriveSeconds + 0.1);
    expect(h.command(1, { t: 'settings', bots: false })).toBe('phase');
    expect(h.lobby!.phase).toBe('playing');
    expect(h.settings.bots).toBe(true);
    expect(h.state().snapshot.players).toEqual(['P1', 'P2', 'P3', 'P4']);
    h.dispose();
  });

  it('without bots: two people are needed (the owner cannot start alone); the match is only the seated people; empty seats are empty, never bots', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    h.connect(1);
    expect(h.command(1, { t: 'settings', bots: false })).toBeNull();
    expect(h.lobbyFor(1)).toMatchObject({ canStart: false, need: 2, lineup: ['P1'] });
    expect(h.roster().slots).toMatchObject({ P2: { who: 'empty' }, P3: { who: 'empty' }, P4: { who: 'empty' } });
    ready(h, 1);
    expect(h.command(1, { t: 'start' })).toBe('too-few');
    secs(h, 1);
    expect(h.lobby!.phase).toBe('lobby');
    h.connect(2);
    h.connect(3);
    h.disconnect(2);
    ready(h, 3);
    const before = h.state().tick;
    toPlay(h);
    const s = h.state();
    expect(s.snapshot.players).toEqual(['P1', 'P3']);
    expect(s.control).toEqual({ P1: 'human', P3: 'human' });
    expect(s.tick).toBeGreaterThan(before);
    expect(h.lobbyFor(1)!.lineup).toEqual(['P1', 'P3']);
    h.dispose();
  });

  it('without bots, someone leaving the match forfeits: their fighter is out and driven by nobody; with one left, that one wins by forfeit', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    for (const c of [1, 2, 3]) h.connect(c);
    h.command(1, { t: 'settings', bots: false });
    ready(h, 1, 2, 3);
    toPlay(h);
    h.disconnect(3);
    secs(h, 0.2);
    expect(h.lobby!.phase).toBe('playing');
    const out = h.state().snapshot.fighters.find((f) => f.id === 'P3')!;
    expect(out.eliminated).toBe(true);
    expect(h.state().control.P3).toBe('none');
    expect(h.roster().slots.P3).toEqual({ who: 'empty' });
    h.disconnect(2);
    h.tick();
    expect(h.lobby!.phase).toBe('results');
    expect(h.lobby!.results).toMatchObject({ reason: 'forfeit', winner: 'P1' });
    expect(h.lobby!.results!.fighters.map((f) => [f.id, f.who.who])).toEqual([
      ['P1', 'guest'],
      ['P2', 'empty'],
      ['P3', 'empty'],
    ]);
    h.dispose();
  });

  it('a change of bots in the lobby applies to the next match: off, then on again, the lineup follows', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2', 'P3'] });
    h.connect(1);
    h.connect(2);
    h.command(1, { t: 'settings', bots: false });
    ready(h, 1, 2);
    toPlay(h);
    expect(h.state().snapshot.players).toEqual(['P1', 'P2']);
    loseMatch(h, 'P2');
    secs(h, LIFECYCLE.resultsSeconds + LIFECYCLE.arriveSeconds + 0.2);
    expect(h.lobby!.phase).toBe('lobby');
    expect(h.command(1, { t: 'settings', bots: true })).toBeNull();
    expect(h.lobbyFor(1)!.lineup).toEqual(['P1', 'P2', 'P3']);
    ready(h, 1, 2);
    toPlay(h);
    expect(h.state().snapshot.players).toEqual(['P1', 'P2', 'P3']);
    expect(h.state().control.P3).toBe('bot');
    h.dispose();
  });
});

describe('a lobby room: what the lobby shows (L3)', () => {
  it('without bots, the lobby’s match is the next lineup: a fighter of the last match whose person left is not left standing', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    for (const c of [1, 2, 3]) h.connect(c);
    h.command(1, { t: 'settings', bots: false });
    h.tick();
    expect(h.state().snapshot.players).toEqual(['P1', 'P2', 'P3']);
    h.disconnect(3);
    const tick = h.state().tick;
    h.tick();
    expect(h.state().snapshot.players).toEqual(['P1', 'P2']);
    expect(h.state().tick).toBe(tick + 1);
    expect(h.state().control).toEqual({ P1: 'human', P2: 'human' });
    // One alone cannot be a match: the last lineup stays (the page draws only the lineup's fighters).
    h.disconnect(2);
    h.tick();
    expect(h.lobbyFor(1)!.lineup).toEqual(['P1']);
    expect(h.state().snapshot.players).toEqual(['P1', 'P2']);
    // Bots back on: every seat again.
    h.command(1, { t: 'settings', bots: true });
    h.tick();
    expect(h.state().snapshot.players).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(h.state().control).toEqual({ P1: 'human', P2: 'bot', P3: 'bot', P4: 'bot' });
    h.dispose();
  });

  it('names the watchers (guests, or proven pubkeys, never a form) and says whether the countdown is the owner’s', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby' });
    for (let c = 1; c <= 6; c++) h.connect(c);
    h.setIdentity(6, 'a'.repeat(64));
    expect(h.lobbyFor(1)!.watchers).toEqual([{ who: 'guest' }, { who: 'nostr', pubkey: 'a'.repeat(64) }]);
    expect(h.lobbyFor(1)!.forced).toBe(false);
    h.command(1, { t: 'start' });
    expect(h.lobbyFor(2)!.forced).toBe(true);
    h.dispose();
  });
});
