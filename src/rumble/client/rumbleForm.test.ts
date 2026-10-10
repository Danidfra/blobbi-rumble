/**
 * The Rumble form (M9B): Blobbi identity ≠ Blobbi form. A V3 adult is
 * itself; a V3 egg or baby takes the adult body of the same identity; a V1
 * or V2 Blobbi takes the V3 identity of its own address (the kit's seed
 * rule) in its own colours; an unknown generation has no form. The form
 * depends on the address alone, never on the event's id, time, name, stats
 * or stage; the same Blobbi is the same form on every device (a pinned
 * vector). The kit builds a legacy form exactly as a native one, with the
 * same animator, and no form touches the gameplay body. Throwaway TEST keys,
 * and one fixed pubkey for the vector.
 */
import { buildEggTags, deriveBlobbiV3Seed, getCanonicalBlobbiD } from '@blobbi-kit/core';
import { BLOBBI_GAMEPLAY_PROFILE, BlobbiAnimator, createBlobbiIdentity, resolveBlobbiIdentity } from '@blobbi-kit/3d';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { GAMEPLAY_PROFILE, RUMBLE_BODY } from '../profile';
import { collectBlobbis, type OwnedBlobbi } from './blobbis';
import { RUMBLE_FORM_VERSION, declarationOf, lookFromSlotForm, planLooks, rumbleFormOf } from './rumbleForm';

const now = Math.floor(Date.now() / 1000);
const me = generateSecretKey();
const ME = getPublicKey(me);
const PET = ['0123456789', 'abcdefabcd'];

function event(sk: Uint8Array, petId: string, opts: { name?: string; stage?: 'egg' | 'baby' | 'adult'; gen?: 'v1' | 'v2' | 'v3'; at?: number; tags?: string[][]; seedTag?: string } = {}): NostrEvent {
  const pk = getPublicKey(sk);
  const at = opts.at ?? now - 1000;
  let tags = buildEggTags(pk, petId, at, opts.name ?? 'Puck', { visualGeneration: opts.gen ?? 'v3' });
  if (opts.stage) tags = tags.map((t) => (t[0] === 'stage' ? ['stage', opts.stage!] : t));
  // A V1 / V2 seed tag is written once and kept by every republish: fixtures pin it the same way.
  if (opts.seedTag) tags = tags.map((t) => (t[0] === 'seed' ? ['seed', opts.seedTag!] : t));
  if (opts.tags) tags = [...tags, ...opts.tags];
  return finalizeEvent({ kind: 31124, created_at: at, tags, content: '' }, sk);
}
const owned = (sk: Uint8Array, petId: string, opts: Parameters<typeof event>[2] = {}): OwnedBlobbi => collectBlobbis([event(sk, petId, opts)], getPublicKey(sk))[0];

