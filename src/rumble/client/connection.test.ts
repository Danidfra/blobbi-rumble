/** The connection as a player sees it: connecting, playing or watching, lost (and retrying), failed, full. */
import { describe, expect, it } from 'vitest';
import { CONNECTION, describe as words, initialConnection, onClose, onRetry, onWelcome, statusLine, onProtocol } from './connection';

describe('the connection', () => {
  it('connecting, then playing as the slot the server gave, or watching when all four are taken', () => {
    let s = initialConnection('wss://x/ws');
    expect(words(s, 0)?.title).toMatch(/Connecting/);
    s = onWelcome(s, 'P2', 1);
    expect(s.phase).toBe('playing');
    expect(words(s, 1)).toBeNull();
    expect(statusLine(s, 42.4)).toBe('● online · you are P2 · 42 ms');
    const w = onWelcome(initialConnection('x'), null, 1);
    expect(w.phase).toBe('watching');
    expect(statusLine(w, NaN)).toMatch(/watching/);
  });

  it('a server that never answers is "unable to connect", retried with growing waits and a Retry button', () => {
    let s = initialConnection('ws://x');
    s = onClose(s, 1006, '', 10);
    expect(s.phase).toBe('failed');
    expect(words(s, 10)).toMatchObject({ title: 'Unable to connect to the Rumble server', retry: true });
    expect(s.retryAt).toBe(10 + CONNECTION.retryBase);
    s = onClose(onRetry(s), 1006, '', 20);
    expect(s.retryAt).toBe(20 + 2 * CONNECTION.retryBase);
    for (let i = 0; i < 10; i++) s = onClose(onRetry(s), 1006, '', 30);
    expect(s.retryAt).toBe(30 + CONNECTION.retryMax);
  });

  it('a loss during play says so, frees the slot, and the reconnect is a new connection with whatever slot is free', () => {
    let s = onWelcome(initialConnection('x'), 'P1', 0);
    s = onClose(s, 1006, '', 5);
    expect(s.phase).toBe('lost');
    expect(s.you).toBeNull();
    expect(words(s, 5)?.detail).toMatch(/bot/);
    expect(statusLine(s, 10)).toBe('○ offline');
    s = onWelcome(onRetry(s), 'P3', 8);
    expect(s.phase).toBe('playing');
    expect(s.attempts).toBe(0);
    expect(s.note).toMatch(/Reconnected as P3/);
    expect(s.note).toMatch(/P1 went to a bot/);
    expect(s.noteUntil).toBeGreaterThan(8);
  });

  it('a full server is told apart and tried again slowly', () => {
    const s = onClose(initialConnection('x'), 1013, 'server full', 0);
    expect(s.phase).toBe('full');
    expect(s.retryAt).toBe(CONNECTION.retryFull);
    expect(words(s, 0)?.title).toMatch(/full/);
  });

  it('too many connections from one network (security audit H1) is said as such, and tried again slowly', () => {
    for (const why of ['network full: too many connections from your network', 'network full: too many connections from your network in this room']) {
      const s = onClose(initialConnection('x'), 1013, why, 0);
      expect(s.phase).toBe('full');
      expect(s.retryAt).toBe(CONNECTION.retryFull);
      expect(words(s, 0)?.title).toBe('Too many connections from your network');
    }
    // An idle socket closed by the server is a lost connection: it comes back by itself.
    expect(onClose({ ...initialConnection('x'), everConnected: true }, 4008, 'idle', 0).phase).toBe('lost');
  });
});

describe('servers a page cannot play with (M10)', () => {
  it('a newer protocol is incompatible: no play, no retry; an older or absent one still plays', () => {
    const s = initialConnection('wss://x.example/ws');
    expect(onProtocol(s, 1, 1).phase).toBe('connecting');
    expect(onProtocol(s, undefined, 1).phase).toBe('connecting');
    expect(onProtocol(s, 0, 1).phase).toBe('connecting');
    const newer = onProtocol(s, 2, 1);
    expect(newer.phase).toBe('incompatible');
    expect(newer.retryAt).toBe(Infinity);
    expect(words(newer, 0)?.title).toMatch(/newer/);
    expect(statusLine(newer, NaN)).toMatch(/incompatible/);
    // The close that follows keeps it incompatible.
    expect(onClose(newer, 1000, 'incompatible', 5).phase).toBe('incompatible');
    expect(onProtocol(s, 1.5, 1).phase).toBe('incompatible');
  });
  it('a server that refuses this page (origin, policy) is rejected: no retry, and the words say to pick another server', () => {
    const s = initialConnection('wss://x.example/ws');
    const r = onClose(s, 4005, 'origin not allowed', 1);
    expect(r.phase).toBe('rejected');
    expect(r.retryAt).toBe(Infinity);
    expect(words(r, 1)?.detail).toMatch(/another server/);
    expect(onClose(s, 1008, 'flooding', 1).phase).toBe('rejected');
    expect(statusLine(r, NaN)).toMatch(/refused/);
  });
});

describe('the room limits as a player hears them (security audit M2, M3)', () => {
  it('too many codes tried, and too many games open from one network, are told apart from a busy server', () => {
    const codes = onClose(initialConnection('x', 'A7F2'), 4003, 'too many room codes tried, wait a minute', 0);
    expect(codes.phase).toBe('refused');
    expect(codes.retryAt).toBe(Infinity);
    expect(words(codes, 0)?.title).toBe('Too many room codes tried');
    const open = onClose(initialConnection('x'), 4003, 'too many open games from your network', 0);
    expect(words(open, 0)?.title).toBe('Your network already has games open');
    expect(words(onClose(initialConnection('x'), 4003, 'too many new rooms, wait a minute', 0), 0)?.detail).toMatch(/Too many new games/);
    expect(words(onClose(initialConnection('x'), 4003, 'room limit reached', 0), 0)?.detail).toMatch(/as many games as it can/);
  });
});
