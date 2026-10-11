/**
 * The lobby's model (L3): the seats and their labels (a person, a bot, an
 * open seat), readiness, the owner, the watchers, the owner-only controls
 * and when they work, the countdown, the results.
 */
import { describe, expect, it } from 'vitest';
import { ARENAS, FROZEN } from '../arena/arenas';
import type { LobbyMessage, MatchResults, SlotIdentity } from '../net/protocol';
import { ROUND } from '../tuning';
import { lobbyView, resultsView, type LobbyViewInput } from './lobbyView';

const LOBBY: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1'], ready: [], watchers: [], forced: false, lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: true, need: 1, results: null };
const ADA = 'a'.repeat(64);
const BEN = 'b'.repeat(64);
const names: Record<string, string> = { [ADA]: 'Ada', [BEN]: 'Ben' };
const roster4 = (r: Partial<Record<'P1' | 'P2' | 'P3' | 'P4', SlotIdentity>>): Record<string, SlotIdentity> => ({ P1: { who: 'bot' }, P2: { who: 'bot' }, P3: { who: 'bot' }, P4: { who: 'bot' }, ...r });
const view = (lobby: Partial<LobbyMessage>, roster: Record<string, SlotIdentity>, extra: Partial<LobbyViewInput> = {}) =>
  lobbyView({ lobby: { ...LOBBY, ...lobby }, roster, tick: 0, tickHz: 60, personName: (pk) => names[pk] ?? pk.slice(0, 6), blobbiNameOf: () => null, keys: true, ...extra });

describe('the seats (L3)', () => {
  it('labels every seat: a person (Nostr name or Guest), a bot with bots on, an open seat with bots off; never an empty seat as a bot', () => {
    const r = roster4({ P1: { who: 'nostr', pubkey: ADA }, P2: { who: 'guest' } });
    const on = view({ seated: ['P1', 'P2'] }, r);
    expect(on.seats.map((s) => [s.seat, s.kind, s.name, s.ready])).toEqual([
      ['P1', 'person', 'Ada', 'not-ready'],
      ['P2', 'person', 'Guest', 'not-ready'],
      ['P3', 'bot', 'Bot', 'bot'],
      ['P4', 'bot', 'Bot', 'bot'],
    ]);
    const off = view({ seated: ['P1', 'P2'], settings: { ...LOBBY.settings, bots: false }, lineup: ['P1', 'P2'] }, roster4({ P1: { who: 'nostr', pubkey: ADA }, P2: { who: 'guest' }, P3: { who: 'empty' }, P4: { who: 'empty' } }));
    expect(off.seats.slice(2).map((s) => [s.kind, s.name, s.ready])).toEqual([
      ['empty', 'Open seat', 'open'],
      ['empty', 'Open seat', 'open'],
    ]);
    // A roster from before the setting arrived still says 'bot': with bots off it is shown open.
    expect(view({ settings: { ...LOBBY.settings, bots: false } }, roster4({})).seats[3].kind).toBe('empty');
  });

  it('shows who is ready, who owns the room, who you are, and the Blobbi a person’s fighter wears', () => {
    const form = { v: 1, d: `blobbi-${'a'.repeat(12)}-${'0'.repeat(10)}`, gen: 'v3', seed: 'c'.repeat(64) };
    const r = roster4({ P1: { who: 'nostr', pubkey: ADA, form } as SlotIdentity, P2: { who: 'nostr', pubkey: BEN } });
    const v = view({ you: 'P2', owner: 'P1', youOwn: false, seated: ['P1', 'P2'], ready: ['P1'] }, r, { blobbiNameOf: (s) => (s === 'P1' ? 'Pip' : null) });
    expect(v.seats[0]).toMatchObject({ owner: true, you: false, ready: 'ready', blobbi: 'Pip', pubkey: ADA, look: { seed: 'c'.repeat(64), algorithm: 1 } });
    expect(v.seats[1]).toMatchObject({ owner: false, you: true, ready: 'not-ready', blobbi: null, look: null });
    expect(v.status).toBe('1 of 2 ready · starts when everyone is ready');
  });

  it('lists who waits for the next match, by name', () => {
    const v = view({ watchers: [{ who: 'guest' }, { who: 'nostr', pubkey: BEN }] }, roster4({ P1: { who: 'guest' } }));
    expect(v.watchers).toEqual([
      { name: 'Guest', pubkey: null },
      { name: 'Ben', pubkey: BEN },
    ]);
  });

  it('marks the seats that do not play the next match (the lineup)', () => {
    const v = view({ lineup: ['P1', 'P2'], settings: { ...LOBBY.settings, bots: false }, seated: ['P1', 'P2'] }, roster4({ P1: { who: 'guest' }, P2: { who: 'guest' }, P3: { who: 'empty' }, P4: { who: 'empty' } }));
    expect(v.seats.map((s) => s.plays)).toEqual([true, true, false, false]);
  });
});

