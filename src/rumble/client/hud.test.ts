/**
 * Where the player is (L4.2): the menu, the public plaza, a private room
 * between matches, a match, or away; and what the place pill says in each:
 * the plaza's population, a room's code with its players and ready counts,
 * Quick Match or a room's code in a match, the room asked for while away.
 */
import { describe, expect, it } from 'vitest';
import type { LobbyMessage, SlotIdentity } from '../net/protocol';
import { hudView, uiContext, type HudInput } from './hud';

const LOBBY: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1', 'P2'], ready: ['P2'], watchers: [], forced: false, lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: true, need: 1, results: null };
const ROOM: Record<string, SlotIdentity> = { P1: { who: 'guest' }, P2: { who: 'nostr', pubkey: 'a'.repeat(64) }, P3: { who: 'bot' }, P4: { who: 'bot' } };
const PLAZA: Record<string, SlotIdentity> = Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((s, i) => [s, i < 3 ? { who: 'guest' } : { who: 'empty' }]));
const base: HudInput = { menu: false, healthy: true, room: null, asked: null, lobby: null, roster: null };

describe('where the player is (L4.2)', () => {
  it('the menu, the plaza, a room between matches, a match, away', () => {
    expect(uiContext({ ...base, menu: true })).toBe('menu');
    expect(uiContext({ ...base, room: { id: 'PLAZA', kind: 'plaza' } })).toBe('plaza');
    expect(uiContext({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: LOBBY })).toBe('room');
    for (const phase of ['countdown', 'results'] as const) expect(uiContext({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: { ...LOBBY, phase } })).toBe('room');
    expect(uiContext({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: { ...LOBBY, phase: 'playing' } })).toBe('combat');
    expect(uiContext({ ...base, room: { id: 'OPEN', kind: 'open' } })).toBe('combat');
    expect(uiContext({ ...base, healthy: false, room: { id: 'PLAZA', kind: 'plaza' } })).toBe('away');
  });

  it('the plaza: its name and how many people are there (ambient bots and empty seats not counted)', () => {
    expect(hudView({ ...base, room: { id: 'PLAZA', kind: 'plaza' }, roster: PLAZA })).toMatchObject({ icon: '🌸', name: 'Blobbi Plaza', counts: ['3/8'], label: 'Blobbi Plaza, 3 of 8 here. Open the plaza menu' });
  });

  it('a room between matches: its code, seated people of its seats, and how many are ready', () => {
    expect(hudView({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: LOBBY, roster: ROOM })).toMatchObject({ icon: '🔑', name: 'A7F2', counts: ['2/4', '1/2 ready'] });
    // The results: no readiness to count.
    expect(hudView({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: { ...LOBBY, phase: 'results' }, roster: ROOM }).counts).toEqual(['2/4']);
  });

  it('a match: Quick Match or the room’s code, no counts (the scoreboard has them); away: the room asked for', () => {
    expect(hudView({ ...base, room: { id: 'OPEN', kind: 'open' }, roster: ROOM })).toMatchObject({ name: 'Quick Match', counts: [] });
    expect(hudView({ ...base, room: { id: 'A7F2', kind: 'private' }, lobby: { ...LOBBY, phase: 'playing' }, roster: ROOM })).toMatchObject({ name: 'A7F2', counts: [] });
    expect(hudView({ ...base, healthy: false, asked: 'PLAZA' }).name).toBe('Blobbi Plaza');
    expect(hudView({ ...base, healthy: false, asked: 'OPEN' }).name).toBe('Quick Match');
    expect(hudView({ ...base, healthy: false, asked: 'B4CD' }).name).toBe('B4CD');
    expect(hudView({ ...base, menu: true }).name).toBe('');
  });
});
