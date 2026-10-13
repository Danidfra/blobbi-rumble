/**
 * L4.4B: what a fighter costs the GPU, on real kit Blobbis (a Babylon
 * NullEngine; the 2D canvas the skin is painted on is a stand-in). The face
 * casts no shadow and everything else does, once; the skin is 1024 × 512;
 * every Blobbi has its own skin and materials (one changing never touches
 * another); and a fighter disposed leaves nothing behind: no mesh,
 * material, texture or shadow caster, however many come and go, change
 * looks or are rebuilt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { seedFromLabel } from '../../playground/seeds';
import { FighterView, SKIN_WIDTH, shadowCastersOf } from './fighterView';

/** A 2D context that accepts every call (the skin and tags are painted on it; nothing reads the pixels here). */
const ctx2d: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === 'measureText' ? () => ({ width: 40 }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : ctx2d),
  apply: () => ctx2d,
  set: () => true,
});

let engine: NullEngine | null = null;
afterEach(() => {
  engine?.dispose();
  engine = null;
});

function world() {
  engine = new NullEngine();
  (engine as unknown as { createCanvas: (w: number, h: number) => unknown }).createCanvas = (w, h) => ({ width: w, height: h, style: {}, getContext: () => ctx2d });
  // A NullEngine reports a 512 texel limit; a real GPU's is far higher (the skin's size is what is checked here).
  (engine.getCaps() as { maxTextureSize: number }).maxTextureSize = 16384;
  const scene = new Scene(engine);
  // Babylon's one scene-wide default material, made on first use: part of the baseline, not of any fighter.
  void scene.defaultMaterial;
  const sun = new DirectionalLight('sun', new Vector3(-0.32, -1, -0.42).normalize(), scene);
  const shadows = new ShadowGenerator(1024, sun);
  const casters = () => shadows.getShadowMap()!.renderList as AbstractMesh[];
  const counts = () => ({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length, casters: casters().length });
  return { scene, shadows, casters, counts };
}
const FACE = /-(left|right)-eye-|-(left|right)-brow$|-mouth/;

describe('a fighter’s shadow (L4.4B)', () => {
  it('the face (eyes, lids, brows, mouth) casts none; the body, arms, feet and every other part cast, once each', () => {
    const w = world();
    const v = new FighterView('P1', 'P1', w.scene, seedFromLabel('P1'), w.shadows);
    const face = v.blobbi.face.root.getChildMeshes();
    expect(face.length).toBeGreaterThanOrEqual(15);
    expect(face.every((m) => FACE.test(m.name))).toBe(true);
    const casting = w.casters();
    for (const m of face) expect(casting).not.toContain(m);
    // Everything else of the Blobbi casts: the silhouette is unchanged.
    const body = v.blobbi.meshes.filter((m) => !face.includes(m));
    expect(body.length).toBeGreaterThanOrEqual(5);
    for (const m of body) expect(casting).toContain(m);
    for (const name of ['P1-skin-mesh', 'P1-left-foot-mesh', 'P1-right-foot-mesh', 'P1-left-arm-mesh', 'P1-right-arm-mesh']) expect(casting.map((m) => m.name)).toContain(name);
    expect(new Set(casting).size).toBe(casting.length);
    expect(shadowCastersOf(v.blobbi)).toEqual(body);
  });

  it('holds for very different Blobbis (ears, horns, tails, antennae: all cast; no face part ever does)', () => {
    const w = world();
    for (let i = 0; i < 24; i++) {
      const v = new FighterView(`F${i}`, `F${i}`, w.scene, seedFromLabel(`variety-${i}`), w.shadows);
      const face = new Set(v.blobbi.face.root.getChildMeshes());
      const casting = new Set(w.casters());
      for (const m of v.blobbi.meshes) expect(casting.has(m)).toBe(!face.has(m));
      v.dispose();
    }
    expect(w.casters()).toHaveLength(0);
  });

  it('without a shadow generator nothing is registered anywhere', () => {
    const w = world();
    new FighterView('P1', 'P1', w.scene, seedFromLabel('P1'));
    expect(w.casters()).toHaveLength(0);
  });
});