describe('this person’s controls (L3)', () => {
  const r = roster4({ P1: { who: 'guest' }, P2: { who: 'guest' } });

  it('Ready / Not ready for a seated person, with its key on a desktop; never for a watcher', () => {
    expect(view({ seated: ['P1', 'P2'] }, r).ready).toMatchObject({ shown: true, next: true, label: 'Ready (R)' });
    expect(view({ seated: ['P1', 'P2'], ready: ['P1'] }, r).ready).toMatchObject({ shown: true, next: false, label: 'Not ready (R)' });
    expect(view({ seated: ['P1', 'P2'] }, r, { keys: false }).ready.label).toBe('Ready');
    expect(view({ you: null, youOwn: false }, r).ready.shown).toBe(false);
  });

  it('settings and Start are the owner’s, in the lobby only; another person sees the settings but cannot change them', () => {
    const owner = view({ seated: ['P1', 'P2'] }, r);
    expect(owner.settings.editable).toBe(true);
    expect(owner.start).toMatchObject({ shown: true, disabled: false, label: 'Start now' });
    expect(owner.arenas.map((a) => a.id)).toEqual(ARENAS.map((a) => a.id));
    const guest = view({ you: 'P2', youOwn: false, seated: ['P1', 'P2'] }, r);
    expect(guest.settings.editable).toBe(false);
    expect(guest.start.shown).toBe(false);
    expect(guest.settings).toMatchObject({ bots: true, rotate: false, arenaName: 'Floating Islands: Classic' });
  });

  it('shows the room’s chosen arena and rotation, and bots off', () => {
    const v = view({ settings: { bots: false, arena: FROZEN.id, rotate: true }, youOwn: false }, r);
    expect(v.settings).toMatchObject({ bots: false, arena: FROZEN.id, arenaName: 'Frozen Lake', rotate: true, editable: false });
  });

  it('Start is disabled, with the reason, below the minimum or while the room is still arriving back; it says Start once everyone is ready', () => {
    expect(view({ canStart: false, seated: [], settings: { ...LOBBY.settings, bots: false }, need: 2 }, r).start).toMatchObject({ shown: true, disabled: true, reason: '2 players needed' });
    expect(view({ canStart: false, seated: [] }, r).start.reason).toBe('A player is needed');
    expect(view({ seated: ['P1'], transition: { kind: 'toLobby', departAt: 0, swapAt: 10, arriveBy: 100 } }, r, { tick: 50 }).start).toMatchObject({ disabled: true, reason: 'Back in a moment' });
    expect(view({ seated: ['P1', 'P2'], ready: ['P1', 'P2'] }, r).start).toMatchObject({ disabled: false, label: 'Start' });
  });

  it('says what is missing to start: players, or readiness', () => {
    expect(view({ canStart: false, seated: ['P1'], need: 2, settings: { ...LOBBY.settings, bots: false } }, r).status).toBe('2 players needed to start (bots are off)');
    expect(view({ canStart: false, seated: [] }, r).status).toBe('Waiting for a player to join');
    expect(view({ seated: ['P1', 'P2'], ready: ['P1', 'P2'] }, r).status).toBe('Everyone is ready: starting');
  });
});

