/**
 * Who to invite (M8C-C): the follow list as a compact window, search by
 * identifier / NIP-05 / name (local first, then the search relays, after a
 * pause), stale answers ignored, bounded results, NIP-05 shown only once
 * confirmed, an explicit selection that can be changed, and the recipient
 * handed to the unchanged sender. Throwaway TEST keys.
 */
import type { Filter } from 'nostr-tools/filter';
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { ProfileDirectory } from '../../social/directory';
import { parseRecipient } from '../../social/keys';
import { BoundedPool, type PoolLike } from '../../social/pool';
import { FINDER, PeopleFinder } from './people';

const now = Math.floor(Date.now() / 1000);
const person = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};
const me = person();
const sage = person();
const sage2 = person();
const bob = person();
const profile = (sk: Uint8Array, content: object, at = now - 100) => finalizeEvent({ kind: 0, created_at: at, tags: [], content: JSON.stringify(content) }, sk);
const follows = (sk: Uint8Array, pks: string[]) => finalizeEvent({ kind: 3, created_at: now - 100, tags: pks.map((p) => ['p', p]), content: '' }, sk);
const LOOKUP = ['wss://lookup.example/'];
const SEARCH = ['wss://search.example/'];

function setup(opts: { holds?: Record<string, NostrEvent[]>; down?: string[]; fetch?: Record<string, { status?: number; body?: unknown }> | null; searchDelayMs?: number } = {}) {
  const asked: { relays: string[]; filter: Filter }[] = [];
  const pool: PoolLike = {
    async querySync(relays, filter) {
      asked.push({ relays, filter });
      if (filter.search && opts.searchDelayMs) await new Promise((r) => setTimeout(r, opts.searchDelayMs));
      const out: NostrEvent[] = [];
      for (const r of relays) {
        if (opts.down?.includes(r)) continue;
        for (const ev of opts.holds?.[r] ?? []) {
          if (filter.kinds && !filter.kinds.includes(ev.kind)) continue;
          if (filter.authors && !filter.authors.includes(ev.pubkey)) continue;
          if (filter.search && !ev.content.toLowerCase().includes(filter.search.toLowerCase())) continue;
          out.push(ev);
        }
      }
      return out;
    },
    close() {},
  };
  const fetched: string[] = [];
  const fetchFn =
    opts.fetch === null
      ? null
      : async (url: string) => {
          fetched.push(url);
          const r = opts.fetch?.[url];
          if (!r) throw new Error('network');
          return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
        };
  const lookup = new BoundedPool(pool);
  const directory = new ProfileDirectory(lookup, { lookupRelays: LOOKUP, batchMs: 1 });
  let changes = 0;
  const finder = new PeopleFinder({ me: me.pk, lookup, directory, lookupRelays: LOOKUP, searchRelays: SEARCH, fetch: fetchFn, debounceMs: 20, onChange: () => changes++ });
  return { finder, directory, asked, fetched, changes: () => changes };
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await settle(10);
};

describe('people you follow', () => {
  it('nothing is read until the section is on screen; then the list, most recently followed first, a page at a time, profiles only for the rows shown', async () => {
    const pks = Array.from({ length: 20 }, () => person().pk);
    const t = setup({ holds: { [LOOKUP[0]]: [follows(me.sk, pks)] } });
    await settle();
    expect(t.asked).toHaveLength(0);
    t.finder.ensureFollows();
    t.finder.ensureFollows();
    await until(() => t.finder.state.follows.phase === 'ready');
    const f = t.finder.state.follows;
    expect(f.total).toBe(20);
    expect(f.rows.map((r) => r.pubkey)).toEqual([...pks].reverse().slice(0, FINDER.page));
    expect(f.rows.every((r) => r.followed)).toBe(true);
    expect(f.more).toBe(true);
    await settle();
    const profileAsks = t.asked.filter((a) => a.filter.kinds?.includes(0) && !a.filter.search);
    expect(profileAsks).toHaveLength(1);
    expect(profileAsks[0].filter.authors).toHaveLength(FINDER.page);
    t.finder.showMore();
    expect(t.finder.state.follows.rows).toHaveLength(2 * FINDER.page);
    t.finder.showMore();
    expect(t.finder.state.follows.rows).toHaveLength(20);
    expect(t.finder.state.follows.more).toBe(false);
  });

  it('no list, an empty list, or relays down: said so, nothing else; a huge list stops at the cap for display', async () => {
    const none = setup({ holds: {} });
    none.finder.ensureFollows();
    await until(() => none.finder.state.follows.phase !== 'loading');
    expect(none.finder.state.follows.phase).toBe('none');
    const empty = setup({ holds: { [LOOKUP[0]]: [follows(me.sk, [])] } });
    empty.finder.ensureFollows();
    await until(() => empty.finder.state.follows.phase !== 'loading');
    expect(empty.finder.state.follows.phase).toBe('empty');
    const down = setup({ holds: { [LOOKUP[0]]: [follows(me.sk, [bob.pk])] }, down: LOOKUP });
    down.finder.ensureFollows();
    await until(() => down.finder.state.follows.phase !== 'loading');
    expect(down.finder.state.follows.phase).toBe('none');
    const big = setup({ holds: { [LOOKUP[0]]: [follows(me.sk, Array.from({ length: 300 }, () => person().pk))] } });
    big.finder.ensureFollows();
    await until(() => big.finder.state.follows.phase === 'ready');
    for (let i = 0; i < 20; i++) big.finder.showMore();
    expect(big.finder.state.follows.rows).toHaveLength(FINDER.maxShown);
    expect(big.finder.state.follows.more).toBe(false);
  });

  it('a profile that never loads still shows as a row (the npub is enough); a loaded one updates in place', async () => {
    const t = setup({ holds: { [LOOKUP[0]]: [follows(me.sk, [sage.pk, bob.pk]), profile(sage.sk, { name: 'NotASage' })] } });
    t.finder.ensureFollows();
    await until(() => t.finder.state.follows.phase === 'ready');
    expect(t.finder.state.follows.rows.map((r) => r.pubkey)).toEqual([bob.pk, sage.pk]);
    await until(() => t.directory.get(sage.pk) !== undefined);
    expect(t.directory.get(sage.pk)?.name).toBe('NotASage');
    expect(t.directory.get(bob.pk)).toBeNull();
    expect(t.finder.state.follows.rows).toHaveLength(2);
  });
});

