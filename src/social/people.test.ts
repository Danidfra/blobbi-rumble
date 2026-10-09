/**
 * Finding people (M8C-C): what typed text is (identifier, NIP-05, a name),
 * NIP-05 resolution with every refusal, the read-only follow list,
 * matching and ranking, and a NIP-50 search whose answers are re-matched
 * here. Throwaway TEST keys.
 */
import type { Filter } from 'nostr-tools/filter';
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { PEOPLE, classifyQuery, findFollowList, matchTier, nip05Label, parseFollows, rankMatches, resolveNip05, searchProfiles } from './people';
import { BoundedPool, type PoolLike } from './pool';
import { parseProfile } from './profile';

const now = Math.floor(Date.now() / 1000);
const person = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};
const me = person();
const alice = person();
const bob = person();
const profile = (sk: Uint8Array, content: object, at = now - 100) => finalizeEvent({ kind: 0, created_at: at, tags: [], content: JSON.stringify(content) }, sk);
const follows = (sk: Uint8Array, tags: string[][], at = now - 100) => finalizeEvent({ kind: 3, created_at: at, tags, content: '' }, sk);

/** A fake network: what each relay holds; `down` relays answer nothing; a `search` filter is matched on content unless the relay `ignoresSearch`. */
function network(holds: Record<string, NostrEvent[]>, opts: { down?: string[]; ignoresSearch?: string[] } = {}) {
  const asked: { relays: string[]; filter: Filter }[] = [];
  const pool: PoolLike = {
    async querySync(relays, filter) {
      asked.push({ relays, filter });
      const out: NostrEvent[] = [];
      for (const r of relays) {
        if (opts.down?.includes(r)) continue;
        for (const ev of holds[r] ?? []) {
          if (filter.kinds && !filter.kinds.includes(ev.kind)) continue;
          if (filter.authors && !filter.authors.includes(ev.pubkey)) continue;
          if (filter.search && !opts.ignoresSearch?.includes(r) && !ev.content.toLowerCase().includes(filter.search.toLowerCase())) continue;
          out.push(ev);
        }
      }
      return out;
    },
    close() {},
  };
  return { pool, asked };
}
const LOOKUP = ['wss://lookup1.example/', 'wss://lookup2.example/'];

