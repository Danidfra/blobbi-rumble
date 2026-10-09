/**
 * NIP-17 sending (M8C-A): recipient parsing, kind-10050 inboxes, the
 * rumor → seal → gift wrap construction (round-tripped with throwaway TEST
 * keys and nostr-tools' own unwrap), inbox discovery, publishing only gift
 * wraps only to inboxes, relay AUTH only for those relays, and the signer's
 * optional NIP-44.
 */
import * as nip44 from 'nostr-tools/nip44';
import { nprofileEncode, npubEncode, noteEncode, nsecEncode } from 'nostr-tools/nip19';
import { unwrapEvent } from 'nostr-tools/nip59';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import type { WindowNostr } from 'nostr-tools/nip07';
import { describe, expect, it } from 'vitest';
import { findInbox, inboxFromList, inboxRelayAuth, publishGiftWrap, type PublishPoolLike } from './inbox';
import { parseRecipient } from './keys';
import { NIP17, giftWrap, makeRumor, sealRumor, wrapForRecipient } from './nip17';
import { BoundedPool, type PoolLike } from './pool';
import { inboxRelays } from './relays';
import { SignerError, isNip44Payload, nip07Signer, type NostrSigner } from './signer';

/** A NIP-07 extension double over a TEST key (the app never holds one). */
function extension(sk: Uint8Array, over: Partial<WindowNostr> = {}, withNip44 = true): WindowNostr {
  return {
    getPublicKey: async () => getPublicKey(sk),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    ...(withNip44 ? { nip44: { encrypt: async (pk: string, text: string) => nip44.encrypt(text, nip44.getConversationKey(sk, pk)), decrypt: async (pk: string, data: string) => nip44.decrypt(data, nip44.getConversationKey(sk, pk)) } } : {}),
    ...over,
  };
}
async function signerFor(sk: Uint8Array, over: Partial<WindowNostr> = {}, withNip44 = true): Promise<NostrSigner> {
  const s = nip07Signer(extension(sk, over, withNip44), { promptMs: 200 });
  await s.getPublicKey();
  return s;
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof SignerError ? e.code : 'error';
  }
};
const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey();
const bob = generateSecretKey();
const A = getPublicKey(alice);
const B = getPublicKey(bob);
const list = (sk: Uint8Array, tags: string[][], kind = 10050, at = now - 100) => finalizeEvent({ kind, created_at: at, tags, content: '' }, sk);

describe('the signer’s optional NIP-44', () => {
  it('present when the extension has it; absent otherwise (identity unaffected)', async () => {
    const yes = await signerFor(alice);
    expect(yes.nip44).toBeDefined();
    const payload = await yes.nip44!.encrypt(B, 'hello');
    expect(isNip44Payload(payload)).toBe(true);
    expect(nip44.decrypt(payload, nip44.getConversationKey(bob, A))).toBe('hello');
    const no = await signerFor(alice, {}, false);
    expect(no.nip44).toBeUndefined();
    expect(await no.getPublicKey()).toBe(A);
    expect(nip07Signer({ ...extension(alice, {}, false), nip44: { encrypt: 'x' } as unknown as WindowNostr['nip44'] }).nip44).toBeUndefined();
  });

  it('classifies refusals and timeouts, and refuses what is not a NIP-44 payload or plaintext', async () => {
    const deny = await signerFor(alice, { nip44: { encrypt: () => Promise.reject(new Error('User rejected')), decrypt: () => Promise.reject(new Error('x')) } });
    expect(await code(deny.nip44!.encrypt(B, 'x'))).toBe('denied');
    const slow = await signerFor(alice, { nip44: { encrypt: () => new Promise(() => {}), decrypt: () => new Promise(() => {}) } });
    expect(await code(slow.nip44!.encrypt(B, 'x'))).toBe('timeout');
    const junk = await signerFor(alice, { nip44: { encrypt: async () => 'not-a-payload', decrypt: async () => 42 as unknown as string } });
    expect(await code(junk.nip44!.encrypt(B, 'x'))).toBe('malformed');
    expect(await code(junk.nip44!.decrypt(B, await (await signerFor(alice)).nip44!.encrypt(B, 'y')))).toBe('malformed');
    const ok = await signerFor(alice);
    expect(await code(ok.nip44!.encrypt('npub1nope', 'x'))).toBe('malformed');
    expect(await code(ok.nip44!.encrypt(B, 'x'.repeat(70_000)))).toBe('malformed');
    expect(await code(ok.nip44!.decrypt(B, 'short'))).toBe('malformed');
    for (const bad of ['', 'A'.repeat(131), `#${'A'.repeat(200)}`, 'AQ' + 'A'.repeat(198), '!!!!'.repeat(40), 42]) expect(isNip44Payload(bad)).toBe(false);
  });
});

