/** The connection as a player sees it: connecting, playing or watching, lost (and retrying), failed, full. */
import { describe, expect, it } from 'vitest';
import { CONNECTION, describe as words, initialConnection, onClose, onRetry, onWelcome, statusLine } from './connection';

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
});
