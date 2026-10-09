/**
 * Proving a pubkey to a server: a signed kind-22242 answer to a one-use,
 * expiring challenge, naming this server. Every way a proof can be wrong
 * is refused, and the challenge book stays bounded.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { AUTH, ChallengeBook, authAddress, authTemplate, isEventShape, verifyAuth } from './auth';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const URL_ = 'wss://rumble.example/ws';
const addresses = [authAddress(URL_)!];
const now = Math.floor(Date.now() / 1000);
const proof = (challenge: string, url = URL_, over: { kind?: number; created_at?: number; key?: Uint8Array } = {}) => {
  const t = authTemplate(url, challenge);
  return finalizeEvent({ ...t, kind: over.kind ?? t.kind, created_at: over.created_at ?? now }, over.key ?? sk);
};

describe('verifying a proof', () => {
  it('accepts a fresh proof of the issued challenge naming this server', () => {
    expect(authTemplate(URL_, 'c1')).toMatchObject({ kind: 22242, tags: [['relay', URL_], ['challenge', 'c1']], content: '' });
    expect(verifyAuth(proof('c1'), { challenge: 'c1', addresses, now })).toEqual({ ok: true, pubkey: pk });
  });

  it('refuses a bad signature, a changed event, another challenge, another server, the wrong kind, a stale time', () => {
    const p = proof('c1');
    expect(verifyAuth({ ...p, sig: 'a'.repeat(128) }, { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'signature' });
    expect(verifyAuth({ ...p, content: 'x' }, { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'signature' });
    expect(verifyAuth({ ...p, pubkey: getPublicKey(generateSecretKey()) }, { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'signature' });
    expect(verifyAuth(p, { challenge: 'c2', addresses, now })).toEqual({ ok: false, reason: 'challenge' });
    expect(verifyAuth(proof('c1', 'wss://evil.example/ws'), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'server' });
    expect(verifyAuth(proof('c1', 'wss://rumble.example/other'), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'server' });
    expect(verifyAuth(proof('c1', 'not a url'), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'server' });
    expect(verifyAuth(proof('c1', URL_, { kind: 1 }), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'kind' });
    expect(verifyAuth(proof('c1', URL_, { created_at: now - AUTH.maxSkew - 5 }), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'stale' });
    expect(verifyAuth(proof('c1', URL_, { created_at: now + AUTH.maxSkew + 5 }), { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses anything not shaped like a signed event, before any crypto', () => {
    const p = proof('c1');
    for (const bad of [null, 'x', 42, [], {}, { ...p, id: 'zz' }, { ...p, sig: 'short' }, { ...p, pubkey: 'npub1x' }, { ...p, tags: 'x' }, { ...p, tags: [[1, 2]] }, { ...p, kind: 1.5 }, { ...p, content: 'x'.repeat(5000) }, { ...p, tags: Array.from({ length: 40 }, () => ['t', 'x']) }]) {
      expect(isEventShape(bad)).toBe(false);
      expect(verifyAuth(bad, { challenge: 'c1', addresses, now })).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('a proof checked once is not marked verified for a tampered copy (no cached verdict leaks)', () => {
    const p = proof('c1');
    expect(verifyAuth(p, { challenge: 'c1', addresses, now }).ok).toBe(true);
    expect(verifyAuth({ ...p, tags: [['relay', 'wss://evil.example/ws'], ['challenge', 'c1']] }, { challenge: 'c1', addresses: [authAddress('wss://evil.example/ws')!], now })).toEqual({ ok: false, reason: 'signature' });
  });
});

describe('the server address a proof names', () => {
  it('is host, port and path; the scheme does not matter (TLS ends at a proxy)', () => {
    expect(authAddress('wss://Rumble.Example/ws')).toBe('rumble.example/ws');
    expect(authAddress('ws://rumble.example/ws/')).toBe('rumble.example/ws');
    expect(authAddress('https://rumble.example:443/ws')).toBe('rumble.example/ws');
    expect(authAddress('ws://192.168.1.4:8080/ws')).toBe('192.168.1.4:8080/ws');
    expect(authAddress('ws://127.0.0.1:8787')).toBe('127.0.0.1:8787');
    expect(authAddress('wss://rumble.example:8443/ws')).toBe('rumble.example:8443/ws');
    expect(authAddress('ftp://rumble.example/ws')).toBeNull();
    expect(authAddress('wss://u:p@rumble.example/ws')).toBeNull();
    expect(authAddress('')).toBeNull();
  });
});

describe('the challenge book', () => {
  it('issues random challenges, one use each', () => {
    const book = new ChallengeBook();
    const c = book.issue('conn1')!;
    expect(c).toMatch(/^[0-9a-f]{64}$/);
    expect(book.issue('conn2')).not.toBe(c);
    expect(book.take('conn1')).toEqual({ value: c });
    expect(book.take('conn1')).toBe('none');
  });

  it('a new challenge replaces the old; a wrong answer still uses it up', () => {
    const book = new ChallengeBook();
    const a = book.issue('k')!;
    const b = book.issue('k')!;
    expect(a).not.toBe(b);
    expect(book.size).toBe(1);
    expect(book.take('k')).toEqual({ value: b });
  });

  it('expires challenges and forgets them', () => {
    let t = 0;
    const book = new ChallengeBook({ ttlMs: 1000, now: () => t });
    book.issue('a');
    t = 1001;
    expect(book.take('a')).toBe('expired');
    book.issue('b');
    t = 5000;
    book.sweep();
    expect(book.size).toBe(0);
  });

  it('is bounded: full of live challenges, it refuses more; expired ones make room; dropped connections free theirs', () => {
    let t = 0;
    const book = new ChallengeBook({ max: 3, ttlMs: 1000, now: () => t });
    expect(book.issue(1)).not.toBeNull();
    expect(book.issue(2)).not.toBeNull();
    expect(book.issue(3)).not.toBeNull();
    expect(book.issue(4)).toBeNull();
    book.drop(1);
    expect(book.issue(4)).not.toBeNull();
    t = 2000;
    expect(book.issue(5)).not.toBeNull();
    expect(book.size).toBe(1);
  });
});