describe('the form a Blobbi takes in Rumble', () => {
  it('a V3 adult is its own identity, native; a V3 egg or baby takes the adult body of the same identity', () => {
    const adult = rumbleFormOf(owned(me, PET[0], { stage: 'adult' }), ME)!;
    expect(adult).toMatchObject({ derivation: 'native', ownColors: false, blobbi: { owner: ME, d: getCanonicalBlobbiD(ME, PET[0]), stage: 'adult', generation: 'v3' } });
    expect(adult.look).toEqual({ seed: deriveBlobbiV3Seed(ME, adult.blobbi.d), algorithm: 1 });
    for (const stage of ['egg', 'baby'] as const) {
      const young = rumbleFormOf(owned(me, PET[0], { stage }), ME)!;
      expect(young.derivation).toBe('adult-stage');
      expect(young.look).toEqual(adult.look);
      expect(young.key).toBe(adult.key);
      expect(young.blobbi.stage).toBe(stage);
    }
  });

  it('a V1 or V2 Blobbi, at any stage, takes the V3 identity of its own address, in its own colours', () => {
    for (const gen of ['v1', 'v2'] as const)
      for (const stage of ['egg', 'baby', 'adult'] as const) {
        const b = owned(me, PET[1], { gen, stage });
        const f = rumbleFormOf(b, ME)!;
        expect(f.derivation).toBe('legacy');
        expect(f.ownColors).toBe(true);
        expect(f.look.seed).toBe(deriveBlobbiV3Seed(ME, b.d));
        expect(f.look.colors).toEqual({ base: b.visual.baseColor.toLowerCase(), secondary: b.visual.secondaryColor.toLowerCase(), eye: b.visual.eyeColor.toLowerCase() });
        expect(f.blobbi).toMatchObject({ stage, generation: gen });
        // The kit builds exactly that: the seed's body, the stated colours, nothing else inferred but what was not stated.
        const r = resolveBlobbiIdentity(f.look);
        expect(r.identity.seed).toBe(f.look.seed);
        expect(r.identity.colors).toMatchObject(f.look.colors!);
        expect(r.inferred.filter((x) => /^colors\.(base|secondary|eye)$/.test(x))).toEqual([]);
        expect(r.inferred.every((x) => x.startsWith('traits.') || x === 'colors.accent')).toBe(true);
      }
  });

  it('the same identity is the same form; another address is another form; a name, care, stage, time or id change changes nothing', () => {
    const seedTag = 'c'.repeat(64);
    const base = rumbleFormOf(owned(me, PET[0], { gen: 'v2', seedTag }), ME)!;
    const variants = [
      owned(me, PET[0], { gen: 'v2', seedTag, name: 'Renamed' }),
      owned(me, PET[0], { gen: 'v2', seedTag, stage: 'adult' }),
      owned(me, PET[0], { gen: 'v2', seedTag, at: now - 5 }),
      owned(me, PET[0], { gen: 'v2', seedTag, tags: [['hunger', '3'], ['happiness', '99'], ['experience', '500'], ['last_interaction', String(now)]] }),
    ];
    for (const v of variants) {
      const f = rumbleFormOf(v, ME)!;
      expect(f.look).toEqual(base.look);
      expect(f.key).toBe(base.key);
    }
    expect(rumbleFormOf(owned(me, PET[1], { gen: 'v2', seedTag }), ME)!.look.seed).not.toBe(base.look.seed);
    const other = generateSecretKey();
    expect(rumbleFormOf(owned(other, PET[0], { gen: 'v2', seedTag }), getPublicKey(other))!.look.seed).not.toBe(base.look.seed);
    // Native V3: likewise, and a hatch or an evolution keeps the look.
    const v3 = rumbleFormOf(owned(me, PET[0], { stage: 'egg' }), ME)!;
    expect(rumbleFormOf(owned(me, PET[0], { stage: 'adult', name: 'Grown', at: now - 1 }), ME)!.look).toEqual(v3.look);
  });

  it('a pinned vector: one fixed address is one fixed form, on every device (the kit’s seed rule, version 1)', () => {
    const pk = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
    const d = 'blobbi-7e7e9c42a91b-0123456789';
    expect(RUMBLE_FORM_VERSION).toBe(1);
    expect(deriveBlobbiV3Seed(pk, d)).toBe('733708a7163ea30acf3101451fd8178f49ee1bc3f593797e4b212d974b5d77ff');
    const b: OwnedBlobbi = { d, name: 'Vector', stage: 'baby', generation: 'v1', visual: { stage: 'baby', visualGeneration: 'v1', baseColor: '#AABBCC', secondaryColor: '#112233', eyeColor: '#445566', pattern: 'solid', specialMark: 'none', size: 'medium' }, updatedAt: 0, rumbleReady: false, unsupported: false };
    const f = rumbleFormOf(b, pk)!;
    expect(f.look).toEqual({ seed: '733708a7163ea30acf3101451fd8178f49ee1bc3f593797e4b212d974b5d77ff', algorithm: 1, colors: { base: '#aabbcc', secondary: '#112233', eye: '#445566' } });
    expect(f.key).toBe('v1:733708a7163ea30acf3101451fd8178f49ee1bc3f593797e4b212d974b5d77ff:#aabbcc#112233#445566');
    // The same identity's traits are the kit's, from the seed, whatever the colours.
    expect(createBlobbiIdentity(f.look.seed).traits).toEqual(resolveBlobbiIdentity(f.look).identity.traits);
  });

  it('no form: an unknown generation, a V3 whose kit seed disagrees with its address, no address; bad legacy colours fall back to the kit’s palette', () => {
    const unknown = owned(me, PET[0], { gen: 'v1', tags: [['visual_generation', 'v9']] });
    expect(unknown.unsupported).toBe(true);
    expect(rumbleFormOf(unknown, ME)).toBeNull();
    const v3 = owned(me, PET[0]);
    expect(rumbleFormOf({ ...v3, visual: { ...v3.visual, v3: { seed: 'f'.repeat(64), algorithm: 1 } } }, ME)).toBeNull();
    expect(rumbleFormOf({ ...v3, d: '' }, ME)).toBeNull();
    expect(rumbleFormOf(null as unknown as OwnedBlobbi, ME)).toBeNull();
    const legacy = owned(me, PET[1], { gen: 'v1' });
    const f = rumbleFormOf({ ...legacy, visual: { ...legacy.visual, baseColor: 'red', secondaryColor: '#12345', eyeColor: 'javascript:alert(1)' } }, ME)!;
    expect(f.ownColors).toBe(false);
    expect(f.look).toEqual({ seed: deriveBlobbiV3Seed(ME, legacy.d), algorithm: 1 });
    expect(f.key).toBe(`v1:${f.look.seed}`);
  });
});

