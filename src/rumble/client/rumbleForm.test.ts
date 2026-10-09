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
import { RUMBLE_FORM_VERSION, planLook, rumbleFormOf } from './rumbleForm';

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

describe('which fighter wears what', () => {
  const form = rumbleFormOf(owned(me, PET[0]), ME)!;
  const other = rumbleFormOf(owned(me, PET[1], { gen: 'v2' }), ME)!;
  it('a choice dresses the player’s slot; another choice redresses it; the default, a disconnect or no slot undresses it', () => {
    let p = planLook(null, 'P1', form);
    expect(p).toEqual({ next: { slot: 'P1', key: form.key }, changes: [{ slot: 'P1', form }] });
    expect(planLook(p.next, 'P1', form).changes).toEqual([]);
    p = planLook(p.next, 'P1', other);
    expect(p.changes).toEqual([{ slot: 'P1', form: other }]);
    expect(planLook(p.next, 'P1', null)).toEqual({ next: null, changes: [{ slot: 'P1', form: null }] });
    expect(planLook(p.next, null, other)).toEqual({ next: null, changes: [{ slot: 'P1', form: null }] });
    expect(planLook(null, null, null).changes).toEqual([]);
    expect(planLook(null, 'P2', null).changes).toEqual([]);
  });
  it('a room change moves the form to the new slot and restores the old one; an identity switch is a new form or none', () => {
    const p = planLook({ slot: 'P1', key: form.key }, 'P3', form);
    expect(p.changes).toEqual([
      { slot: 'P1', form: null },
      { slot: 'P3', form },
    ]);
    expect(p.next).toEqual({ slot: 'P3', key: form.key });
    expect(planLook(p.next, 'P3', other).changes).toEqual([{ slot: 'P3', form: other }]);
  });
});
