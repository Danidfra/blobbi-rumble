/**
 * THE PLAYGROUND CONSUMES THE PUBLISHED PACKAGE. These tests import
 * `@blobbi-kit/3d` by its package name (resolved through its `exports` to
 * the installed `dist/`), never a source path, and exercise the surface the
 * playground uses.
 */
import { describe, expect, it } from 'vitest';
import { BLOBBI_GAMEPLAY_PROFILE, EMOTIONS, MOTION_STATES, buildBodySurface, buildBodyVertexData, canonicalBlobbiSeed, createBlobbiIdentity, resolveBlobbiIdentity, UNIT } from '@blobbi-kit/3d';
import { seedFromLabel } from './playground/seeds';

describe('@blobbi-kit/3d, as a package', () => {
  it('resolves through the package exports, not a local copy', async () => {
    const resolved = import.meta.resolve('@blobbi-kit/3d');
    expect(resolved).toMatch(/node_modules\/@blobbi-kit\/3d\/dist\/index\.js$/);
    expect(resolved).not.toMatch(/\/src\//);
    expect(resolved).not.toMatch(/blobbi-kit\/packages\//);
  });

  it('creates the lab\'s named seeds as the same individuals the 2D lab shows', () => {
    const abc = createBlobbiIdentity(seedFromLabel('abc123'));
    expect(abc.colors.base).toBe('#f5ba3b');
    expect(abc.traits).toMatchObject({ ears: 'pointed', tail: 'nub', specialMark: 'sparkle', freckles: true });
    expect(canonicalBlobbiSeed(abc.seed)).toBe(abc.seed);
  });

  it('builds a deterministic body for an identity', () => {
    const { identity } = resolveBlobbiIdentity(seedFromLabel('blobbi-1'));
    const body = (m: ReturnType<typeof resolveBlobbiIdentity>['identity']) => {
      const surface = buildBodySurface({ bodyWidth: 1, bodyHeight: 1, topWidth: 1, belly: 1, roundness: 1, lean: 0 });
      return { seed: m.seed, positions: buildBodyVertexData(surface).positions as number[] };
    };
    expect(body(identity)).toEqual(body(identity));
    expect(UNIT).toBeCloseTo(1 / 630.66717, 9);
  });

  it('exposes what the playground drives: emotions, motion states and the normalized gameplay profile', () => {
    expect(EMOTIONS).toContain('happy');
    expect(MOTION_STATES).toContain('run');
    expect(BLOBBI_GAMEPLAY_PROFILE.capsuleHeight).toBe(1.05);
  });
});