describe('search', () => {
  it('an npub or nprofile: one exact person, selected at once, no relay search, hints kept for the sender', async () => {
    const t = setup({ holds: { [LOOKUP[0]]: [profile(sage.sk, { name: 'NotASage' })] } });
    t.finder.setQuery(npubEncode(sage.pk));
    expect(t.finder.state.search).toMatchObject({ phase: 'done', remote: false });
    expect(t.finder.state.search.rows.map((r) => r.pubkey)).toEqual([sage.pk]);
    expect(t.finder.state.selected?.pubkey).toBe(sage.pk);
    expect(t.finder.recipient).toBe(npubEncode(sage.pk));
    await settle();
    expect(t.asked.some((a) => a.filter.search)).toBe(false);
    t.finder.setQuery(nprofileEncode({ pubkey: bob.pk, relays: ['wss://hint.example/'] }));
    expect(t.finder.state.selected?.hints).toEqual(['wss://hint.example/']);
    expect(parseRecipient(t.finder.recipient)).toEqual({ pubkey: bob.pk, hints: ['wss://hint.example/'] });
    t.finder.setQuery('npub1garbage');
    expect(t.finder.state.search.phase).toBe('invalid');
    t.finder.setQuery('n');
    expect(t.finder.state.search.phase).toBe('short');
    t.finder.setQuery('');
    expect(t.finder.state.search.phase).toBe('idle');
  });

  it('a NIP-05: resolved by its domain after the pause, selected, shown as confirmed; a mismatch or a failure says not found', async () => {
    const t = setup({
      holds: { [LOOKUP[0]]: [profile(sage.sk, { name: 'NotASage', nip05: 'sage@example.com' })] },
      fetch: { 'https://example.com/.well-known/nostr.json?name=sage': { body: { names: { sage: sage.pk } } }, 'https://example.com/.well-known/nostr.json?name=other': { body: { names: { other: 'zz' } } } },
    });
    t.finder.setQuery('Sage@Example.com');
    expect(t.finder.state.search.phase).toBe('resolving');
    await until(() => t.finder.state.search.phase === 'done');
    expect(t.finder.state.selected?.pubkey).toBe(sage.pk);
    await until(() => t.finder.state.selected?.nip05 !== null);
    expect(t.finder.state.selected?.nip05).toEqual({ label: 'sage@example.com', status: 'verified' });
    // The domain was asked once for this identifier: not again for the row's own claim.
    expect(t.fetched).toEqual(['https://example.com/.well-known/nostr.json?name=sage']);
    t.finder.setQuery('other@example.com');
    await until(() => t.finder.state.search.phase === 'not-found');
    t.finder.setQuery('nobody@down.example');
    await until(() => t.finder.state.search.phase === 'not-found');
    const noFetch = setup({ fetch: null });
    noFetch.finder.setQuery('sage@example.com');
    await until(() => noFetch.finder.state.search.phase === 'not-found');
  });

  it('a name: local matches at once (follows first), then the search relays after the pause, merged, ranked, capped; nothing per keystroke', async () => {
    const holds: Record<string, NostrEvent[]> = {
      [LOOKUP[0]]: [follows(me.sk, [sage.pk]), profile(sage.sk, { name: 'NotASage' })],
      [SEARCH[0]]: [profile(sage2.sk, { name: 'NotASage' }), profile(sage.sk, { name: 'NotASage' }, now - 500), profile(bob.sk, { name: 'sagebrush' }), ...Array.from({ length: 15 }, () => profile(person().sk, { name: 'a sage' }))],
    };
    const t = setup({ holds });
    t.finder.ensureFollows();
    await until(() => t.directory.get(sage.pk) !== undefined);
    t.finder.setQuery('nota');
    t.finder.setQuery('notas');
    t.finder.setQuery('notasage');
    expect(t.finder.state.search.phase).toBe('searching');
    expect(t.finder.state.search.rows.map((r) => r.pubkey)).toEqual([sage.pk]);
    await until(() => t.finder.state.search.remote);
    const searches = t.asked.filter((a) => a.filter.search);
    expect(searches).toHaveLength(1);
    expect(searches[0]).toMatchObject({ relays: SEARCH, filter: { kinds: [0], search: 'notasage' } });
    const rows = t.finder.state.search.rows;
    // Two people named NotASage both stay; the followed one first; the older duplicate event folds into the one row.
    expect(rows.slice(0, 2).map((r) => [r.pubkey, r.followed])).toEqual([
      [sage.pk, true],
      [sage2.pk, false],
    ]);
    expect(rows.length).toBeLessThanOrEqual(FINDER.maxResults);
    expect(new Set(rows.map((r) => r.pubkey)).size).toBe(rows.length);
    expect(t.finder.state.selected).toBeNull();
    // Search results are now known profiles (so their names show) without another lookup.
    expect(t.directory.get(sage2.pk)?.name).toBe('NotASage');
    t.finder.select(sage2.pk);
    expect(t.finder.state.selected?.pubkey).toBe(sage2.pk);
    t.finder.clearSelection();
    expect(t.finder.state.selected).toBeNull();
  });

  it('a stale answer is ignored: the text changed before the relays answered; stop() ends everything', async () => {
    const t = setup({ holds: { [SEARCH[0]]: [profile(sage.sk, { name: 'NotASage' }), profile(bob.sk, { name: 'Bobby' })] }, searchDelayMs: 80 });
    t.finder.setQuery('notasage');
    await settle(40);
    t.finder.setQuery('bobby');
    await until(() => t.finder.state.search.remote);
    expect(t.finder.state.search.rows.map((r) => r.pubkey)).toEqual([bob.pk]);
    await settle(120);
    expect(t.finder.state.search.rows.map((r) => r.pubkey)).toEqual([bob.pk]);
    t.finder.setQuery('notasage');
    t.finder.stop();
    await settle(150);
    expect(t.finder.state.search.rows).toEqual([]);
  });

  it('search relays down, or none answering: no results, said so, no error; a junk relay answer is dropped', async () => {
    const t = setup({ holds: { [SEARCH[0]]: [profile(bob.sk, { name: 'Unrelated' })] } });
    t.finder.setQuery('notasage');
    await until(() => t.finder.state.search.phase === 'not-found');
    expect(t.finder.state.search.remote).toBe(true);
    const down = setup({ down: SEARCH });
    down.finder.setQuery('notasage');
    await until(() => down.finder.state.search.phase === 'not-found');
  });
});