describe('recipients', () => {
  it('reads npub and nprofile (and nostr: URIs); hints are kept as hints', () => {
    expect(parseRecipient(npubEncode(B))).toEqual({ pubkey: B, hints: [] });
    expect(parseRecipient(`  nostr:${npubEncode(B)} `)).toEqual({ pubkey: B, hints: [] });
    expect(parseRecipient(nprofileEncode({ pubkey: B, relays: ['wss://hint.example', 'ws://other.example'] }))).toEqual({ pubkey: B, hints: ['wss://hint.example', 'ws://other.example'] });
  });

  it('refuses everything else, secrets included', () => {
    for (const bad of [B, nsecEncode(bob), noteEncode('a'.repeat(64)), 'npub1', `${npubEncode(B)}x`, npubEncode(B).slice(0, -1) + (npubEncode(B).endsWith('q') ? 'p' : 'q'), 'alice@example.com', '', 'x'.repeat(2000), null, 42])
      expect(parseRecipient(bad), String(bad).slice(0, 20)).toBeNull();
  });
});

describe('kind-10050 inbox lists', () => {
  it('relay tags, wss only, canonical, de-duplicated, in order, at most three', () => {
    const ev = list(bob, [['relay', 'wss://a.example'], ['r', 'wss://not-a-relay-tag.example'], ['relay', 'ws://insecure.example'], ['relay', 'https://web.example'], ['relay', 'wss://A.example/'], ['relay'], ['relay', 'wss://u:p@cred.example'], ['relay', 'wss://b.example'], ['relay', 'wss://c.example'], ['relay', 'wss://d.example']]);
    expect(inboxRelays(ev)).toEqual(['wss://a.example/', 'wss://b.example/', 'wss://c.example/']);
    expect(inboxRelays(list(bob, [['relay', 'wss://x.example']], 10002))).toEqual([]);
    expect(inboxRelays(null)).toEqual([]);
  });
});

describe('building the gift wrap', () => {
  it('rumor by the sender, tagless seal by the sender, wrap by a fresh one-time key; the recipient can open it', async () => {
    const signer = await signerFor(alice);
    const t: EventTemplate = { kind: 14, created_at: now, content: 'hi Bob', tags: [['p', B], ['expiration', String(now + 1800)]] };
    const { rumor, wrap } = await wrapForRecipient(signer, A, t, B, now + 1800, { now });
    expect(rumor).toMatchObject({ kind: 14, pubkey: A, content: 'hi Bob', created_at: now });
    expect('sig' in rumor).toBe(false);
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(A);
    expect(wrap.tags[0]).toEqual(['p', B]);
    const exp = Number(wrap.tags.find((x) => x[0] === 'expiration')![1]);
    expect(exp).toBeGreaterThanOrEqual(now + 1800);
    expect(exp).toBeLessThanOrEqual(now + 1800 + NIP17.maxExpirySlack);
    expect(wrap.created_at).toBeLessThanOrEqual(now);
    expect(wrap.created_at).toBeGreaterThanOrEqual(now - NIP17.maxBackdate);
    // Bob (TEST key) opens it with nostr-tools' own NIP-59 unwrap, which checks seal == rumor author.
    const opened = unwrapEvent(wrap, bob);
    expect(opened).toMatchObject({ id: rumor.id, pubkey: A, kind: 14, content: 'hi Bob' });
    // The seal inside: kind 13, no tags, by Alice, backdated.
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(bob, wrap.pubkey))) as NostrEvent;
    expect(seal).toMatchObject({ kind: 13, tags: [], pubkey: A });
    expect(seal.created_at).toBeLessThanOrEqual(now);
    // Another wrap, another key.
    const again = await wrapForRecipient(signer, A, t, B, now + 1800, { now });
    expect(again.wrap.pubkey).not.toBe(wrap.pubkey);
  });

  it('fails safely on a signer without NIP-44, a forged seal, or junk', async () => {
    const rumor = makeRumor(A, { kind: 14, created_at: now, content: 'x', tags: [['p', B]] });
    expect(await code(sealRumor(await signerFor(alice, {}, false), rumor, B))).toBe('unavailable');
    // The extension signs with another key than the rumor's author.
    const mallory = generateSecretKey();
    const impostor = nip07Signer(extension(alice, { signEvent: async (t) => finalizeEvent(t, mallory) }));
    expect(await code(sealRumor(impostor, rumor, B))).toBe('malformed');
    // A signer that adds tags to the seal.
    const tagger = await signerFor(alice, { signEvent: async (t) => finalizeEvent({ ...t, tags: [['x', 'y']] }, alice) });
    expect(await code(sealRumor(tagger, rumor, B))).toBe('malformed');
    expect(() => makeRumor('nope', { kind: 14, created_at: now, content: '', tags: [] })).toThrow();
    expect(() => giftWrap(finalizeEvent({ kind: 13, created_at: now, tags: [], content: '' }, alice), 'nope', null)).toThrow();
  });
});