/** A fake fetch: a map of URL → { status, body }; anything else is a network failure. */
function fetcher(routes: Record<string, { status?: number; body?: unknown; delayMs?: number }>) {
  const calls: string[] = [];
  const fn = async (url: string, init: { signal: AbortSignal }) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error('network');
    if (r.delayMs) await new Promise((res, rej) => {
      const t = setTimeout(res, r.delayMs);
      init.signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
    });
    return { status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  return { fn, calls };
}

describe('what was typed', () => {
  it('an npub or nprofile (with or without nostr:, any case) names one pubkey; a broken one is invalid', () => {
    expect(classifyQuery(npubEncode(alice.pk))).toEqual({ kind: 'identifier', recipient: { pubkey: alice.pk, hints: [] } });
    expect(classifyQuery(` nostr:${npubEncode(alice.pk).toUpperCase()} `)).toMatchObject({ kind: 'identifier', recipient: { pubkey: alice.pk } });
    const np = nprofileEncode({ pubkey: bob.pk, relays: ['wss://r.example/'] });
    expect(classifyQuery(np)).toEqual({ kind: 'identifier', recipient: { pubkey: bob.pk, hints: ['wss://r.example/'] } });
    expect(classifyQuery('npub1notvalid')).toEqual({ kind: 'invalid', why: 'bad-identifier' });
    expect(classifyQuery(`${npubEncode(alice.pk).slice(0, -1)}x`)).toEqual({ kind: 'invalid', why: 'bad-identifier' });
  });

  it('name@domain and a bare domain are NIP-05 (lowercased, @ prefix allowed); short text is too short; anything else is a name', () => {
    expect(classifyQuery('Bob@Example.com')).toEqual({ kind: 'nip05', identifier: 'bob@example.com' });
    expect(classifyQuery('@bob@example.com')).toEqual({ kind: 'nip05', identifier: 'bob@example.com' });
    expect(classifyQuery('example.com')).toEqual({ kind: 'nip05', identifier: 'example.com' });
    expect(classifyQuery('')).toEqual({ kind: 'empty' });
    expect(classifyQuery('   ')).toEqual({ kind: 'empty' });
    expect(classifyQuery('a')).toEqual({ kind: 'invalid', why: 'too-short' });
    expect(classifyQuery('  Not   A Sage ')).toEqual({ kind: 'name', text: 'Not A Sage' });
    expect(classifyQuery('x'.repeat(500))).toEqual({ kind: 'name', text: 'x'.repeat(PEOPLE.maxSearch) });
    expect(classifyQuery(42)).toEqual({ kind: 'empty' });
  });
});

describe('NIP-05', () => {
  const URL_ = 'https://example.com/.well-known/nostr.json?name=bob';
  it('resolves a name through its domain (hex pubkey, wss hints at most three); a bare domain asks for _', async () => {
    const f = fetcher({ [URL_]: { body: { names: { bob: alice.pk }, relays: { [alice.pk]: ['wss://a.example', 'ws://insecure.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'] } } } });
    expect(await resolveNip05(f.fn, 'Bob@Example.com')).toEqual({ pubkey: alice.pk, relays: ['wss://a.example', 'wss://b.example', 'wss://c.example'] });
    const root = fetcher({ 'https://example.com/.well-known/nostr.json?name=_': { body: { names: { _: bob.pk } } } });
    expect(await resolveNip05(root.fn, 'example.com')).toEqual({ pubkey: bob.pk, relays: [] });
    expect(nip05Label('_@example.com')).toBe('example.com');
    expect(nip05Label('bob@example.com')).toBe('bob@example.com');
  });

  it('a name the domain answers under another case still matches; a missing, non-hex or npub pubkey does not', async () => {
    expect(await resolveNip05(fetcher({ [URL_]: { body: { names: { Bob: alice.pk } } } }).fn, 'bob@example.com')).toMatchObject({ pubkey: alice.pk });
    expect(await resolveNip05(fetcher({ [URL_]: { body: { names: { carol: alice.pk } } } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { body: { names: { bob: npubEncode(alice.pk) } } } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { body: { names: { bob: 'zz' } } } }).fn, 'bob@example.com')).toBeNull();
  });

  it('a redirect, a non-200, broken JSON, an oversize body, a network failure, a timeout or a bad identifier: null, never a throw', async () => {
    expect(await resolveNip05(fetcher({ [URL_]: { status: 0, body: '' } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { status: 302, body: '' } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { status: 404, body: '' } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { body: '{not json' } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({ [URL_]: { body: { names: { bob: alice.pk }, pad: 'x'.repeat(70_000) } } }).fn, 'bob@example.com')).toBeNull();
    expect(await resolveNip05(fetcher({}).fn, 'bob@example.com')).toBeNull();
    const slow = fetcher({ [URL_]: { body: { names: { bob: alice.pk } }, delayMs: 200 } });
    expect(await resolveNip05(slow.fn, 'bob@example.com', { timeoutMs: 20 })).toBeNull();
    expect(await resolveNip05(fetcher({}).fn, 'not an identifier')).toBeNull();
    expect(await resolveNip05(fetcher({}).fn, 'bob@')).toBeNull();
  });
});

describe('the follow list (read only)', () => {
  it('well-formed p tags, de-duplicated, in order, never the author, bounded; nothing else counts', () => {
    const ev = follows(me.sk, [
      ['p', alice.pk, 'wss://r.example', 'alice'],
      ['p', bob.pk],
      ['p', alice.pk],
      ['p', me.pk],
      ['p', alice.pk.toUpperCase()],
      ['e', bob.pk],
      ['p'],
      ['p', 'nothex'],
    ]);
    // Tags a relay could still deliver (the pool checks signatures; the parser must not trust shapes).
    (ev.tags as unknown[]).push(['p', 42], 'p', null);
    expect(parseFollows(ev)).toEqual([alice.pk, bob.pk]);
    expect(parseFollows(null)).toEqual([]);
    expect(parseFollows(profile(me.sk, {}))).toEqual([]);
    const many = follows(me.sk, Array.from({ length: PEOPLE.maxFollows + 50 }, () => ['p', person().pk]));
    expect(parseFollows(many)).toHaveLength(PEOPLE.maxFollows);
  });

  it('is found on the lookup relays (newest wins), or on the user’s own write relays; nothing or relays down: null', async () => {
    const old = follows(me.sk, [['p', alice.pk]], now - 1000);
    const fresh = follows(me.sk, [['p', bob.pk]], now - 10);
    const n = network({ [LOOKUP[0]]: [old], [LOOKUP[1]]: [fresh] });
    expect((await findFollowList(new BoundedPool(n.pool), me.pk, { lookupRelays: LOOKUP }))?.id).toBe(fresh.id);
    const outbox = finalizeEvent({ kind: 10002, created_at: now - 100, tags: [['r', 'wss://mine.example/']], content: '' }, me.sk);
    const n2 = network({ [LOOKUP[0]]: [outbox], 'wss://mine.example/': [fresh] });
    expect((await findFollowList(new BoundedPool(n2.pool), me.pk, { lookupRelays: LOOKUP }))?.id).toBe(fresh.id);
    expect(n2.asked.at(-1)?.relays).toEqual(['wss://mine.example/']);
    expect(await findFollowList(new BoundedPool(network({}).pool), me.pk, { lookupRelays: LOOKUP })).toBeNull();
    expect(await findFollowList(new BoundedPool(network({ [LOOKUP[0]]: [fresh] }, { down: LOOKUP }).pool), me.pk, { lookupRelays: LOOKUP })).toBeNull();
    // Someone else's list is never taken for mine.
    expect(await findFollowList(new BoundedPool(network({ [LOOKUP[0]]: [follows(alice.sk, [['p', bob.pk]])] }).pool), me.pk, { lookupRelays: LOOKUP })).toBeNull();
  });
});

describe('matching and ranking', () => {
  const p = (c: object) => parseProfile(profile(alice.sk, c), now)!;
  it('exact name, then prefix, then substring, then the NIP-05 local part, then NIP-05 anywhere; case-insensitive; else nothing', () => {
    expect(matchTier(p({ name: 'NotASage' }), 'notasage')).toBe(0);
    expect(matchTier(p({ display_name: 'NotASage' }), 'nota')).toBe(1);
    expect(matchTier(p({ name: 'The NotASage' }), 'sage')).toBe(2);
    expect(matchTier(p({ name: 'x', nip05: 'sage@example.com' }), 'sage')).toBe(3);
    expect(matchTier(p({ name: 'x', nip05: 'bob@sage.example' }), 'sage')).toBe(4);
    expect(matchTier(p({ name: 'x' }), 'sage')).toBeNull();
    expect(matchTier(null, 'sage')).toBeNull();
    expect(matchTier(p({ name: 'x' }), '  ')).toBeNull();
  });

  it('ranks by tier, then followed, then pubkey; two people with the same name both stay', () => {
    const a = { pubkey: 'b'.repeat(64), tier: 0, followed: false };
    const b = { pubkey: 'a'.repeat(64), tier: 0, followed: false };
    const c = { pubkey: 'c'.repeat(64), tier: 0, followed: true };
    const d = { pubkey: 'd'.repeat(64), tier: 1, followed: true };
    expect(rankMatches([a, d, b, c]).map((x) => x.pubkey[0])).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('NIP-50 search', () => {
  const SEARCH = ['wss://search1.example/', 'wss://search2.example/'];
  it('asks the search relays for kind 0 with the text; keeps only what matches here, newest per pubkey; duplicates fold', async () => {
    const older = profile(alice.sk, { name: 'NotASage' }, now - 500);
    const newer = profile(alice.sk, { name: 'NotASage', display_name: 'Not A Sage' }, now - 50);
    const other = profile(bob.sk, { name: 'sagebrush' });
    const n = network({ [SEARCH[0]]: [older, other], [SEARCH[1]]: [newer, other] });
    const r = await searchProfiles(new BoundedPool(n.pool), 'notasage', { relays: SEARCH, now });
    expect(n.asked[0].filter).toEqual({ kinds: [0], search: 'notasage', limit: PEOPLE.searchLimit });
    expect(r.map((x) => [x.profile.pubkey, x.event.id])).toEqual([[alice.pk, newer.id]]);
  });

  it('a relay that ignores the search field sends anything: unrelated profiles, other kinds and junk are dropped', async () => {
    const junk = network({ [SEARCH[0]]: [profile(bob.sk, { name: 'Unrelated' }), follows(bob.sk, [['p', alice.pk]]), profile(alice.sk, { name: 'x'.repeat(20_000) })] }, { ignoresSearch: SEARCH });
    expect(await searchProfiles(new BoundedPool(junk.pool), 'notasage', { relays: SEARCH, now })).toEqual([]);
  });

  it('too short: nothing asked; relays down or empty: an empty list, never an error', async () => {
    const n = network({}, { down: SEARCH });
    expect(await searchProfiles(new BoundedPool(n.pool), 'n', { relays: SEARCH })).toEqual([]);
    expect(n.asked).toHaveLength(0);
    expect(await searchProfiles(new BoundedPool(n.pool), 'notasage', { relays: SEARCH })).toEqual([]);
    expect(n.asked).toHaveLength(1);
  });
});
