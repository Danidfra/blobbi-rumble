/**
 * NIP-17 receiving (M8C-B): unwrapGiftWrap opens a valid wrap → seal →
 * rumor, and rejects every malformed or forged layer. Throwaway TEST keys;
 * the "extension" is a double over a test key.
 */
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import type { WindowNostr } from 'nostr-tools/nip07';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { describe, expect, it } from 'vitest';
import { inboxFromList, subscribeGiftWraps, inboxRelayAuth, type SubscribePoolLike } from './inbox';
import { UnwrapError, makeRumor, unwrapGiftWrap, wrapForRecipient } from './nip17';
import { SignerError, nip07Signer, type NostrSigner } from './signer';

const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey();
const bob = generateSecretKey();
const A = getPublicKey(alice);
const B = getPublicKey(bob);
function signer(sk: Uint8Array, over: Partial<WindowNostr> = {}, withNip44 = true): NostrSigner {
  return nip07Signer({
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    ...(withNip44 ? { nip44: { encrypt: async (pk: string, t: string) => nip44.encrypt(t, nip44.getConversationKey(sk, pk)), decrypt: async (pk: string, d: string) => nip44.decrypt(d, nip44.getConversationKey(sk, pk)) } } : {}),
    ...over,
  });
}
const enc = (sk: Uint8Array, pk: string, v: unknown) => nip44.encrypt(typeof v === 'string' ? v : JSON.stringify(v), nip44.getConversationKey(sk, pk));
/** Hand-build a wrap with any layer altered (to forge what a careless or hostile sender might). */
function forge(opts: { rumor?: Record<string, unknown>; sealKey?: Uint8Array; sealKind?: number; sealTags?: string[][]; sealContent?: string; wrapKind?: number; wrapP?: string; wrapContent?: string } = {}): NostrEvent {
  const base = makeRumor(A, { kind: 14, created_at: now, content: 'hi', tags: [['p', B]] });
  const rumor = opts.rumor ?? base;
  const sealKey = opts.sealKey ?? alice;
  const seal = finalizeEvent({ kind: opts.sealKind ?? 13, created_at: now - 100, tags: opts.sealTags ?? [], content: opts.sealContent ?? enc(sealKey, B, rumor) }, sealKey);
  const one = generateSecretKey();
  return finalizeEvent({ kind: opts.wrapKind ?? 1059, created_at: now - 100, tags: [['p', opts.wrapP ?? B]], content: opts.wrapContent ?? enc(one, B, seal) }, one);
}
const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof UnwrapError ? e.reason : e instanceof SignerError ? `signer:${e.code}` : 'other';
  }
};

