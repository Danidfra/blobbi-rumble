/**
 * NIP-07 signers: finding the extension (also when it injects late), and
 * not trusting what it says: refusals, errors, timeouts, malformed keys and
 * events that do not verify are all classified, never passed on.
 * (The keys here are throwaway test keys; the app never makes one.)
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure';
import type { WindowNostr } from 'nostr-tools/nip07';
import { describe, expect, it } from 'vitest';
import { SignerError, checkSigned, findNip07, nip07From, nip07Signer } from './signer';

function fakeExtension(sk = generateSecretKey(), over: Partial<WindowNostr> = {}): WindowNostr {
  return {
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    ...over,
  };
}
const template: EventTemplate = { kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [['relay', 'wss://x/ws'], ['challenge', 'abc']], content: '' };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof SignerError ? e.code : 'other';
  }
};

describe('finding a NIP-07 extension', () => {
  it('sees window.nostr only when it has both calls', () => {
    expect(nip07From({})).toBeNull();
    expect(nip07From({ nostr: { getPublicKey: () => 1 } })).toBeNull();
    expect(nip07From(null)).toBeNull();
    expect(nip07From({ nostr: fakeExtension() })).not.toBeNull();
  });

  it('waits briefly for one that injects late, and gives up when none comes', async () => {
    const win: { nostr?: WindowNostr } = {};
    setTimeout(() => (win.nostr = fakeExtension()), 50);
    expect(await findNip07(win, 1000, 10)).not.toBeNull();
    expect(await findNip07({}, 60, 10)).toBeNull();
  });
});

describe('the NIP-07 signer', () => {
  it('gives the extension’s key and a verified signature of exactly the template', async () => {
    const sk = generateSecretKey();
    const s = nip07Signer(fakeExtension(sk));
    expect(s.method).toBe('nip07');
    const pk = await s.getPublicKey();
    expect(pk).toBe(getPublicKey(sk));
    const ev = await s.signEvent(template);
    expect(ev.pubkey).toBe(pk);
    expect(ev.tags).toEqual(template.tags);
  });

  it('normalises an upper-case key, refuses a malformed one', async () => {
    const sk = generateSecretKey();
    expect(await nip07Signer(fakeExtension(sk, { getPublicKey: async () => getPublicKey(sk).toUpperCase() })).getPublicKey()).toBe(getPublicKey(sk));
    for (const bad of ['', 'npub1xyz', 'zz'.repeat(32), getPublicKey(sk).slice(1), 42, null, { pubkey: 'x' }])
      expect(await code(nip07Signer(fakeExtension(sk, { getPublicKey: async () => bad as string })).getPublicKey())).toBe('malformed');
  });

  it('classifies a refusal, an error and no answer', async () => {
    expect(await code(nip07Signer(fakeExtension(undefined, { getPublicKey: async () => Promise.reject(new Error('User rejected the request')) })).getPublicKey())).toBe('denied');
    expect(await code(nip07Signer(fakeExtension(undefined, { getPublicKey: async () => Promise.reject('denied') })).getPublicKey())).toBe('denied');
    expect(await code(nip07Signer(fakeExtension(undefined, { getPublicKey: async () => Promise.reject(new Error('internal boom')) })).getPublicKey())).toBe('failed');
    expect(await code(nip07Signer(fakeExtension(undefined, { getPublicKey: () => { throw new Error('sync boom'); } })).getPublicKey())).toBe('failed');
    expect(await code(nip07Signer(fakeExtension(undefined, { getPublicKey: () => new Promise<string>(() => {}) }), { promptMs: 30 }).getPublicKey())).toBe('timeout');
  });

  it('refuses an event that does not verify, is by someone else, or is not the template', async () => {
    const sk = generateSecretKey();
    const other = generateSecretKey();
    const pk = async (s: ReturnType<typeof nip07Signer>) => (await s.getPublicKey(), s);
    const tampered = nip07Signer(fakeExtension(sk, { signEvent: async (t) => ({ ...finalizeEvent(t, sk), content: 'changed' }) }));
    expect(await code((await pk(tampered)).signEvent(template))).toBe('malformed');
    const impostor = nip07Signer(fakeExtension(sk, { signEvent: async (t) => finalizeEvent(t, other) }));
    expect(await code((await pk(impostor)).signEvent(template))).toBe('malformed');
    const swapped = nip07Signer(fakeExtension(sk, { signEvent: async (t) => finalizeEvent({ ...t, tags: [['challenge', 'other']] }, sk) }));
    expect(await code((await pk(swapped)).signEvent(template))).toBe('malformed');
    expect(() => checkSigned(null, template, null)).toThrow(SignerError);
    expect(() => checkSigned('nope', template, null)).toThrow(SignerError);
  });
});