describe('the countdown (L3)', () => {
  const r = roster4({ P1: { who: 'guest' }, P2: { who: 'guest' } });

  it('counts down in whole seconds; settings and Start are gone; Not ready stays (it cancels everyone’s countdown)', () => {
    const v = view({ phase: 'countdown', deadline: 300, seated: ['P1', 'P2'], ready: ['P1', 'P2'] }, r, { tick: 120 });
    expect(v.mode).toBe('countdown');
    expect(v.countdown).toBe(3);
    expect(v.settings.editable).toBe(false);
    expect(v.start.shown).toBe(false);
    expect(v.ready).toMatchObject({ shown: true, next: false, label: 'Not ready (R)' });
    expect(v.status).toBe('Everyone is ready');
  });

  it('the owner’s countdown has no Not ready (it would not stop it)', () => {
    const v = view({ phase: 'countdown', deadline: 300, forced: true, seated: ['P1', 'P2'] }, r, { tick: 290 });
    expect(v.ready.shown).toBe(false);
    expect(v.countdown).toBe(1);
    expect(v.status).toBe('The owner started the match');
  });

  it('cancelled, it is the lobby again, controls back', () => {
    const v = view({ phase: 'lobby', seated: ['P1', 'P2'], ready: ['P2'] }, r);
    expect(v.mode).toBe('lobby');
    expect(v.countdown).toBeNull();
    expect(v.start.shown).toBe(true);
    expect(v.settings.editable).toBe(true);
  });

  it('in play, a seated person sees nothing; a watcher sees that they wait for the next match', () => {
    expect(view({ phase: 'playing' }, r).mode).toBe('hidden');
    const w = view({ phase: 'playing', you: null, youOwn: false }, r);
    expect(w.mode).toBe('waiting');
    expect(w.status).toBe('Waiting for next match');
  });
});

describe('the results (L3)', () => {
  const results: MatchResults = {
    winner: 'P2',
    reason: 'won',
    arena: 'floating-islands-classic',
    fighters: [
      { id: 'P1', who: { who: 'nostr', pubkey: ADA }, score: 1 },
      { id: 'P2', who: { who: 'bot' }, score: ROUND.target },
      { id: 'P3', who: { who: 'guest' }, score: 2 },
      { id: 'P4', who: { who: 'empty' }, score: 0 },
    ],
  };

  it('the winner first, then by score; names, human / bot / left, scores; the reason; the seconds back', () => {
    const v = view({ phase: 'results', deadline: 480, results }, roster4({ P1: { who: 'nostr', pubkey: ADA } }), { tick: 0 });
    expect(v.mode).toBe('results');
    const r = v.results!;
    expect(r.title).toBe('Bot wins!');
    expect(r.subtitle).toBe(`First to ${ROUND.target} rounds`);
    expect(r.back).toBe(8);
    expect(r.rows.map((x) => [x.id, x.name, x.label, x.score, x.winner, x.you])).toEqual([
      ['P2', 'Bot', 'Bot', ROUND.target, true, false],
      ['P3', 'Guest', 'Human', 2, false, false],
      ['P1', 'Ada', 'Human', 1, false, true],
      ['P4', 'Left the match', 'Left', 0, false, false],
    ]);
  });

  it('a forfeit and an abandoned match say so', () => {
    const name = (pk: string) => names[pk];
    expect(resultsView({ ...results, winner: 'P1', reason: 'forfeit' }, null, 3, name)).toMatchObject({ title: 'Ada wins!', subtitle: 'Everyone else left the match' });
    expect(resultsView({ ...results, winner: null, reason: 'abandoned' }, null, 3, name)).toMatchObject({ title: 'Match abandoned', subtitle: 'Everyone left the match' });
  });

  it('back in the lobby, the last match is one line; the results card is gone', () => {
    const v = view({ phase: 'lobby', results }, roster4({}));
    expect(v.results).toBeNull();
    expect(v.last).toBe('Last match: Bot won');
  });
});