describe('a fighter’s skin and materials (L4.4B)', () => {
  it('the skin is 1024 × 512 (a quarter of the kit’s 2048 × 1024), unless asked otherwise', () => {
    const w = world();
    const v = new FighterView('P1', 'P1', w.scene, seedFromLabel('P1'), w.shadows);
    expect(SKIN_WIDTH).toBe(1024);
    expect(v.blobbi.skin.getSize()).toEqual({ width: 1024, height: 512 });
    const big = new FighterView('P2', 'P2', w.scene, seedFromLabel('P2'), w.shadows, 2048);
    expect(big.blobbi.skin.getSize()).toEqual({ width: 2048, height: 1024 });
  });

  it('every Blobbi has its own skin and materials: one changing its face or look never touches another', () => {
    const w = world();
    const a = new FighterView('P1', 'P1', w.scene, seedFromLabel('same'), w.shadows);
    const b = new FighterView('P2', 'P2', w.scene, seedFromLabel('same'), w.shadows);
    expect(a.blobbi.skin).not.toBe(b.blobbi.skin);
    const mats = new Set(a.blobbi.materials.all);
    for (const m of b.blobbi.materials.all) expect(mats.has(m)).toBe(false);
    const bDiffuse = b.blobbi.materials.body.diffuseTexture;
    const bLimb = b.blobbi.materials.limb.diffuseColor.clone();
    a.blobbi.setExpression('sad', 0);
    a.blobbi.setSleeping(true);
    for (let i = 0; i < 30; i++) a.blobbi.update({ dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: false, impact: 0 });
    a.blobbi.materials.limb.diffuseColor.set(1, 0, 0);
    expect(b.blobbi.materials.body.diffuseTexture).toBe(bDiffuse);
    expect(b.blobbi.materials.limb.diffuseColor.equals(bLimb)).toBe(true);
  });
});

describe('a fighter’s resources come and go with it (L4.4B)', () => {
  it('disposed, a fighter leaves no mesh, material, texture or shadow caster', () => {
    const w = world();
    const before = w.counts();
    const v = new FighterView('P1', 'P1', w.scene, seedFromLabel('P1'), w.shadows);
    const during = w.counts();
    expect(during.meshes).toBeGreaterThan(before.meshes);
    expect(during.textures).toBeGreaterThan(before.textures);
    v.dispose();
    expect(w.counts()).toEqual(before);
  });

  it('eight fighters joining and leaving, changing looks and being rebuilt, round after round: nothing accumulates', () => {
    const w = world();
    const base = w.counts();
    let views = Array.from({ length: 8 }, (_, i) => new FighterView(`P${i + 1}`, `P${i + 1}`, w.scene, seedFromLabel(`P${i + 1}`), w.shadows));
    const eight = w.counts();
    // Eight Blobbis: 8 × (Blobbi meshes − face) casters, nothing more.
    expect(eight.casters).toBe(views.reduce((n, v) => n + shadowCastersOf(v.blobbi).length, 0));
    for (let round = 0; round < 3; round++) {
      // Half the room leaves; they come back; everyone changes look (a new body each time, as `setLook` does).
      for (const v of views.splice(4)) v.dispose();
      for (let i = 4; i < 8; i++) views.push(new FighterView(`P${i + 1}`, `P${i + 1}`, w.scene, seedFromLabel(`P${i + 1}`), w.shadows));
      views = views.map((old, i) => {
        const next = new FighterView(old.id, old.label, w.scene, seedFromLabel(`look-${round}-${i}`), w.shadows);
        old.dispose();
        return next;
      });
    }
    // Whatever looks they ended with, the shadow list holds exactly their casters, once each.
    const after = w.counts();
    expect(after.casters).toBe(views.reduce((n, v) => n + shadowCastersOf(v.blobbi).length, 0));
    expect(new Set(w.casters()).size).toBe(after.casters);
    // Everyone gone: back to the empty scene; the same eight again: exactly what the first eight cost.
    for (const v of views) v.dispose();
    expect(w.counts()).toEqual(base);
    views = Array.from({ length: 8 }, (_, i) => new FighterView(`P${i + 1}`, `P${i + 1}`, w.scene, seedFromLabel(`P${i + 1}`), w.shadows));
    expect(w.counts()).toEqual(eight);
  }, 60_000);
});
