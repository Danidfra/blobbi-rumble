/**
 * The player's Blobbis (M9A): the ecosystem's own rules through the kit (kind
 * 31124 at the owner's address, modern events only, newest per d), ownership
 * by author and signature, every generation listed and unknown ones flagged,
 * relays that answer nothing, and a local choice per identity that survives a
 * reload, never leaks to another identity, and falls back when its Blobbi is
 * gone. Throwaway TEST keys.
 */
import { buildEggTags, getCanonicalBlobbiD } from '@blobbi-kit/core';
import type { Filter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { BoundedPool, type PoolLike } from '../../social/pool';
import { blobbiPreview, lastPreviewError } from './blobbiPreview';
import { BLOBBIS, BlobbiPicker, collectBlobbis, findBlobbis } from './blobbis';

const now = Math.floor(Date.now() / 1000);
const me = generateSecretKey();
const ME = getPublicKey(me);
const other = generateSecretKey();
const OTHER = getPublicKey(other);
const RELAYS = ['wss://blobbi.example/'];

/** A kind-31124 state event as the kit's own egg builder writes it, at a stage, signed by `sk`. */
function blobbi(sk: Uint8Array, petId: string, opts: { name?: string; stage?: 'egg' | 'baby' | 'adult'; gen?: 'v1' | 'v2' | 'v3'; at?: number; tags?: string[][]; drop?: string[] } = {}): NostrEvent {
  const pk = getPublicKey(sk);
  const at = opts.at ?? now - 1000;
  let tags = buildEggTags(pk, petId, at, opts.name ?? `Blob ${petId.slice(0, 4)}`, { visualGeneration: opts.gen ?? 'v3' });
  if (opts.stage) tags = tags.map((t) => (t[0] === 'stage' ? ['stage', opts.stage!] : t));
  if (opts.drop) tags = tags.filter((t) => !opts.drop!.includes(t[0]));
  if (opts.tags) tags = [...tags, ...opts.tags];
  return finalizeEvent({ kind: 31124, created_at: at, tags, content: '' }, sk);
}
const PET = ['0123456789', 'abcdefabcd', 'fedcba0987', '1111111111'];

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
  return { pool: new BoundedPool(pool), asked };
}
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), raw: m };
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await settle();
};