describe('opening a gift wrap', () => {
  it('a valid wrap opens to its rumor (built by our own sending path)', async () => {
    const { rumor, wrap } = await wrapForRecipient(signer(alice), A, { kind: 14, created_at: now, content: 'hello', tags: [['p', B]] }, B, now + 1800);
    const opened = await unwrapGiftWrap(signer(bob), wrap, B);
    expect(opened).toEqual(rumor);
  });

  it('rejects a forged or malformed wrap', async () => {
    const good = forge();
    expect(await reason(unwrapGiftWrap(signer(bob), good, B))).toBe('ok');
    expect(await reason(unwrapGiftWrap(signer(bob), { ...good, sig: 'f'.repeat(128) }, B))).toBe('wrap-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), { ...good, content: good.content.slice(0, -4) + 'AAAA' }, B))).toBe('wrap-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ wrapKind: 1058 }), B))).toBe('wrap-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ wrapP: A }), B))).toBe('not-for-me');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ wrapContent: 'not encrypted at all' }), B))).toBe('undecryptable');
    // Encrypted to someone else: Bob's key does not open it.
    const other = generateSecretKey();
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ wrapContent: enc(other, getPublicKey(generateSecretKey()), { x: 1 }) }), B))).toBe('undecryptable');
    expect(await reason(unwrapGiftWrap(signer(bob), null, B))).toBe('wrap-invalid');
  });

  it('rejects a forged or malformed seal', async () => {
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ sealKind: 14 }), B))).toBe('seal-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ sealTags: [['expiration', '1']] }), B))).toBe('seal-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ sealContent: 'garbage' }), B))).toBe('undecryptable');
    // A seal whose signature does not verify.
    const seal = { ...finalizeEvent({ kind: 13, created_at: now, tags: [], content: enc(alice, B, makeRumor(A, { kind: 14, created_at: now, content: 'x', tags: [] })) }, alice), sig: 'e'.repeat(128) };
    const one = generateSecretKey();
    const wrap = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', B]], content: enc(one, B, seal) }, one);
    expect(await reason(unwrapGiftWrap(signer(bob), wrap, B))).toBe('seal-invalid');
  });

  it('rejects a rumor that lies about its author, its id, or its shape', async () => {
    const mallory = generateSecretKey();
    // Mallory seals a rumor that claims to be by Alice (NIP-17's impersonation check).
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ sealKey: mallory, rumor: makeRumor(A, { kind: 14, created_at: now, content: 'I am Alice', tags: [['p', B]] }) }), B))).toBe('author-mismatch');
    const r = makeRumor(A, { kind: 14, created_at: now, content: 'x', tags: [['p', B]] });
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: { ...r, content: 'changed' } }), B))).toBe('rumor-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: { ...r, id: 'a'.repeat(64) } }), B))).toBe('rumor-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: { ...r, sig: 'b'.repeat(128) } }), B))).toBe('rumor-invalid');
    const { id: _id, ...noId } = r;
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: noId }), B))).toBe('rumor-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: { ...r, tags: 'x' } }), B))).toBe('rumor-invalid');
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: [1, 2] as unknown as Record<string, unknown> }), B))).toBe('rumor-invalid');
    const big = { ...r, content: 'x'.repeat(20_000) };
    expect(await reason(unwrapGiftWrap(signer(bob), forge({ rumor: { ...big, id: getEventHash(big) } }), B))).toBe('rumor-invalid');
  });

  it('the signer: no NIP-44 means unavailable; a refusal is the signer’s, not a broken message', async () => {
    expect(await reason(unwrapGiftWrap(signer(bob, {}, false), forge(), B))).toBe('signer:unavailable');
    const refuses = signer(bob, { nip44: { encrypt: async () => '', decrypt: () => Promise.reject(new Error('User rejected')) } });
    expect(await reason(unwrapGiftWrap(refuses, forge(), B))).toBe('signer:denied');
  });
});

describe('the inbox subscription', () => {
  it('reads only kind 1059 for me, only from a 10050 inbox; relay AUTH only for those relays', async () => {
    const list = finalizeEvent({ kind: 10050, created_at: now, tags: [['relay', 'wss://in1.example'], ['relay', 'wss://in2.example']], content: '' }, bob);
    const inbox = inboxFromList(list);
    const got: string[] = [];
    const calls: { relays: string[]; filter: unknown; authed: string[] }[] = [];
    const pool: SubscribePoolLike = {
      subscribeMany(relays, filter, params) {
        const call = { relays, filter, authed: [] as string[] };
        calls.push(call);
        void params.onauth!(makeAuthEvent('wss://in1.example/', 'relay-challenge')).then((ev) => call.authed.push(ev.tags.find((t) => t[0] === 'relay')![1]));
        params.onevent(forge());
        params.onevent(finalizeEvent({ kind: 1, created_at: now, tags: [['p', B]], content: 'not a wrap' }, alice));
        params.onevent(forge({ wrapP: A }));
        params.oneose?.();
        return { close: () => {} };
      },
    };
    const sub = subscribeGiftWraps(pool, inbox, B, { since: now - 100, limit: 60, auth: inboxRelayAuth(signer(bob), inbox), onevent: (e) => got.push(e.id) });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls[0].relays).toEqual(['wss://in1.example/', 'wss://in2.example/']);
    expect(calls[0].filter).toEqual({ kinds: [1059], '#p': [B], since: now - 100, limit: 60 });
    expect(got).toHaveLength(1);
    expect(calls[0].authed).toEqual(['wss://in1.example/']);
    // The game server's proof can never come out of the inbox AUTH signer.
    await expect(inboxRelayAuth(signer(bob), inbox)(makeAuthEvent('wss://rumble.example/ws', 'game'))).rejects.toThrow(/refused/);
    sub.close();
    expect(() => subscribeGiftWraps(pool, Object.freeze(['wss://in1.example/']), B, { since: 0, limit: 1, auth: null, onevent: () => {} })).toThrow(/not an inbox/);
  });
});