describe('what a form may not touch', () => {
  it('no form carries or changes a gameplay number: the body is the kit’s profile, pinned, the same for every fighter', () => {
    const f = rumbleFormOf(owned(me, PET[0], { gen: 'v2' }), ME)!;
    const words = JSON.stringify(f).toLowerCase();
    for (const w of ['capsule', 'mass', 'speed', 'jump', 'punch', 'grab', 'throw', 'reach', 'force', 'health', 'stat']) expect(words, w).not.toContain(w);
    expect(BLOBBI_GAMEPLAY_PROFILE).toMatchObject(GAMEPLAY_PROFILE);
    expect(RUMBLE_BODY).toMatchObject(GAMEPLAY_PROFILE);
    const src = readFileSync(join(__dirname, 'rumbleForm.ts'), 'utf8');
    expect(src).not.toMatch(/profile|physics|sim\/|combat|tuning|Math\.random|Date\.now|created_at|\.id\b/);
  });

  it('the kit animates a legacy form exactly as a native one: one animator, one state machine, whatever the look', () => {
    const script = [
      { dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: false, impact: 0 },
      { dt: 1 / 60, speed: 1.4, grounded: true, verticalVelocity: 0, jumped: false, landed: false, impact: 0 },
      { dt: 1 / 60, speed: 1.4, grounded: false, verticalVelocity: 4, jumped: true, landed: false, impact: 0 },
      { dt: 1 / 60, speed: 1.4, grounded: false, verticalVelocity: -2, jumped: false, landed: false, impact: 0 },
      { dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: true, impact: 2 },
    ];
    const run = () => {
      const a = new BlobbiAnimator();
      const states: string[] = [];
      for (const step of script) for (let i = 0; i < 12; i++) a.update(step), states.push(a.state);
      return states;
    };
    // The animator takes no identity at all: the same inputs are the same states for every form.
    expect(run()).toEqual(run());
    expect(new Set(run())).toEqual(new Set(['idle', 'walk', 'jump', 'fall', 'land']));
  });
});