describe('NIP-05 on rows', () => {
  it('a claimed identifier shows only once its domain confirmed it; an unconfirmed one shows as such; checks are cached and bounded', async () => {
    const t = setup({
      holds: { [LOOKUP[0]]: [follows(me.sk, [sage.pk, bob.pk]), profile(sage.sk, { name: 'NotASage', nip05: 'sage@example.com' }), profile(bob.sk, { name: 'Bob', nip05: '_@bob.example' })] },
      fetch: { 'https://example.com/.well-known/nostr.json?name=sage': { body: { names: { sage: sage.pk } } }, 'https://bob.example/.well-known/nostr.json?name=_': { body: { names: { _: sage.pk } } } },
    });
    t.finder.ensureFollows();
    await until(() => t.finder.state.follows.rows.length === 2 && t.finder.state.follows.rows.every((r) => r.nip05 && r.nip05.status !== 'checking'));
    const by = Object.fromEntries(t.finder.state.follows.rows.map((r) => [r.pubkey, r.nip05]));
    expect(by[sage.pk]).toEqual({ label: 'sage@example.com', status: 'verified' });
    expect(by[bob.pk]).toEqual({ label: 'bob.example', status: 'unverified' });
    expect(t.fetched).toHaveLength(2);
    t.finder.select(sage.pk);
    t.finder.showMore();
    await settle();
    expect(t.fetched).toHaveLength(2);
  });
});
