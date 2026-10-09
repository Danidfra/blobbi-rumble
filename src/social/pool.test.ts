/**
 * The bounded relay pool: never more than `maxOpen` relays, idle ones
 * closed, busy ones never closed under a query, failures are empty answers.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { BoundedPool, type PoolLike } from './pool';
import { relayUrl, writeRelays } from './relays';

function fakePool(answer: (relays: string[]) => Promise<NostrEvent[]> = async () => []) {
  const closed: string[] = [];
  const asked: string[][] = [];
  const pool: PoolLike = {
    querySync: (relays) => {
      asked.push(relays);
      return answer(relays);
    },
    close: (relays) => closed.push(...relays),
  };
  return { pool, closed, asked };
}
const relays = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `wss://r${i + from}.example/`);

describe('the bounded pool', () => {
  it('admits at most maxOpen relays, de-duplicated and canonical, skipping bad URLs', async () => {
    const f = fakePool();
    const p = new BoundedPool(f.pool, { maxOpen: 8 });
    await p.query([...relays(12), 'wss://r0.example/', 'https://not-a-relay.example', 'javascript:x', 'wss://u:p@x.example'], {});
    expect(f.asked[0]).toHaveLength(8);
    expect(p.openRelays).toHaveLength(8);
    expect(p.peak).toBe(8);
  });

  it('makes room by closing the least recently used idle relay', async () => {
    let t = 0;
    const f = fakePool();
    const p = new BoundedPool(f.pool, { maxOpen: 3, now: () => t });
    await p.query(relays(3), {});
    t = 10;
    await p.query(['wss://r1.example/', 'wss://r2.example/'], {});
    t = 20;
    await p.query(['wss://new.example'], {});
    expect(f.closed).toEqual(['wss://r0.example/']);
    expect(p.openRelays.sort()).toEqual(['wss://new.example/', 'wss://r1.example/', 'wss://r2.example/']);
    expect(p.peak).toBe(3);
  });

  it('never closes a relay a query is still on; leaves the new one out instead', async () => {
    let release!: () => void;
    const f = fakePool(() => new Promise((r) => (release = () => r([]))));
    const p = new BoundedPool(f.pool, { maxOpen: 2 });
    const slow = p.query(relays(2), {});
    const admitted = p.admit(['wss://other.example']);
    expect(admitted).toEqual([]);
    expect(f.closed).toEqual([]);
    release();
    await slow;
  });

  it('sweeps idle relays and can close everything', async () => {
    let t = 0;
    const f = fakePool();
    const p = new BoundedPool(f.pool, { idleMs: 1000, now: () => t });
    await p.query(relays(2), {});
    t = 500;
    p.sweep();
    expect(p.openRelays).toHaveLength(2);
    t = 2000;
    p.sweep();
    expect(p.openRelays).toHaveLength(0);
    expect(f.closed.sort()).toEqual(relays(2));
    await p.query(relays(3), {});
    p.closeAll();
    expect(p.openRelays).toHaveLength(0);
  });

  it('a failing pool is an empty answer, not an error', async () => {
    const p = new BoundedPool(fakePool(() => Promise.reject(new Error('all down'))).pool);
    await expect(p.query(relays(2), {})).resolves.toEqual([]);
    expect(await new BoundedPool(fakePool().pool).query([], {})).toEqual([]);
  });
});

describe('relay URLs and lists', () => {
  it('canonicalises relay URLs and refuses anything else', () => {
    expect(relayUrl('wss://Relay.Example/')).toBe('wss://relay.example/');
    expect(relayUrl('relay.example')).toBe('wss://relay.example/');
    expect(relayUrl('wss://u:p@relay.example')).toBeNull();
    expect(relayUrl('ftp://relay.example')).toBeNull();
    expect(relayUrl(42)).toBeNull();
    expect(relayUrl(`wss://${'a'.repeat(300)}.example`)).toBeNull();
  });

  it('reads at most three secure write relays from a NIP-65 list', () => {
    const ev = (tags: string[][]): NostrEvent => ({ kind: 10002, tags, content: '', created_at: 1, pubkey: 'a'.repeat(64), id: '', sig: '' });
    const list = ev([['r', 'wss://a.example'], ['r', 'wss://b.example', 'read'], ['r', 'wss://c.example', 'write'], ['r', 'ws://insecure.example'], ['r', 'wss://a.example/'], ['p', 'x'], ['r', 'wss://d.example'], ['r', 'wss://e.example']]);
    expect(writeRelays(list)).toEqual(['wss://a.example/', 'wss://c.example/', 'wss://d.example/']);
    expect(writeRelays(null)).toEqual([]);
    expect(writeRelays({ ...list, kind: 3 })).toEqual([]);
  });
});