describe('collecting the Blobbis an identity owns', () => {
  it('one, several, none: each modern kind 31124 by the owner is one Blobbi, by name; V3 is what Rumble can build', () => {
    expect(collectBlobbis([], ME)).toEqual([]);
    const one = collectBlobbis([blobbi(me, PET[0], { name: 'Puck' })], ME);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ d: getCanonicalBlobbiD(ME, PET[0]), name: 'Puck', stage: 'egg', generation: 'v3', rumbleReady: true, unsupported: false });
    expect(one[0].visual.v3?.seed).toMatch(/^[0-9a-f]{64}$/);
    const many = collectBlobbis([blobbi(me, PET[0], { name: 'Zed', stage: 'adult' }), blobbi(me, PET[1], { name: 'Amy', stage: 'baby' }), blobbi(me, PET[2], { name: 'Amy', stage: 'egg' })], ME);
    expect(many.map((b) => [b.name, b.stage])).toEqual([
      ['Amy', 'baby'],
      ['Amy', 'egg'],
      ['Zed', 'adult'],
    ]);
  });

  it('ownership is the author and the signature: another key’s Blobbi, a forged author, a bad signature or a claim tag count for nothing', () => {
    const theirs = blobbi(other, PET[0]);
    expect(collectBlobbis([theirs], ME)).toEqual([]);
    expect(collectBlobbis([theirs], OTHER)).toHaveLength(1);
    const forged = { ...theirs, pubkey: ME };
    expect(collectBlobbis([forged], ME)).toEqual([]);
    const mine = blobbi(me, PET[1]);
    expect(collectBlobbis([{ ...mine, sig: mine.sig.replace(/^./, mine.sig[0] === 'a' ? 'b' : 'a') }], ME)).toEqual([]);
    expect(collectBlobbis([{ ...mine, content: 'x' }], ME)).toEqual([]);
    const claiming = blobbi(other, PET[2], { tags: [['p', ME], ['owner', ME]] });
    expect(collectBlobbis([claiming], ME)).toEqual([]);
  });

  it('several versions of one Blobbi: the newest wins (ties: lowest id); an older version delivered twice changes nothing', () => {
    const d = getCanonicalBlobbiD(ME, PET[0]);
    const old = blobbi(me, PET[0], { name: 'Egg', stage: 'egg', at: now - 5000 });
    const mid = blobbi(me, PET[0], { name: 'Baby', stage: 'baby', at: now - 3000 });
    const fresh = blobbi(me, PET[0], { name: 'Adult', stage: 'adult', at: now - 1000 });
    const got = collectBlobbis([old, fresh, mid, old, fresh], ME);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ d, name: 'Adult', stage: 'adult', updatedAt: now - 1000 });
    const twinA = blobbi(me, PET[1], { name: 'A', at: now - 10 });
    const twinB = blobbi(me, PET[1], { name: 'B', at: now - 10 });
    const lowest = twinA.id < twinB.id ? twinA : twinB;
    expect(collectBlobbis([twinA, twinB], ME)[0].name).toBe(lowest.tags.find((t) => t[0] === 'name')![1]);
  });

  it('legacy, invalid and malformed events are hidden, never migrated; junk never throws', () => {
    const legacyD = finalizeEvent({ kind: 31124, created_at: now - 100, tags: [['d', 'blobbi-puck'], ['b', 'blobbi:ecosystem:v1'], ['name', 'Puck'], ['stage', 'adult'], ['state', 'active'], ['last_interaction', String(now - 100)], ['seed', 'a'.repeat(64)]], content: '' }, me);
    const oldApp = blobbi(me, PET[0], { tags: [['incubation_time', '100']] });
    const noNamespace = blobbi(me, PET[1], { drop: ['b'] });
    const noStage = blobbi(me, PET[2], { drop: ['stage'] });
    const badState = blobbi(me, PET[3], { tags: [['state', 'incubating']], drop: ['state'] });
    const wrongKind = finalizeEvent({ kind: 1124, created_at: now - 100, tags: [['a', `31124:${ME}:${getCanonicalBlobbiD(ME, PET[0])}`], ['p', ME], ['b', 'blobbi:ecosystem:v1']], content: '' }, me);
    expect(collectBlobbis([legacyD, oldApp, noNamespace, noStage, badState, wrongKind, null, 42, 'x', {}, { kind: 31124 }, { ...blobbi(me, PET[0]), tags: 'nope' }], ME)).toEqual([]);
  });

  it('mixed generations are all listed (V1 and V2 are 2D only); an unknown generation is shown but flagged and not selectable', () => {
    const v1 = blobbi(me, PET[0], { name: 'One', gen: 'v1', stage: 'adult' });
    const v2 = blobbi(me, PET[1], { name: 'Two', gen: 'v2', stage: 'baby' });
    const v3 = blobbi(me, PET[2], { name: 'Three', gen: 'v3', stage: 'adult' });
    // Built like a V1 (it carries a seed) but naming a generation this app does not know: the kit reads it as V1.
    const v9 = blobbi(me, PET[3], { name: 'Nine', gen: 'v1', tags: [['visual_generation', 'v9']] });
    const got = collectBlobbis([v1, v2, v3, v9], ME);
    expect(got.map((b) => [b.name, b.generation, b.rumbleReady, b.unsupported])).toEqual([
      ['Nine', 'v1', false, true],
      ['One', 'v1', false, false],
      ['Three', 'v3', true, false],
      ['Two', 'v2', false, false],
    ]);
    expect(got[1].visual).toMatchObject({ stage: 'adult', visualGeneration: 'v1' });
    expect(got[1].visual.baseColor).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('names are text, bounded; a Blobbi with an empty name still has one', () => {
    const long = blobbi(me, PET[0], { name: `${'<b>'.repeat(5)}‮${'x'.repeat(100)}` });
    const got = collectBlobbis([long], ME);
    expect(Array.from(got[0].name).length).toBeLessThanOrEqual(BLOBBIS.maxName);
    expect(got[0].name).not.toContain('‮');
  });

  it('asks the Blobbi relays for kind 31124 by this author with the ecosystem marker, bounded; nothing, or relays down, is an empty list', async () => {
    const n = network({ [RELAYS[0]]: [blobbi(me, PET[0]), blobbi(other, PET[1])] });
    const got = await findBlobbis(n.pool, ME, { relays: RELAYS });
    expect(got).toHaveLength(1);
    expect(n.asked[0].filter).toEqual({ kinds: [31124], authors: [ME], '#b': ['blobbi:ecosystem:v1'], limit: BLOBBIS.fetchLimit });
    expect(await findBlobbis(network({}).pool, ME, { relays: RELAYS })).toEqual([]);
    expect(await findBlobbis(network({ [RELAYS[0]]: [blobbi(me, PET[0])] }, RELAYS).pool, ME, { relays: RELAYS })).toEqual([]);
    expect(await findBlobbis(network({}).pool, 'not a pubkey', { relays: RELAYS })).toEqual([]);
  });
});

describe('the small picture', () => {
  it('draws V1, V2 and V3 Blobbis as image data URLs (the kit’s SVG, never page markup)', async () => {
    for (const gen of ['v1', 'v2', 'v3'] as const) {
      const b = collectBlobbis([blobbi(me, PET[0], { gen, stage: 'adult' })], ME)[0];
      const url = await blobbiPreview(b);
      expect(url, `${gen}: ${String(lastPreviewError)}`).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      // Some authored V1 artwork opens with an XML declaration; the picture is still one <svg> root, and never page markup.
      expect(decodeURIComponent(url!.slice(url!.indexOf(',') + 1))).toMatch(/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/);
    }
  });
});