describe('which fighter wears what (M9C: every slot, from the roster)', () => {
  const form = rumbleFormOf(owned(me, PET[0]), ME)!;
  const other = rumbleFormOf(owned(me, PET[1], { gen: 'v2' }), ME)!;
  const want = (entries: [string, { key: string; look: typeof form.look }][]) => new Map(entries);
  it('a slot whose wanted key differs changes; the same key again builds nothing; a slot wanting nothing goes back to the default', () => {
    let p = planLooks(new Map(), want([['P1', form]]));
    expect(p.changes).toEqual([{ slot: 'P1', look: form.look, key: form.key }]);
    expect(planLooks(p.next, want([['P1', form]])).changes).toEqual([]);
    p = planLooks(p.next, want([['P1', other]]));
    expect(p.changes).toEqual([{ slot: 'P1', look: other.look, key: other.key }]);
    expect(planLooks(p.next, new Map())).toEqual({ next: new Map(), changes: [{ slot: 'P1', look: null, key: null }] });
    expect(planLooks(new Map(), new Map()).changes).toEqual([]);
  });
  it('several fighters at once: each slot independently; a room change is a new roster, so old slots are undressed and new ones dressed', () => {
    const p = planLooks(new Map([['P1', form.key], ['P2', other.key]]), want([['P2', other], ['P3', form]]));
    expect(p.changes).toEqual([
      { slot: 'P3', look: form.look, key: form.key },
      { slot: 'P1', look: null, key: null },
    ]);
    expect([...p.next]).toEqual([
      ['P2', other.key],
      ['P3', form.key],
    ]);
  });
});

describe('the form on the wire (M9C)', () => {
  it('the declaration names the address, the generation, the worn colours and the name, never the seed; the roster form gives back the same key', () => {
    const legacy = rumbleFormOf(owned(me, PET[1], { gen: 'v2', name: 'Mara' }), ME)!;
    const decl = declarationOf(legacy);
    expect(decl).toEqual({ v: 1, d: legacy.blobbi.d, gen: 'v2', colors: legacy.look.colors, name: 'Mara' });
    expect(JSON.stringify(decl)).not.toContain(legacy.look.seed);
    const native = rumbleFormOf(owned(me, PET[0], { name: 'Puck' }), ME)!;
    expect(declarationOf(native)).toEqual({ v: 1, d: native.blobbi.d, gen: 'v3', name: 'Puck' });
    // As the server would carry it (the seed derived there): the same look and the same key as the owner's page made.
    const fromRoster = lookFromSlotForm({ ...decl, seed: legacy.look.seed });
    expect(fromRoster).toEqual({ look: legacy.look, key: legacy.key, name: 'Mara' });
    expect(lookFromSlotForm({ ...declarationOf(native), seed: native.look.seed })).toEqual({ look: native.look, key: native.key, name: 'Puck' });
  });
  it('a roster form is untrusted: another version, a bad seed, a wrong generation or junk is the default; bad colours are dropped, V3 colours ignored', () => {
    const seed = 'a'.repeat(64);
    expect(lookFromSlotForm({ v: 2, seed, gen: 'v3' })).toBeNull();
    expect(lookFromSlotForm({ v: 1, seed: 'zz', gen: 'v3' })).toBeNull();
    expect(lookFromSlotForm({ v: 1, seed, gen: 'v9' })).toBeNull();
    expect(lookFromSlotForm(null)).toBeNull();
    expect(lookFromSlotForm('x')).toBeNull();
    expect(lookFromSlotForm({ v: 1, seed, gen: 'v1', colors: { base: 'red', secondary: '#000000', eye: '#111111' } })).toEqual({ look: { seed, algorithm: 1 }, key: `v1:${seed}`, name: null });
    expect(lookFromSlotForm({ v: 1, seed, gen: 'v3', colors: { base: '#aaaaaa', secondary: '#bbbbbb', eye: '#cccccc' } })!.look).toEqual({ seed, algorithm: 1 });
    expect(lookFromSlotForm({ v: 1, seed, gen: 'v2', colors: { base: '#AAAAAA', secondary: '#bbbbbb', eye: '#cccccc' }, name: 'x'.repeat(500) })).toMatchObject({ look: { colors: { base: '#aaaaaa' } }, name: null });
  });
});
