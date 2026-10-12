/**
 * How the page reads a lobby room (L1-L3): whether the match is live for
 * its prediction, which fighters it draws before a match, what watching
 * means, and what a refusal means.
 */
import { describe, expect, it } from 'vitest';
import type { LobbyMessage } from '../net/protocol';
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';
import { describe as describeConn, idleConnection, initialConnection, onClose, onSeat, onWelcome, statusLine, watchingWords } from './connection';
import { lifecyclePlays, movementLive, refusalWords, tagMarks, visibleLineup } from './lobby';

const LOBBY: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1'], ready: [], watchers: [], forced: false, lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: true, need: 1, results: null };

const snap = (ids: string[]): MatchSnapshot => ({ players: ids, fighters: ids.map((id) => ({ id }) as FighterSnapshot) }) as MatchSnapshot;

describe('the page’s reading of a lobby room', () => {
  it('a continuous room is always live; a lobby room only in play', () => {
    expect(lifecyclePlays(null)).toBe(true);
    expect(lifecyclePlays(LOBBY)).toBe(false);
    expect(lifecyclePlays({ ...LOBBY, phase: 'countdown' })).toBe(false);
    expect(lifecyclePlays({ ...LOBBY, phase: 'playing' })).toBe(true);
    expect(lifecyclePlays({ ...LOBBY, phase: 'results' })).toBe(false);
  });

  it('before a match, draws only the next lineup’s fighters (L3); in play, the results or a continuous room, everything', () => {
    const last = snap(['P1', 'P2', 'P3']);
    expect(visibleLineup(last, { ...LOBBY, lineup: ['P1', 'P3'] }).players).toEqual(['P1', 'P3']);
    expect(visibleLineup(last, { ...LOBBY, lineup: ['P1', 'P3'] }).fighters.map((f) => f.id)).toEqual(['P1', 'P3']);
    expect(visibleLineup(last, { ...LOBBY, phase: 'countdown', lineup: ['P1'] }).players).toEqual(['P1']);
    // Nobody of the lineup has a fighter yet: nothing drawn rather than strangers.
    expect(visibleLineup(last, { ...LOBBY, lineup: ['P4'] }).players).toEqual([]);
    expect(visibleLineup(last, { ...LOBBY, lineup: ['P1', 'P2', 'P3'] })).toBe(last);
    expect(visibleLineup(last, { ...LOBBY, phase: 'playing', lineup: ['P1'] })).toBe(last);
    expect(visibleLineup(last, { ...LOBBY, phase: 'results', lineup: ['P1'] })).toBe(last);
    expect(visibleLineup(last, null)).toBe(last);
  });

  it('watching means waiting for the next match in a lobby room, and all slots taken elsewhere (L3)', () => {
    expect(watchingWords(true)).toBe('waiting for next match');
    expect(watchingWords(false)).toBe('watching (all four slots taken)');
    const watching = onWelcome(initialConnection('ws://x'), null, 0, true);
    expect(statusLine(watching, 40, true)).toBe('● online · waiting for next match · 40 ms');
    expect(statusLine(watching, 40)).toBe('● online · watching (all four slots taken) · 40 ms');
    const back = onWelcome({ ...initialConnection('ws://x'), everConnected: true }, null, 0, true);
    expect(back.note).toBe('Reconnected: waiting for next match');
    expect(back.note).not.toMatch(/slots/);
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

  it('moves on the plaza (L4): the fighter is live there whatever the lobby’s stage, and in play; not in an arena before play', () => {
    expect(movementLive(LOBBY, 'blobbi-plaza')).toBe(true);
    expect(movementLive({ ...LOBBY, phase: 'countdown' }, 'blobbi-plaza')).toBe(true);
    expect(movementLive({ ...LOBBY, phase: 'countdown' }, 'floating-islands-classic')).toBe(false);
    expect(movementLive({ ...LOBBY, phase: 'playing' }, 'floating-islands-classic')).toBe(true);
    expect(movementLive({ ...LOBBY, phase: 'results' }, 'floating-islands-classic')).toBe(false);
    expect(movementLive(null, 'floating-islands-classic')).toBe(true);
  });

  it('marks the owner and who is ready over the Blobbis in the lobby (L4), nothing in play', () => {
    const l = { ...LOBBY, owner: 'P1', ready: ['P2'] };
    expect(tagMarks(l, 'P1')).toEqual({ before: '★ ', after: '' });
    expect(tagMarks(l, 'P2')).toEqual({ before: '', after: ' ✓' });
    expect(tagMarks({ ...l, phase: 'playing' }, 'P1')).toEqual({ before: '', after: '' });
    expect(tagMarks(null, 'P1')).toEqual({ before: '', after: '' });
  });

  it('the menu is no connection at all (L4.1): nothing to say, no banner', () => {
    const idle = idleConnection('ws://x');
    expect(idle.phase).toBe('idle');
    expect(describeConn(idle, 0)).toBeNull();
    expect(statusLine(idle, NaN)).toBe('○ not connected');
  });

  it('a full plaza (L4.1) is said plainly, offers trying again, a private room or Quick Match, and never retries by itself', () => {
    const s = onClose({ ...initialConnection('ws://x', null), everConnected: true }, 1013, 'plaza full', 10);
    expect(s.phase).toBe('plazaFull');
    expect(s.retryAt).toBe(Infinity);
    const d = describeConn(s, 10)!;
    expect(d.title).toBe('Blobbi Plaza is full.');
    expect(d.actions).toEqual(['retry', 'private', 'quick', 'menu']);
    expect(d.retry).toBe(false);
    // An ordinary full room still retries slowly, as before.
    expect(onClose(initialConnection('ws://x', null), 1013, 'room full', 10).phase).toBe('full');
  });
});
