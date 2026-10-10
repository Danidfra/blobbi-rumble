/**
 * The wire protocol, as plain data: what a client may say (an input or a
 * ping, and nothing else), how untrusted input is cleaned or refused, and
 * how a client tells a stale state from a fresh one.
 */
import { describe, expect, it } from 'vitest';
import { isNewer, parseClientMessage, parseIntent, PROTOCOL } from './protocol';

const input = (seq: unknown, intent: unknown) => JSON.stringify({ t: 'input', seq, intent });

describe('the wire protocol', () => {
  it('reads an input: finite movement, cut to unit length; flags booleans; absent fields are neutral', () => {
    expect(parseClientMessage(input(1, { x: 0.6, z: -0.8, run: true, punch: true }))).toEqual({ t: 'input', seq: 1, intent: { x: 0.6, z: -0.8, run: true, jump: false, punch: true, grab: false } });
    const long = parseClientMessage(input(2, { x: 30, z: 40 }));
    expect(long?.t === 'input' && Math.hypot(long.intent.x, long.intent.z)).toBeCloseTo(1);
    expect(parseIntent({})).toEqual({ x: 0, z: 0, run: false, jump: false, punch: false, grab: false });
  });

  it('refuses non-finite or mistyped movement and flags, and bad sequence numbers', () => {
    // JSON cannot carry NaN or Infinity: they arrive as null, or as huge numbers that are cut, never as non-finite values.
    expect(parseIntent({ x: NaN })).toBeNull();
    expect(parseIntent({ z: Infinity })).toBeNull();
    expect(parseClientMessage(input(1, { x: null }))).toBeNull();
    expect(parseClientMessage(input(1, { x: '1' }))).toBeNull();
    expect(parseClientMessage(input(1, { jump: 1 }))).toBeNull();
    expect(parseClientMessage(input(1, { punch: 'yes' }))).toBeNull();
    expect(parseClientMessage(input(1, [1, 2]))).toBeNull();
    expect(parseClientMessage(input(1.5, {}))).toBeNull();
    expect(parseClientMessage(input(-1, {}))).toBeNull();
    expect(parseClientMessage(input('7', {}))).toBeNull();
    expect(parseClientMessage(input(Number.MAX_SAFE_INTEGER + 2, {}))).toBeNull();
  });

  it('allows only input and ping: no message can place, power, score or hit anything', () => {
    for (const t of ['debugPlace', 'teleport', 'setPower', 'setScore', 'hit', 'restart', 'state', 'welcome', 'collect']) {
      expect(parseClientMessage(JSON.stringify({ t, id: 'P1', x: 0, z: 0, powerLevel: 6, score: 3 }))).toBeNull();
    }
    expect(parseClientMessage(JSON.stringify({ t: 'ping', id: 3, ct: 12.5 }))).toEqual({ t: 'ping', id: 3, ct: 12.5 });
    expect(parseClientMessage(JSON.stringify({ t: 'ping', id: 'x', ct: 1 }))).toBeNull();
    // An input naming a player is just an input: the field is not read.
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 1, player: 'P2', intent: {} }))).toEqual({ t: 'input', seq: 1, intent: { x: 0, z: 0, run: false, jump: false, punch: false, grab: false } });
  });

  it('drops junk, non-text and oversized messages unread', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('[1]')).toBeNull();
    expect(parseClientMessage(42)).toBeNull();
    expect(parseClientMessage(input(1, { x: 0, pad: 'x'.repeat(PROTOCOL.maxClientMessage) }))).toBeNull();
  });

  it('a client shows a state only when it is newer than the newest it has shown', () => {
    expect(isNewer(3, null)).toBe(true);
    expect(isNewer(6, 3)).toBe(true);
    expect(isNewer(3, 3)).toBe(false);
    expect(isNewer(2, 3)).toBe(false);
  });
});

describe('identity messages (M8A)', () => {
  it('reads challenge, logout and auth; only a proof may be long, and never longer than its limit', () => {
    expect(parseClientMessage('{"t":"challenge"}')).toEqual({ t: 'challenge' });
    expect(parseClientMessage('{"t":"logout"}')).toEqual({ t: 'logout' });
    expect(parseClientMessage(JSON.stringify({ t: 'auth', event: { kind: 22242 } }))).toEqual({ t: 'auth', event: { kind: 22242 } });
    expect(parseClientMessage(JSON.stringify({ t: 'auth', event: 'x' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'auth', event: [1] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'auth', event: { pad: 'x'.repeat(1500) } }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'auth', event: { pad: 'x'.repeat(PROTOCOL.maxAuthMessage) } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'challenge', pad: 'x'.repeat(PROTOCOL.maxClientMessage) }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'whoami' }))).toBeNull();
  });
});

describe('look messages (M9C)', () => {
  const d = `blobbi-${'a'.repeat(12)}-${'b'.repeat(10)}`;
  it('reads a look: the default, or a bounded declaration; everything else is dropped', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'look', form: null }))).toEqual({ t: 'look', form: null });
    expect(parseClientMessage(JSON.stringify({ t: 'look', form: { v: 1, d, gen: 'v3', name: 'Puck' } }))).toEqual({ t: 'look', form: { v: 1, d, gen: 'v3', name: 'Puck' } });
    expect(parseClientMessage(JSON.stringify({ t: 'look', form: { v: 1, d, gen: 'v2', colors: { base: '#AABBCC', secondary: '#000000', eye: '#ffffff' } } }))).toEqual({ t: 'look', form: { v: 1, d, gen: 'v2', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' } } });
    for (const bad of [{ v: 2, d, gen: 'v3' }, { v: 1, d: 'blobbi-puck', gen: 'v3' }, { v: 1, d, gen: 'v9' }, { v: 1, d, gen: 'v3', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' } }, { v: 1, d, gen: 'v1', colors: { base: 'red' } }, { v: 1, d, gen: 'v1', seed: 'x'.repeat(64) }, 'x', 42, []])
      expect(parseClientMessage(JSON.stringify({ t: 'look', form: bad })), JSON.stringify(bad)).toBeNull();
    // A seed sent by a client is never read (the server derives it): a declaration with one is not a declaration.
    expect(parseClientMessage(JSON.stringify({ t: 'look', form: { v: 1, d, gen: 'v3', seed: 'a'.repeat(64) } }))).toBeNull();
    // Bounded: a long name is cut, an oversized message dropped unread.
    const long = parseClientMessage(JSON.stringify({ t: 'look', form: { v: 1, d, gen: 'v3', name: 'n'.repeat(100) } }));
    expect(long && long.t === 'look' && long.form?.name?.length).toBeLessThanOrEqual(32);
    expect(parseClientMessage(JSON.stringify({ t: 'look', form: { v: 1, d, gen: 'v3', name: 'n'.repeat(600) } }))).toBeNull();
  });
});
