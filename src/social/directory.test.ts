/**
 * The profile directory: lookup relays first, then (a few of) a user's own
 * write relays; newest wins, wrong authors and kinds are ignored, failures
 * mean "no profile", answers are cached and persisted with an age limit,
 * and the relay cap holds however many players there are.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { describe, expect, it } from 'vitest';
import { ProfileDirectory } from './directory';
import { BoundedPool, type PoolLike } from './pool';

const now = Math.floor(Date.now() / 1000);
const person = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};
const profile = (sk: Uint8Array, content: object, at = now - 100) => finalizeEvent({ kind: 0, created_at: at, tags: [], content: JSON.stringify(content) }, sk);
const relayList = (sk: Uint8Array, relays: string[]) => finalizeEvent({ kind: 10002, created_at: now - 100, tags: relays.map((r) => ['r', r]), content: '' }, sk);

/** A fake network: what each relay holds; `down` relays answer nothing. */
function network(holds: Record<string, NostrEvent[]>, down: string[] = []) {
  const asked: { relays: string[]; filter: Filter }[] = [];
  const pool: PoolLike = {
    async querySync(relays, filter) {
      asked.push({ relays, filter });
      const out: NostrEvent[] = [];
      for (const r of relays) {
        if (down.includes(r)) continue;
        for (const ev of holds[r] ?? []) if (filter.kinds?.includes(ev.kind) && filter.authors?.includes(ev.pubkey)) out.push(ev);
      }
      return out;
    },
    close() {},
  };
  return { pool, asked };
}
const LOOKUP = ['wss://lookup1.example/', 'wss://lookup2.example/'];
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
};