/** A fake relay network for lookups. */
function lookups(holds: Record<string, NostrEvent[]>) {
  const asked: string[][] = [];
  const pool: PoolLike = {
    async querySync(relays, filter) {
      asked.push(relays);
      return relays.flatMap((r) => (holds[r] ?? []).filter((e) => filter.kinds?.includes(e.kind) && filter.authors?.includes(e.pubkey)));
    },
    close() {},
  };
  return { pool: new BoundedPool(pool), asked };
}
const LOOKUP = ['wss://lookup.example/'];

describe('finding the inbox', () => {
  it('from the lookup relays; hints and NIP-65 write relays only help find the list, never become the inbox', async () => {
    const tenk = list(bob, [['relay', 'wss://inbox1.example'], ['relay', 'wss://inbox2.example']]);
    const net = lookups({ 'wss://hint.example/': [tenk] });
    const found = await findInbox(net.pool, parseRecipient(nprofileEncode({ pubkey: B, relays: ['wss://hint.example'] }))!, { lookupRelays: LOOKUP });
    expect([...found!.relays]).toEqual(['wss://inbox1.example/', 'wss://inbox2.example/']);
    expect(found!.relays).not.toContain('wss://hint.example/');
    // Not on the lookup relays: the NIP-65 write relays locate it.
    const outbox = list(bob, [['r', 'wss://write.example']], 10002);
    const net2 = lookups({ [LOOKUP[0]]: [outbox], 'wss://write.example/': [tenk] });
    const via = await findInbox(net2.pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP });
    expect([...via!.relays]).toEqual(['wss://inbox1.example/', 'wss://inbox2.example/']);
    expect(via!.relays).not.toContain('wss://write.example/');
  });

  it('no list, an empty or insecure list, or someone else’s list: no inbox (and nothing to send to)', async () => {
    expect(await findInbox(lookups({}).pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP })).toBeNull();
    expect(await findInbox(lookups({ [LOOKUP[0]]: [list(bob, [['relay', 'ws://insecure.example']])] }).pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP })).toBeNull();
    expect(await findInbox(lookups({ [LOOKUP[0]]: [list(bob, [])] }).pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP })).toBeNull();
    expect(await findInbox(lookups({ [LOOKUP[0]]: [list(alice, [['relay', 'wss://alice.example']])] }).pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP })).toBeNull();
    // The newest list wins.
    const old = list(bob, [['relay', 'wss://old.example']], 10050, now - 1000);
    const fresh = list(bob, [['relay', 'wss://new.example']], 10050, now - 10);
    expect([...(await findInbox(lookups({ [LOOKUP[0]]: [old, fresh] }).pool, { pubkey: B, hints: [] }, { lookupRelays: LOOKUP }))!.relays]).toEqual(['wss://new.example/']);
  });
});

