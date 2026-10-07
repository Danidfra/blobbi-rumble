/**
 * The adult morphology is the kit's, number for number: the fixture's
 * `resolved` block was produced by the kit's own `deriveMorphology`.
 */
import { describe, expect, it } from 'vitest';
import fixtures from '../identity/__fixtures__/kit-fixtures.json';
import { canonicalGenome, generateGenome, MORPHOLOGY_GENES } from '../identity/genome';
import { createBlobbiIdentity, genomeOf } from '../identity/identity';
import { deriveMorphology, MORPHOLOGY_RANGES } from './morphology';

describe('deriveMorphology (port of the kit, adult)', () => {
  for (const fixture of fixtures.seeds) {
    it(`seed ${fixture.seed.slice(0, 8)}… resolves what the kit resolves`, () => {
      const m = deriveMorphology(genomeOf(createBlobbiIdentity(fixture.seed)));
      const r = fixture.resolved;
      expect(m.bodyWidth).toBeCloseTo(r.bodyWidth, 12);
      expect(m.bodyHeight).toBeCloseTo(r.bodyHeight, 12);
      expect(m.eyeSize).toBeCloseTo(r.eyeSize, 12);
      expect(m.eyeHeight).toBeCloseTo(r.eyeHeight, 12);
      expect(m.antennae).toEqual(r.antennae);
      expect(m.horns).toEqual(r.horns);
      expect(m.ears).toEqual(r.ears);
      expect(m.tail).toEqual(r.tail);
      expect(m.freckles).toEqual(r.freckles);
      expect(m.bellyPatch).toEqual(r.bellyPatch);
      expect(m.stripes).toEqual(r.stripes);
      expect(m.gradient).toEqual(r.gradient);
      expect(m.mark).toEqual(r.mark);
      expect(m.spots.length).toBe(r.spots.length);
      m.spots.forEach((spot, i) => {
        const canon = r.spots[i];
        expect(spot.zone).toBe(canon.zone);
        expect(spot.side).toBe(canon.side);
        expect(spot.theta).toBeCloseTo(canon.theta, 6);
        expect(spot.yFraction).toBeCloseTo(canon.yFraction, 10);
        expect(spot.rx).toBeCloseTo(canon.rx, 10);
      });
    });
  }

  it('the canonical genome resolves to every range\'s base', () => {
    const m = deriveMorphology(canonicalGenome());
    for (const name of MORPHOLOGY_GENES) expect(m[name]).toBe(MORPHOLOGY_RANGES[name].base);
    expect(m.antennae).toEqual([]);
    expect(m.horns).toBeNull();
    expect(m.pattern).toBe('solid');
  });

  it('is bounded: an out-of-range or malformed gene is clamped, never leaves the range', () => {
    const genome = generateGenome(fixtures.seeds[0].seed);
    const wild = { ...genome, morphology: { ...genome.morphology, bodyWidth: 99, eyeSize: -99, mouthWidth: NaN } };
    const m = deriveMorphology(wild as typeof genome);
    expect(m.bodyWidth).toBe(MORPHOLOGY_RANGES.bodyWidth.base + MORPHOLOGY_RANGES.bodyWidth.spread);
    expect(m.eyeSize).toBe(MORPHOLOGY_RANGES.eyeSize.base - MORPHOLOGY_RANGES.eyeSize.spread);
    expect(m.mouthWidth).toBe(MORPHOLOGY_RANGES.mouthWidth.base);
  });

  it('different seeds are different individuals of one species', () => {
    const all = fixtures.seeds.map((f) => deriveMorphology(genomeOf(createBlobbiIdentity(f.seed))));
    const widths = new Set(all.map((m) => m.bodyWidth));
    expect(widths.size).toBe(all.length);
    for (const m of all) {
      expect(m.bodyWidth).toBeGreaterThan(0.9);
      expect(m.bodyWidth).toBeLessThan(1.1);
      expect(m.bodyHeight).toBeGreaterThan(0.9);
      expect(m.bodyHeight).toBeLessThan(1.1);
    }
  });
});