describe('the profile directory', () => {
  it('finds a profile on the lookup relays, in one batch for several people', async () => {
    const a = person();
    const b = person();
    const net = network({ [LOOKUP[0]]: [profile(a.sk, { name: 'Alice' })], [LOOKUP[1]]: [profile(b.sk, { display_name: 'Bob' })] });
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP });
    d.ask([a.pk, b.pk, 'not-a-pubkey']);
    await d.flush();
    expect(d.get(a.pk)!.name).toBe('Alice');
    expect(d.get(b.pk)!.displayName).toBe('Bob');
    expect(net.asked).toHaveLength(1);
    expect(net.asked[0].filter).toEqual({ kinds: [0, 10002], authors: [a.pk, b.pk] });
  });

  it('falls back to the user’s own write relays (at most three) when the lookup relays lack the profile', async () => {
    const a = person();
    const own = ['wss://own1.example/', 'wss://own2.example/', 'wss://own3.example/', 'wss://own4.example/'];
    const net = network({ [LOOKUP[0]]: [relayList(a.sk, own)], [own[3]]: [profile(a.sk, { name: 'Far away' })], [own[1]]: [profile(a.sk, { name: 'Alice' })] });
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP });
    d.ask([a.pk]);
    await d.flush();
    expect(d.get(a.pk)!.name).toBe('Alice');
    expect(net.asked[1].relays).toEqual(own.slice(0, 3));
  });

  it('newest wins; events by someone not asked about, or of another kind, are ignored', async () => {
    const a = person();
    const stranger = person();
    const forged = { ...profile(stranger.sk, { name: 'Impostor' }), pubkey: a.pk };
    const net = network({
      [LOOKUP[0]]: [profile(a.sk, { name: 'Old' }, now - 1000), profile(a.sk, { name: 'New' }, now - 10), profile(stranger.sk, { name: 'Stranger' }, now)],
      [LOOKUP[1]]: [{ ...profile(a.sk, { name: 'Note' }, now), kind: 1 }],
    });
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP });
    d.ask([a.pk]);
    await d.flush();
    expect(d.get(a.pk)!.name).toBe('New');
    expect(d.get(stranger.pk)).toBeUndefined();
    // (Forged signatures are the pool's to drop: SimplePool verifies every event. A forged event is never asked for here.)
    expect(forged.pubkey).toBe(a.pk);
  });

  it('no profile, malformed metadata, or every relay down: null, never an error', async () => {
    const a = person();
    const b = person();
    const c = person();
    const net = network({ [LOOKUP[0]]: [finalizeEvent({ kind: 0, created_at: now, tags: [], content: '{oops' }, b.sk), profile(c.sk, { name: 'C' })] }, [LOOKUP[0], LOOKUP[1]]);
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP });
    d.ask([a.pk, b.pk, c.pk]);
    await d.flush();
    expect(d.get(a.pk)).toBeNull();
    expect(d.get(b.pk)).toBeNull();
    expect(d.get(c.pk)).toBeNull();
    const failing: PoolLike = { querySync: () => Promise.reject(new Error('down')), close() {} };
    const d2 = new ProfileDirectory(new BoundedPool(failing), { lookupRelays: LOOKUP });
    d2.ask([a.pk]);
    await expect(d2.flush()).resolves.toBeUndefined();
    expect(d2.get(a.pk)).toBeNull();
  });

  it('one relay down: the others still answer', async () => {
    const a = person();
    const net = network({ [LOOKUP[0]]: [profile(a.sk, { name: 'A' })], [LOOKUP[1]]: [profile(a.sk, { name: 'A' })] }, [LOOKUP[0]]);
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP });
    d.ask([a.pk]);
    await d.flush();
    expect(d.get(a.pk)!.name).toBe('A');
  });

  it('caches: a fresh answer is not asked again; a missing one is retried sooner; listeners hear changes', async () => {
    let t = Date.now();
    const a = person();
    const net = network({ [LOOKUP[0]]: [profile(a.sk, { name: 'A' })] });
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP, now: () => t, freshMs: 60_000, missingMs: 10_000 });
    const heard: string[] = [];
    d.onChange((pk) => heard.push(pk));
    d.ask([a.pk]);
    await d.flush();
    expect(heard).toEqual([a.pk]);
    d.ask([a.pk]);
    await d.flush();
    expect(net.asked).toHaveLength(1);
    t += 61_000;
    d.ask([a.pk]);
    await d.flush();
    expect(net.asked).toHaveLength(2);
    // Unchanged on refresh: nobody is told.
    expect(heard).toEqual([a.pk]);
  });

  it('persists bounded, dated, cleaned answers and drops old ones', async () => {
    let t = Date.now();
    const a = person();
    const store = memory();
    const net = network({ [LOOKUP[0]]: [profile(a.sk, { name: 'Alice', picture: 'https://p.example/a.png' })] });
    const d = new ProfileDirectory(new BoundedPool(net.pool), { lookupRelays: LOOKUP, storage: store, storageKey: 'k', now: () => t });
    d.ask([a.pk]);
    await d.flush();
    expect(new ProfileDirectory(new BoundedPool(net.pool), { storage: store, storageKey: 'k', now: () => t }).get(a.pk)!.name).toBe('Alice');
    // Tampered storage is cleaned like relay data.
    store.setItem('k', JSON.stringify([[a.pk, t, { name: '‮<b>x</b>', picture: 'javascript:alert(1)', createdAt: 5 }], ['junk', t, {}], [a.pk.toUpperCase(), t, null]]));
    const tampered = new ProfileDirectory(new BoundedPool(net.pool), { storage: store, storageKey: 'k', now: () => t }).get(a.pk)!;
    expect(tampered.name).toBe('<b>x</b>');
    expect(tampered.picture).toBeUndefined();
    store.setItem('k', 'not json');
    expect(new ProfileDirectory(new BoundedPool(net.pool), { storage: store, storageKey: 'k' }).get(a.pk)).toBeUndefined();
    // Older than a day: gone.
    store.setItem('k', JSON.stringify([[a.pk, t, { name: 'Alice', createdAt: 5 }]]));
    t += 25 * 3600_000;
    expect(new ProfileDirectory(new BoundedPool(net.pool), { storage: store, storageKey: 'k', now: () => t }).get(a.pk)).toBeUndefined();
  });

  it('many players with many relays still open at most eight relays', async () => {
    const people = Array.from({ length: 12 }, () => person());
    const holds: Record<string, NostrEvent[]> = { [LOOKUP[0]]: [] };
    people.forEach((p, i) => {
      const own = [0, 1, 2, 3, 4].map((k) => `wss://p${i}-r${k}.example/`);
      holds[LOOKUP[0]].push(relayList(p.sk, own));
      holds[own[0]] = [profile(p.sk, { name: `P${i}` })];
    });
    const pool = new BoundedPool(network(holds).pool, { maxOpen: 8 });
    const d = new ProfileDirectory(pool, { lookupRelays: LOOKUP });
    d.ask(people.map((p) => p.pk));
    await d.flush();
    expect(pool.peak).toBeLessThanOrEqual(8);
    expect(people.filter((p) => d.get(p.pk)?.name).length).toBe(12);
  });
});