/** A fake publishing pool: per relay, accept or reject (optionally only after AUTH). */
function publisher(behaviour: Record<string, 'ok' | 'no' | 'auth'>) {
  const calls: { relays: string[]; event: NostrEvent; authed: string[] }[] = [];
  const pool: PublishPoolLike = {
    publish(relays, event, params) {
      const call = { relays, event, authed: [] as string[] };
      calls.push(call);
      return relays.map(async (r) => {
        const b = behaviour[r] ?? 'no';
        if (b === 'no') throw new Error('blocked: no');
        if (b === 'auth') {
          if (!params?.onauth) throw new Error('auth-required: please');
          const signed = await params.onauth(makeAuthEvent(r, 'relay-challenge'));
          call.authed.push(signed.tags.find((t) => t[0] === 'relay')![1]);
        }
        return 'ok';
      });
    },
  };
  return { pool, calls };
}

describe('publishing', () => {
  const inbox = () => inboxFromList(list(bob, [['relay', 'wss://inbox1.example'], ['relay', 'wss://inbox2.example']]));
  const wrapOf = async () => (await wrapForRecipient(await signerFor(alice), A, { kind: 14, created_at: now, content: 'x', tags: [['p', B]] }, B, null)).wrap;

  it('sends only the gift wrap, only to the inbox; success with one relay, failure with none', async () => {
    const wrap = await wrapOf();
    const part = publisher({ 'wss://inbox1.example/': 'ok', 'wss://inbox2.example/': 'no' });
    const r = await publishGiftWrap(part.pool, inbox(), wrap, null);
    expect(part.calls[0].relays).toEqual(['wss://inbox1.example/', 'wss://inbox2.example/']);
    expect(part.calls[0].event).toBe(wrap);
    expect(r.accepted).toEqual(['wss://inbox1.example/']);
    expect(r.failed).toEqual([{ relay: 'wss://inbox2.example/', reason: 'blocked: no' }]);
    expect((await publishGiftWrap(publisher({}).pool, inbox(), wrap, null)).accepted).toEqual([]);
  });

  it('refuses anything but a valid kind-1059 wrap, and any relay set not made from a 10050 list', async () => {
    const wrap = await wrapOf();
    const p = publisher({ 'wss://inbox1.example/': 'ok' });
    await expect(publishGiftWrap(p.pool, Object.freeze(['wss://inbox1.example/']), wrap, null)).rejects.toThrow(/not an inbox/);
    await expect(publishGiftWrap(p.pool, inboxFromList(list(bob, [])), wrap, null)).rejects.toThrow(/not an inbox/);
    const note = finalizeEvent({ kind: 1, created_at: now, tags: [['p', B]], content: 'public!' }, alice);
    await expect(publishGiftWrap(p.pool, inbox(), note, null)).rejects.toThrow(/kind-1059/);
    await expect(publishGiftWrap(p.pool, inbox(), { ...wrap, content: 'tampered' }, null)).rejects.toThrow(/kind-1059/);
    // The game server's identity proof (kind 22242) can never be published.
    const proof = finalizeEvent(makeAuthEvent('wss://rumble.example/ws', 'game-challenge'), alice);
    await expect(publishGiftWrap(p.pool, inbox(), proof, null)).rejects.toThrow(/kind-1059/);
    expect(p.calls).toHaveLength(0);
  });

  it('relay AUTH: signed only for the inbox relay that asked, never for anything else', async () => {
    const signer = await signerFor(alice);
    const set = inbox();
    const p = publisher({ 'wss://inbox1.example/': 'auth', 'wss://inbox2.example/': 'ok' });
    const r = await publishGiftWrap(p.pool, set, await wrapOf(), inboxRelayAuth(signer, set));
    expect(r.accepted).toHaveLength(2);
    expect(p.calls[0].authed).toEqual(['wss://inbox1.example/']);
    const auth = inboxRelayAuth(signer, set);
    const ok = await auth(makeAuthEvent('wss://inbox2.example', 'c'));
    expect(ok).toMatchObject({ kind: 22242, pubkey: A });
    for (const bad of [makeAuthEvent('wss://rumble.example/ws', 'game-challenge'), makeAuthEvent('wss://elsewhere.example', 'c'), { ...makeAuthEvent('wss://inbox1.example', 'c'), kind: 1 }, { ...makeAuthEvent('wss://inbox1.example', 'c'), content: 'x' }, { ...makeAuthEvent('wss://inbox1.example', 'c'), tags: [...makeAuthEvent('wss://inbox1.example', 'c').tags, ['p', B]] }, makeAuthEvent('wss://inbox1.example', '')])
      await expect(auth(bad)).rejects.toThrow(/refused/);
  });
});
