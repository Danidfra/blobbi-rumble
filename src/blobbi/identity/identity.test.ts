/**
 * THE PORT IS THE KIT'S. Every number here was produced by the blobbi-kit
 * procedural engine itself (`packages/blobbi-renderer/src/procedural`,
 * algorithm 1) and written to `__fixtures__/kit-fixtures.json`. If this
 * port drifts from the kit by one bit, a 3D Blobbi stops being the same
 * individual as its 2D drawing, and these tests say so.
 */
import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/kit-fixtures.json';
import { createRng, geneRng, hashSeed } from './rng';
import { generateGenome, canonicalGenome, clampGene, MORPHOLOGY_GENES } from './genome';
import { createBlobbiIdentity, genomeOf, resolveBlobbiIdentity } from './identity';
import { derivePalette, generateColors } from './colors';
import { canonicalBlobbiSeed, seedFromLabel } from './seed';

describe('rng (port of the kit)', () => {
  it('hashes a string to the same four words', () => {
    for (const [str, words] of Object.entries(fixtures.hashSeed)) expect(hashSeed(str)).toEqual(words);
  });
  it('produces the same stream', () => {
    const r = createRng(fixtures.rng.seed);
    expect(Array.from({ length: 6 }, () => r.next())).toEqual(fixtures.rng.next);
  });
  it('a keyed gene stream gives the same gene', () => {
    expect(geneRng(fixtures.geneRng.seed, fixtures.geneRng.key).centered()).toBe(fixtures.geneRng.centered);
  });
});

describe('genome and identity (port of the kit)', () => {
  for (const fixture of fixtures.seeds) {
    it(`seed ${fixture.seed.slice(0, 8)}… creates the identity the kit creates`, () => {
      expect(createBlobbiIdentity(fixture.seed)).toEqual(fixture.identity);
    });
    it(`seed ${fixture.seed.slice(0, 8)}… derives the genes the kit derives`, () => {
      const genome = generateGenome(fixture.seed);
      expect(genome.morphology).toEqual(fixture.morphology);
      expect(genome.traits).toEqual(fixture.traits);
      expect(genome.scheme).toEqual(fixture.scheme);
    });
    it(`seed ${fixture.seed.slice(0, 8)}… paints with the kit's palette`, () => {
      const palette = derivePalette(fixture.identity.colors) as unknown as Record<string, string>;
      // The 3D palette drops the kit's baby-only roles (babyLight, babyDark, babyEye*, babyCheek); every role it keeps is the kit's.
      for (const [role, hex] of Object.entries(fixture.palette)) if (role in palette) expect(palette[role], role).toBe(hex);
      expect(Object.keys(palette).length).toBeGreaterThan(20);
    });
  }

  it('is deterministic: the same seed, the same identity and genome, every time', () => {
    const seed = fixtures.seeds[0].seed;
    expect(createBlobbiIdentity(seed)).toEqual(createBlobbiIdentity(seed));
    expect(generateGenome(seed)).toEqual(generateGenome(seed));
    expect(createBlobbiIdentity(seed.toUpperCase())).toEqual(createBlobbiIdentity(seed));
  });

  it('every gene is in [-1, 1] and the canonical genome is all zeros', () => {
    for (const fixture of fixtures.seeds) {
      const genome = generateGenome(fixture.seed);
      for (const name of MORPHOLOGY_GENES) expect(Math.abs(genome.morphology[name])).toBeLessThanOrEqual(1);
    }
    const canon = canonicalGenome();
    for (const name of MORPHOLOGY_GENES) expect(canon.morphology[name]).toBe(0);
    expect(clampGene(4)).toBe(1);
    expect(clampGene(NaN)).toBe(0);
  });

  it('a stated identity wins over the seed; a gap is filled from the seed and reported', () => {
    const seed = fixtures.seeds[1].seed;
    const own = createBlobbiIdentity(seed);
    const { identity, inferred } = resolveBlobbiIdentity({ seed, algorithm: 1, colors: { base: '#ff0000', secondary: '#880000', eye: '#111111' }, traits: { ...own.traits, horns: 'top' } });
    expect(identity.colors).toEqual({ base: '#ff0000', secondary: '#880000', eye: '#111111' });
    expect(identity.traits.horns).toBe('top');
    expect(inferred).toEqual([]);
    const partial = resolveBlobbiIdentity({ seed });
    expect(partial.identity).toEqual(own);
    expect(partial.inferred).toContain('colors');
    expect(partial.inferred).toContain('traits.horns');
    // The genome of a stated identity carries the statement, and still the seed's micro-geometry.
    const genome = genomeOf(identity);
    expect(genome.traits.horns.kind).toBe('top');
    expect(genome.traits.horns.length).toBe(generateGenome(seed).traits.horns.length);
    expect(genome.colors.base).toBe('#ff0000');
  });

  it('refuses what is not a seed, and never guesses', () => {
    expect(() => createBlobbiIdentity('abc')).toThrow(TypeError);
    expect(() => createBlobbiIdentity('')).toThrow(TypeError);
    expect(() => resolveBlobbiIdentity({ seed: fixtures.seeds[0].seed, algorithm: 2 })).toThrow(TypeError);
    expect(canonicalBlobbiSeed(' ' + fixtures.seeds[0].seed)).toBeUndefined();
  });

  it('a label stands for one real seed, the lab\'s', () => {
    expect(seedFromLabel('abc123')).toMatch(/^[0-9a-f]{64}$/);
    expect(seedFromLabel('abc123')).toBe(seedFromLabel('abc123'));
    expect(seedFromLabel(fixtures.seeds[0].seed.toUpperCase())).toBe(fixtures.seeds[0].seed);
    // The lab's `abc123` is the yellow Blobbi with pointed ears, a nub tail and a sparkle.
    const abc = createBlobbiIdentity(seedFromLabel('abc123'));
    expect(abc.colors.base).toBe('#f5ba3b');
    expect(abc.traits).toMatchObject({ ears: 'pointed', tail: 'nub', specialMark: 'sparkle', freckles: true });
  });

  it('generated colours are always inside the body guardrails', () => {
    for (let i = 0; i < 40; i++) {
      const colors = generateColors(i.toString(16).padStart(64, '0'));
      expect(colors.base).toMatch(/^#[0-9a-f]{6}$/);
      expect(colors.secondary).toMatch(/^#[0-9a-f]{6}$/);
      expect(colors.eye).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
