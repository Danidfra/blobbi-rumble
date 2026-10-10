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

/**
 * A fake network that reports like nostr-tools: a relay that holds events sends them and EOSE; a `down` relay closes with an
 * error; a `silent` relay never answers (the query's own clock settles it); a `partial` relay sends its events and never EOSE.
 */
function network(holds: Record<string, NostrEvent[]>, opts: { down?: string[]; silent?: string[]; partial?: string[] } = {}) {
  const asked: { relays: string[]; filter: Filter }[] = [];
  const matching = (r: string, filter: Filter) => (holds[r] ?? []).filter((ev) => filter.kinds?.includes(ev.kind) && filter.authors?.includes(ev.pubkey));
  const pool: PoolLike = {
    async querySync(relays, filter) {
      asked.push({ relays, filter });
      return relays.flatMap((r) => (opts.down?.includes(r) || opts.silent?.includes(r) ? [] : matching(r, filter)));
    },
    subscribeMany(relays, filter, params) {
      asked.push({ relays, filter });
      const reasons: { url: string; reason: string }[] = [];
      let closed = false;
      let eoses = 0;
      const finishClose = () => {
        if (!closed && reasons.length === relays.length) {
          closed = true;
          params.onclose?.(reasons);
        }
      };
      setTimeout(() => {
        for (const r of relays) {
          if (opts.silent?.includes(r)) continue;
          if (opts.down?.includes(r)) {
            reasons.push({ url: r, reason: 'connection errored' });
            eoses++;
            continue;
          }
          for (const ev of matching(r, filter)) params.onevent(ev);
          if (!opts.partial?.includes(r)) eoses++;
        }
        if (eoses === relays.length) params.oneose?.();
        finishClose();
      }, 0);
      return {
        close: (reason = 'closed') => {
          for (const r of relays) if (!reasons.some((x) => x.url === r)) reasons.push({ url: r, reason });
          finishClose();
        },
      };
    },
    close() {},
  };
  return { pool: new BoundedPool(pool, { maxWait: 40 }), asked };
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

  it('asks the Blobbi relays for kind 31124 by this author with the ecosystem marker, bounded; an answered empty list is "none"', async () => {
    const n = network({ [RELAYS[0]]: [blobbi(me, PET[0]), blobbi(other, PET[1])] });
    const got = await findBlobbis(n.pool, ME, { relays: RELAYS });
    expect(got.blobbis).toHaveLength(1);
    expect(got.answered).toBe(true);
    expect(n.asked[0].filter).toEqual({ kinds: [31124], authors: [ME], '#b': ['blobbi:ecosystem:v1'], limit: BLOBBIS.fetchLimit });
    expect(await findBlobbis(network({}).pool, ME, { relays: RELAYS })).toEqual({ blobbis: [], answered: true });
    expect(await findBlobbis(network({}).pool, 'not a pubkey', { relays: RELAYS })).toEqual({ blobbis: [], answered: true });
  });

  it('a relay that is down, silent (a time-out) or still sending (a partial answer) has NOT answered: the empty list means nothing', async () => {
    const stored = [blobbi(me, PET[0])];
    const W = { relays: RELAYS, waitMs: 40 };
    expect(await findBlobbis(network({ [RELAYS[0]]: stored }, { down: RELAYS }).pool, ME, W)).toEqual({ blobbis: [], answered: false });
    expect(await findBlobbis(network({ [RELAYS[0]]: stored }, { silent: RELAYS }).pool, ME, W)).toEqual({ blobbis: [], answered: false });
    const partial = await findBlobbis(network({ [RELAYS[0]]: stored }, { partial: RELAYS }).pool, ME, W);
    expect(partial.answered).toBe(false);
    expect(partial.blobbis).toHaveLength(1);
    // Two relays, one down: not a complete answer either (what arrived is still shown).
    const two = ['wss://a.example/', 'wss://b.example/'];
    const mixed = await findBlobbis(network({ [two[0]]: stored, [two[1]]: stored }, { down: [two[1]] }).pool, ME, { relays: two, waitMs: 40 });
    expect(mixed).toMatchObject({ answered: false });
    expect(mixed.blobbis).toHaveLength(1);
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
  const setup = (events: NostrEvent[], storage = memory(), pk = ME, opts: { down?: string[]; silent?: string[]; partial?: string[] } = {}) => {
    const n = network({ [RELAYS[0]]: events }, opts);
    let changes = 0;
    const picker = new BlobbiPicker({ me: pk, lookup: n.pool, relays: RELAYS, storage, preview: async (b) => (b.generation === 'v3' ? `data:${b.d}` : null), retryMs: 1, waitMs: 40, onChange: () => changes++ });
    return { picker, storage, n, changes: () => changes };
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('nothing is read until asked; then the list, no choice by default; one Blobbi selected is remembered for this identity', async () => {
    const t = setup([blobbi(me, PET[0], { name: 'Puck' }), blobbi(me, PET[1], { name: 'Mara', gen: 'v2' })]);
    await tick();
    expect(t.n.asked).toHaveLength(0);
    expect(t.picker.state).toMatchObject({ phase: 'idle', selected: null });
    const p = t.picker.load();
    await t.picker.load();
    await p;
    expect(t.picker.state.phase).toBe('ready');
    expect(t.n.asked).toHaveLength(1);
    expect(t.picker.state.blobbis.map((b) => b.name)).toEqual(['Mara', 'Puck']);
    expect(t.picker.chosen).toBeNull();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    t.picker.select(d);
    expect(t.picker.state.selected).toBe(d);
    expect(t.picker.chosen?.name).toBe('Puck');
    expect(t.storage.raw.get(`rumble:blobbi:v1:${ME}`)).toBe(d);
    await until(() => !!t.picker.state.previews[d]);
    expect(t.picker.state.previews[getCanonicalBlobbiD(ME, PET[1])]).toBeUndefined();
    t.picker.select(getCanonicalBlobbiD(ME, PET[3]));
    expect(t.picker.state.selected).toBe(d);
  });

  it('a reload restores the choice while that Blobbi is listed; an answered list without it keeps the choice, says so, and plays the default meanwhile', async () => {
    const storage = memory();
    const events = [blobbi(me, PET[0], { name: 'Puck' })];
    const first = setup(events, storage);
    await first.picker.load();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    first.picker.select(d);
    first.picker.stop();
    const again = setup(events, storage);
    expect(again.picker.state.selected).toBe(d);
    await again.picker.load();
    expect(again.picker.state).toMatchObject({ phase: 'ready', selected: d, missing: false });
    expect(again.picker.chosen?.name).toBe('Puck');
    again.picker.stop();
    // The relay answers, but without this Blobbi: not proof of anything. The choice stays stored; the form waits.
    const gone = setup([], storage);
    await gone.picker.load();
    expect(gone.picker.state).toMatchObject({ phase: 'none', selected: d, missing: true, blobbis: [] });
    expect(gone.picker.chosen).toBeNull();
    expect(gone.storage.raw.get(`rumble:blobbi:v1:${ME}`)).toBe(d);
    // Another Blobbi listed, the chosen one not: likewise.
    const others = setup([blobbi(me, PET[1])], storage);
    await others.picker.load();
    expect(others.picker.state).toMatchObject({ phase: 'ready', selected: d, missing: true });
    expect(others.picker.chosen).toBeNull();
  });

  it('a relay that is down or silent concludes nothing: the choice stays, nothing is listed as absent, one retry comes by itself, then Look again', async () => {
    const storage = memory();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    storage.raw.set(`rumble:blobbi:v1:${ME}`, d);
    for (const how of [{ down: RELAYS }, { silent: RELAYS }]) {
      const t = setup([blobbi(me, PET[0])], storage, ME, how);
      await t.picker.load();
      expect(t.picker.state).toMatchObject({ phase: 'unreachable', selected: d, missing: false, blobbis: [] });
      expect(t.picker.chosen).toBeNull();
      expect(t.storage.raw.get(`rumble:blobbi:v1:${ME}`)).toBe(d);
      // The one automatic retry (still unanswered here), then no more by itself.
      await until(() => t.n.asked.length === 2);
      await until(() => t.picker.state.phase === 'unreachable');
      await tick();
      await tick();
      expect(t.n.asked).toHaveLength(2);
      t.picker.stop();
    }
    // A partial answer (events without EOSE) is shown but not trusted as complete: the choice is not marked missing.
    const partial = setup([blobbi(me, PET[1])], storage, ME, { partial: RELAYS });
    await partial.picker.load();
    expect(partial.picker.state).toMatchObject({ phase: 'unreachable', selected: d, missing: false });
    partial.picker.stop();
  });

  it('when the relay recovers, Look again lists the chosen Blobbi and the form returns by itself, the same one, without selecting again', async () => {
    const storage = memory();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    storage.raw.set(`rumble:blobbi:v1:${ME}`, d);
    const events = [blobbi(me, PET[0], { name: 'Puck' })];
    const down = new Set(RELAYS);
    const n = network({ [RELAYS[0]]: events }, { down: [...down] });
    const picker = new BlobbiPicker({ me: ME, lookup: n.pool, relays: RELAYS, storage, retryMs: 100_000, waitMs: 40 });
    await picker.load();
    expect(picker.state.phase).toBe('unreachable');
    expect(picker.chosen).toBeNull();
    // The relay is back (the fake's `down` list is read at each query).
    down.clear();
    (n as unknown as { pool: BoundedPool }).pool = n.pool;
    const back = network({ [RELAYS[0]]: events });
    const picker2 = new BlobbiPicker({ me: ME, lookup: back.pool, relays: RELAYS, storage, retryMs: 100_000, waitMs: 40 });
    await picker2.load();
    expect(picker2.state).toMatchObject({ phase: 'ready', selected: d, missing: false });
    expect(picker2.chosen?.name).toBe('Puck');
    expect(picker2.chosen?.d).toBe(d);
    picker.stop();
    picker2.stop();
  });

  it('another identity never sees this one’s choice; a corrupt memory is ignored; stop() ends updates and the retry', async () => {
    const storage = memory();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    storage.raw.set(`rumble:blobbi:v1:${ME}`, d);
    storage.raw.set(`rumble:blobbi:v1:${OTHER}`, '<script>');
    const mine = setup([blobbi(me, PET[0])], storage);
    expect(mine.picker.state.selected).toBe(d);
    const theirs = setup([blobbi(other, PET[0])], storage, OTHER);
    expect(theirs.picker.state.selected).toBeNull();
    await theirs.picker.load();
    expect(theirs.picker.state.selected).toBeNull();
    expect(theirs.picker.state.blobbis[0].d).toBe(getCanonicalBlobbiD(OTHER, PET[0]));
    const stopped = setup([blobbi(me, PET[0])], storage, ME, { down: RELAYS });
    const p = stopped.picker.load();
    stopped.picker.stop();
    await p;
    await tick();
    await tick();
    expect(stopped.picker.state.phase).toBe('loading');
    expect(stopped.n.asked).toHaveLength(1);
    expect(stopped.changes()).toBe(1);
  });

  it('back to the default fighter is the one way the memory goes; an unsupported generation cannot be chosen', async () => {
    const storage = memory();
    const t = setup([blobbi(me, PET[0]), blobbi(me, PET[1], { gen: 'v1', tags: [['visual_generation', 'v9']] })], storage);
    await t.picker.load();
    const d = getCanonicalBlobbiD(ME, PET[0]);
    t.picker.select(d);
    expect(storage.raw.size).toBe(1);
    t.picker.useDefault();
    expect(t.picker.state.selected).toBeNull();
    expect(storage.raw.size).toBe(0);
    t.picker.select(getCanonicalBlobbiD(ME, PET[1]));
    expect(t.picker.state.selected).toBeNull();
  });
});
