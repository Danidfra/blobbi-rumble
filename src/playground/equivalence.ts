/**
 * TEMPORARY: the extraction proof. Builds the same seeds with the PACKAGE
 * (`@blobbi-kit/3d`) and with this repository's local reference
 * implementation (`src/blobbi`), in the real engine, and compares every
 * mesh's vertex positions by name. Exposed as `window.blobbiEquivalence`.
 * Removed once the local implementation is retired.
 */
import type { Scene } from '@babylonjs/core/scene';
import { createBlobbi3D as packageCreate, createCanonicalBlobbi3D as packageCanonical } from '@blobbi-kit/3d';
import { createBlobbi3D as localCreate, createCanonicalBlobbi3D as localCanonical } from '../blobbi/renderer/createBlobbi3D';
import { seedFromLabel } from './seeds';

export interface EquivalenceReport {
  seed: string;
  meshes: number;
  mismatched: string[];
  missing: string[];
  identitySame: boolean;
  skinSame: boolean;
}

export function installEquivalenceProbe(scene: Scene) {
  const compare = (label: string | null): EquivalenceReport => {
    const seed = label === null ? 'canonical' : seedFromLabel(label);
    const a = label === null ? packageCanonical(scene, { name: 'eq-a' }) : packageCreate(seed, scene, { name: 'eq-a' });
    const b = label === null ? localCanonical(scene, { name: 'eq-b' }) : localCreate(seed, scene, { name: 'eq-b' });
    a.setExpression('happy', 0);
    b.setExpression('happy', 0);
    a.update({ dt: 0.016, speed: 0, grounded: true, verticalVelocity: 0 });
    b.update({ dt: 0.016, speed: 0, grounded: true, verticalVelocity: 0 });
    const byName = (list: typeof a.meshes, prefix: string) => new Map(list.map((m) => [m.name.replace(prefix, ''), m]));
    const am = byName(a.meshes, 'eq-a');
    const bm = byName(b.meshes, 'eq-b');
    const mismatched: string[] = [];
    const missing: string[] = [];
    for (const [name, mesh] of am) {
      const other = bm.get(name);
      if (!other) {
        missing.push(name);
        continue;
      }
      const p = mesh.getVerticesData('position') ?? [];
      const q = other.getVerticesData('position') ?? [];
      let bad = p.length !== q.length;
      for (let i = 0; !bad && i < p.length; i++) if (Math.abs(p[i] - q[i]) > 1e-9) bad = true;
      if (bad) mismatched.push(name);
    }
    const skinA = (a.skin.getContext() as CanvasRenderingContext2D).getImageData(0, 0, 256, 256).data;
    const skinB = (b.skin.getContext() as CanvasRenderingContext2D).getImageData(0, 0, 256, 256).data;
    let skinSame = skinA.length === skinB.length;
    for (let i = 0; skinSame && i < skinA.length; i++) if (skinA[i] !== skinB[i]) skinSame = false;
    // The kit's morphology carries the baby's palette roles too; compare the identity, and every morphology field but the palette.
    const stripPalette = ({ palette: _palette, stage: _stage, ...rest }: Record<string, unknown>) => rest;
    const identitySame = JSON.stringify(a.identity) === JSON.stringify(b.identity) && JSON.stringify(stripPalette(a.morphology as never)) === JSON.stringify(stripPalette(b.morphology as never));
    const report = { seed, meshes: am.size, mismatched, missing, identitySame, skinSame };
    a.dispose();
    b.dispose();
    return report;
  };
  Object.assign(window, { blobbiEquivalence: (labels: (string | null)[]) => labels.map(compare) });
}