describe('choosing a Blobbi for Rumble', () => {
  const setup = (events: NostrEvent[], storage = memory(), pk = ME, down: string[] = []) => {
    const n = network({ [RELAYS[0]]: events }, down);
    let changes = 0;
    const picker = new BlobbiPicker({ me: pk, lookup: n.pool, relays: RELAYS, storage, preview: async (b) => (b.generation === 'v3' ? `data:${b.d}` : null), onChange: () => changes++ });
    return { picker, storage, n, changes: () => changes };
  };

  it('nothing is read until asked; then the list, no choice by default; one Blobbi selected is remembered for this identity', async () => {
    const t = setup([blobbi(me, PET[0], { name: 'Puck' }), blobbi(me, PET[1], { name: 'Mara', gen: 'v2' })]);
    await settle();
    expect(t.n.asked).toHaveLength(0);
    expect(t.picker.state).toMatchObject({ phase: 'idle', selected: null });
    t.picker.load();
    t.picker.load();
    await until(() => t.picker.state.phase === 'ready');
    expect(t.n.asked).toHaveLength(1);
    expect(t.picker.state.blobbis.map((b) => b.name)).toEqual(['Mara', 'Puck']);
    expect(t.picker.chosen).toBeNull();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    t.picker.select(d);
    expect(t.picker.state.selected).toBe(d);
    expect(t.picker.chosen?.name).toBe('Puck');
    expect(t.storage.raw.get(`rumble:blobbi:v1:${ME}`)).toBe(d);
    // Pictures arrive as they are made, only where the kit can draw one.
    await until(() => !!t.picker.state.previews[d]);
    expect(t.picker.state.previews[getCanonicalBlobbiD(ME, PET[1])]).toBeUndefined();
    // Only a listed Blobbi can be chosen.
    t.picker.select(getCanonicalBlobbiD(ME, PET[3]));
    expect(t.picker.state.selected).toBe(d);
  });

  it('a reload restores the choice while that Blobbi is still listed; a Blobbi that disappeared drops it, says so, and clears the memory', async () => {
    const storage = memory();
    const events = [blobbi(me, PET[0], { name: 'Puck' })];
    const first = setup(events, storage);
    first.picker.load();
    await until(() => first.picker.state.phase === 'ready');
    const d = getCanonicalBlobbiD(ME, PET[0]);
    first.picker.select(d);
    first.picker.stop();
    const again = setup(events, storage);
    expect(again.picker.state.selected).toBe(d);
    again.picker.load();
    await until(() => again.picker.state.phase === 'ready');
    expect(again.picker.state).toMatchObject({ selected: d, dropped: false });
    expect(again.picker.chosen?.name).toBe('Puck');
    again.picker.stop();
    const gone = setup([], storage);
    gone.picker.load();
    await until(() => gone.picker.state.phase === 'none');
    expect(gone.picker.state).toMatchObject({ selected: null, dropped: true, blobbis: [] });
    expect(gone.storage.raw.has(`rumble:blobbi:v1:${ME}`)).toBe(false);
  });

  it('another identity never sees this one’s choice; a corrupt memory is ignored; stop() ends updates', async () => {
    const storage = memory();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    storage.raw.set(`rumble:blobbi:v1:${ME}`, d);
    storage.raw.set(`rumble:blobbi:v1:${OTHER}`, '<script>');
    const mine = setup([blobbi(me, PET[0])], storage);
    expect(mine.picker.state.selected).toBe(d);
    const theirs = setup([blobbi(other, PET[0])], storage, OTHER);
    expect(theirs.picker.state.selected).toBeNull();
    theirs.picker.load();
    await until(() => theirs.picker.state.phase === 'ready');
    expect(theirs.picker.state.selected).toBeNull();
    expect(theirs.picker.state.blobbis[0].d).toBe(getCanonicalBlobbiD(OTHER, PET[0]));
    const stopped = setup([blobbi(me, PET[0])], storage);
    stopped.picker.load();
    stopped.picker.stop();
    await settle();
    await settle();
    expect(stopped.picker.state.phase).toBe('loading');
    expect(stopped.changes()).toBe(1);
  });

  it('back to the default fighter clears the memory; an unsupported generation cannot be chosen; a relay down lists nothing but breaks nothing', async () => {
    const storage = memory();
    const t = setup([blobbi(me, PET[0]), blobbi(me, PET[1], { gen: 'v1', tags: [['visual_generation', 'v9']] })], storage);
    t.picker.load();
    await until(() => t.picker.state.phase === 'ready');
    const d = getCanonicalBlobbiD(ME, PET[0]);
    t.picker.select(d);
    t.picker.useDefault();
    expect(t.picker.state.selected).toBeNull();
    expect(storage.raw.size).toBe(0);
    t.picker.select(getCanonicalBlobbiD(ME, PET[1]));
    expect(t.picker.state.selected).toBeNull();
    const down = setup([blobbi(me, PET[0])], memory(), ME, RELAYS);
    down.picker.load();
    await until(() => down.picker.state.phase === 'none');
    expect(down.picker.state.blobbis).toEqual([]);
    down.picker.load(true);
    expect(down.picker.state.phase).toBe('loading');
  });
});
