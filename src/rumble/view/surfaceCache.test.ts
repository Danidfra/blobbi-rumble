/**
 * L4.6-FIX1: the face's skin lookups, cached. On real kit Blobbis (a
 * NullEngine; the skin canvas a stand-in): the cached answers are the
 * exact ones to within micrometres; a still face asks nothing; once a
 * Blobbi has blinked (or was warmed for it), later blinks ask the exact
 * surface nothing new; the lattice stays bounded; and a fighter's eyes,
 * lids and mouth sit where an uncached Blobbi's do.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { createBlobbi3D, type AnimatorInput } from '@blobbi-kit/3d';
import { NEUTRAL_POSE } from '@blobbi-kit/renderer/procedural';
import { seedFromLabel } from '../../playground/seeds';
import { SURFACE_CACHE, cacheFaceSurface, warmBlink } from './surfaceCache';
import { FighterView } from './fighterView';

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
function scene() {
  engine = new NullEngine();
  (engine as unknown as { createCanvas: (w: number, h: number) => unknown }).createCanvas = (w, h) => ({ width: w, height: h, style: {}, getContext: () => ctx2d });
  (engine.getCaps() as { maxTextureSize: number }).maxTextureSize = 16384;
  return new Scene(engine);
}
const still: AnimatorInput = { dt: 1 / 60, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: false, impact: 0 };
const blinkThrough = (b: { blink(): void; update(i: AnimatorInput): void }) => {
  b.blink();
  for (let i = 0; i < 16; i++) b.update(still);
};

describe('the cached face surface (L4.6-FIX1)', () => {
  it('answers what the exact surface answers, over everything a blink and every expression ask (≤ 0.05 mm, ≤ 0.3°)', () => {
    const sc = scene();
    for (const seed of ['P1', 'odd-shape-7']) {
      const b = createBlobbi3D(seedFromLabel(seed), sc, { name: seed, textureWidth: 1024 });
      const s = b.surface;
      const exact = s.frontPoint.bind(s);
      const exactUv = s.uvOfFront.bind(s);
      const asked: [number, number, number][] = [];
      s.frontPoint = (x, y, o = 0) => (asked.push([x, y, o]), exact(x, y, o));
      blinkThrough(b);
      for (const e of ['sad', 'surprised', 'excited', 'sleepy', 'upset'] as const) {
        b.setExpression(e, 0.12);
        for (let i = 0; i < 12; i++) b.update(still);
      }
      const probe = { ...s, frontPoint: exact, uvOfFront: exactUv } as typeof s;
      cacheFaceSurface(probe);
      expect(asked.length).toBeGreaterThan(10_000);
      let pos = 0;
      let deg = 0;
      let uv = 0;
      for (const [x, y, o] of asked) {
        const e = exact(x, y, o);
        const c = probe.frontPoint(x, y, o);
        pos = Math.max(pos, Math.hypot(e.x - c.x, e.y - c.y, e.z - c.z));
        deg = Math.max(deg, (Math.acos(Math.min(1, e.nx * c.nx + e.ny * c.ny + e.nz * c.nz)) * 180) / Math.PI);
        const eu = exactUv(x, y);
        const cu = probe.uvOfFront(x, y);
        uv = Math.max(uv, Math.abs(eu.u - cu.u), Math.abs(eu.v - cu.v));
      }
      expect(pos).toBeLessThan(5e-5);
      expect(deg).toBeLessThan(0.3);
      expect(uv).toBeLessThan(1e-4);
    }
  });

  it('a still face asks nothing; after warming, a blink asks the exact surface nothing new; a second blink neither', () => {
    const sc = scene();
    const b = createBlobbi3D(seedFromLabel('P1'), sc, { name: 'P1', textureWidth: 1024 });
    let exactCalls = 0;
    const exact = b.surface.frontPoint.bind(b.surface);
    b.surface.frontPoint = (x, y, o) => (exactCalls++, exact(x, y, o));
    const { stats } = cacheFaceSurface(b.surface);
    warmBlink(b);
    for (let i = 0; i < 40; i++) b.update(still);
    const warmed = exactCalls;
    const q = stats.queries;
    // Still: no lookups at all (the kit keeps its last layout).
    for (let i = 0; i < 120; i++) b.update(still);
    expect(stats.queries).toBe(q);
    // A blink: the lattice already holds nearly all of it (a few cells at in-between lid positions are new).
    blinkThrough(b);
    const asked = stats.queries - q;
    expect(asked).toBeGreaterThan(10_000);
    expect(exactCalls - warmed).toBeLessThan(asked * 0.02);
    const afterFirst = exactCalls;
    blinkThrough(b);
    expect(exactCalls).toBe(afterFirst);
    expect(stats.nodes).toBeLessThanOrEqual(SURFACE_CACHE.maxNodes);
  });

  it('bounded: a lattice past its limit starts over and still answers', () => {
    const sc = scene();
    const b = createBlobbi3D(seedFromLabel('P1'), sc, { name: 'P1', textureWidth: 1024 });
    const exact = b.surface.frontPoint.bind(b.surface);
    const { stats } = cacheFaceSurface(b.surface, 2, 64);
    for (let k = 0; k < 400; k++) b.surface.frontPoint(-150 + k * 0.75, 300 + (k % 40) * 5, 0);
    expect(stats.nodes).toBeLessThanOrEqual(64);
    expect(stats.resets).toBeGreaterThan(0);
    const e = exact(-20, 400, 0);
    const c = b.surface.frontPoint(-20, 400, 0);
    expect(Math.hypot(e.x - c.x, e.y - c.y, e.z - c.z)).toBeLessThan(5e-5);
  });

  it('a fighter’s eyes, lids and mouth, mid-blink and after an expression, sit where an uncached Blobbi’s do', () => {
    const sc = scene();
    const v = new FighterView('P1', 'P1', sc, seedFromLabel('same'));
    const ref = createBlobbi3D(seedFromLabel('same'), sc, { name: 'ref', textureWidth: 1024 });
    // The same face state on both, laid directly: eyes half closed (mid-blink), with a neutral face.
    for (const b of [v.blobbi, ref]) b.face.apply(NEUTRAL_POSE, { x: 0, y: 0 }, false, 0.5);
    const meshes = (b: typeof ref) => b.face.root.getChildMeshes().filter((m) => m.isEnabled());
    const a = meshes(v.blobbi);
    const r = meshes(ref);
    expect(a.map((m) => m.name.replace(/^P1-/, ''))).toEqual(r.map((m) => m.name.replace(/^ref-/, '')));
    let worst = 0;
    a.forEach((m, k) => {
      const pa = m.getVerticesData(VertexBuffer.PositionKind)!;
      const pr = r[k].getVerticesData(VertexBuffer.PositionKind)!;
      expect(pa.length).toBe(pr.length);
      for (let i = 0; i < pa.length; i++) worst = Math.max(worst, Math.abs(pa[i] - pr[i]));
    });
    expect(worst).toBeLessThan(5e-5);
  });
});
