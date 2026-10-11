/**
 * How the page reads a lobby room (L1, L2): whether the match is live for
 * its prediction, the stage in one line, and what a refusal means.
 */
import { describe, expect, it } from 'vitest';
import type { LobbyMessage } from '../net/protocol';
import { initialConnection, onSeat, onWelcome } from './connection';
import { lifecyclePlays, lobbyLine, refusalWords, secondsUntil } from './lobby';

const base: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1'], ready: [], lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: false, need: 1, results: null };

describe('the page’s reading of a lobby room (L1)', () => {
  it('a continuous room is always live; a lobby room only in play', () => {
    expect(lifecyclePlays(null)).toBe(true);
    expect(lifecyclePlays(base)).toBe(false);
    expect(lifecyclePlays({ ...base, phase: 'countdown' })).toBe(false);
    expect(lifecyclePlays({ ...base, phase: 'playing' })).toBe(true);
    expect(lifecyclePlays({ ...base, phase: 'results' })).toBe(false);
  });

  it('says the stage in one line: waiting, the countdown in whole seconds, the results; nothing while playing or in a continuous room', () => {
    expect(secondsUntil(300, 181, 60)).toBe(2);
    expect(secondsUntil(100, 181, 60)).toBe(0);
    expect(lobbyLine(null, 0, 60)).toBeNull();
    expect(lobbyLine(base, 0, 60)).toBe('LOBBY · waiting for players (1 needed)');
    expect(lobbyLine({ ...base, need: 2, settings: { ...base.settings, bots: false } }, 0, 60)).toBe('LOBBY · waiting for players (2 needed, bots off)');
    expect(lobbyLine({ ...base, canStart: true, seated: ['P1', 'P3'] }, 0, 60)).toBe('LOBBY · 0 of 2 ready · R: ready');
    expect(lobbyLine({ ...base, canStart: true, seated: ['P1', 'P3'], ready: ['P1'] }, 0, 60)).toBe('LOBBY · 1 of 2 ready · you are ready (R: not ready)');
    expect(lobbyLine({ ...base, you: null }, 0, 60)).toBe('LOBBY · watching: every seat is taken');
    expect(lobbyLine({ ...base, phase: 'countdown', deadline: 300 }, 120, 60)).toBe('MATCH STARTS IN 3');
    expect(lobbyLine({ ...base, phase: 'countdown', deadline: 300, you: null }, 120, 60)).toBe('MATCH STARTS IN 3 · you are watching this one');
    expect(lobbyLine({ ...base, phase: 'playing' }, 0, 60)).toBeNull();
    expect(lobbyLine({ ...base, phase: 'playing', you: null }, 0, 60)).toBe('WATCHING · you play from the next lobby');
    const results = { winner: 'P2', reason: 'won' as const, arena: 'floating-islands-classic', fighters: [] };
    expect(lobbyLine({ ...base, phase: 'results', deadline: 600, results }, 0, 60, (id) => (id === 'P2' ? 'Ada' : id))).toBe('Ada WINS THE MATCH · back to the lobby in 10 s');
    expect(lobbyLine({ ...base, phase: 'results', deadline: 60, results: { ...results, reason: 'forfeit' } }, 0, 60)).toBe('P2 WINS THE MATCH (the others left) · back to the lobby in 1 s');
    expect(lobbyLine({ ...base, phase: 'results', deadline: 60, results: { ...results, winner: null, reason: 'abandoned' } }, 0, 60)).toBe('MATCH OVER · back to the lobby in 1 s');
  });

  it('a seat given or taken between matches changes what the connection says, only while connected', () => {
    const watching = onWelcome(initialConnection('ws://x'), null, 0);
    expect(watching.phase).toBe('watching');
    expect(onSeat(watching, 'P3')).toMatchObject({ phase: 'playing', you: 'P3' });
    expect(onSeat(onSeat(watching, 'P3'), null)).toMatchObject({ phase: 'watching', you: null });
    expect(onSeat(initialConnection('ws://x'), 'P1').phase).toBe('connecting');
  });

  it('says why a request was refused', () => {
    expect(refusalWords('settings', 'not-owner')).toBe('Only the room’s owner can do that');
    expect(refusalWords('start', 'too-few')).toBe('Not enough players to start');
    expect(refusalWords('settings', 'phase')).toBe('Settings change only in the lobby');
    expect(refusalWords('ready', 'spectator')).toBe('You are watching: you get a seat in the next lobby');
  });
});
