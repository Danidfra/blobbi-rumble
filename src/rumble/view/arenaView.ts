/**
 * HOW THE ARENA LOOKS: a small floating lawn. The play surface is one
 * striped, mowed lawn laid in world space over all three slabs, so the
 * centre and the wings read as one island; the boundary of play is a cream
 * trim over a darker band of grass, exactly at the rim, flush (a line, not
 * a rail); under it, warm layered soil exactly as deep as the floor, and a
 * jagged rock underside hanging into the sky. Small flowers, tufts, stones
 * and mushrooms grow only where they cannot confuse play (`decor.ts`), and
 * the sweeper's circle is a patch of worn grass with a dashed ring.
 *
 * Presentation only: every visible top surface is exactly the floor of
 * `arena/layout.ts`, which is also what the match's colliders are
 * (`sim/arenaBody.ts`); nothing here collides.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { ARENA, floorSlabs, onFloor, rimSegments, type Rect } from '../arena/layout';
import { SWEEPER } from '../tuning';
import { decorSpots, type DecorKind } from './decor';
import { seeded } from './seeded';
import { GARDEN, type ArenaTheme } from './theme';

export interface Arena {
  /** The lawn: the play surface (all three slabs, one mesh). */
  slabs: Mesh[];
  dispose(): void;
}

const C = Color3.FromHexString;

function flat(scene: Scene, name: string, hex: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = C(hex);
  m.specularColor = Color3.Black();
  return m;
}

/** The lawn's tile: 2 m square, two mowing stripes of green (1 m each) flecked with blades. */
function lawnTexture(scene: Scene, t: ArenaTheme): DynamicTexture {
  const px = 512;
  const tex = new DynamicTexture('lawn-tex', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  // Mowing stripes, 1 m wide, running away from the camera: they read motion without looking like tiles.
  const h = px / 2;
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i % 2 ? t.grassB : t.grassA;
    ctx.fillRect(i * h, 0, h, px);
  }
  const rnd = seeded(3);
  ctx.lineCap = 'round';
  for (let k = 0; k < 900; k++) {
    const x = rnd() * px;
    const y = rnd() * px;
    ctx.strokeStyle = rnd() < 0.6 ? t.grassFleck : t.grassEdge;
    ctx.globalAlpha = 0.18 + rnd() * 0.22;
    ctx.lineWidth = 1.5 + rnd() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 4, y - 4 - rnd() * 6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

/** The soil's side: a turf lip at the top, dark roots under it, then warm earth in soft bands with pebbles. */
function soilTexture(scene: Scene, t: ArenaTheme): DynamicTexture {
  const w = 256;
  const hgt = 256;
  const tex = new DynamicTexture('soil-tex', { width: w, height: hgt }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = t.soil;
  ctx.fillRect(0, 0, w, hgt);
  const rnd = seeded(5);
  // Soft bands.
  for (let k = 0; k < 4; k++) {
    ctx.fillStyle = t.soilBand;
    ctx.globalAlpha = 0.45;
    const y = 70 + k * 46 + rnd() * 10;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.05 + k) * 4);
    ctx.lineTo(w, y + 12);
    for (let x = w; x >= 0; x -= 32) ctx.lineTo(x, y + 12 + Math.sin(x * 0.04 + k * 2) * 3);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Pebbles.
  for (let k = 0; k < 40; k++) {
    ctx.fillStyle = rnd() < 0.5 ? t.rock : t.soilTop;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(rnd() * w, 60 + rnd() * (hgt - 70), 2 + rnd() * 4, 1.5 + rnd() * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Dark roots under the turf, then the turf lip itself, with a scalloped edge.
  ctx.fillStyle = t.soilTop;
  ctx.fillRect(0, 0, w, 52);
  ctx.fillStyle = t.grassB;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  for (let x = w; x >= 0; x -= 16) ctx.lineTo(x, 26 + ((x / 16) % 2) * 7);
  ctx.fill();
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** World-space UVs for a lawn piece, so the checker runs on unbroken across the seams. */
function worldUVs(mesh: Mesh, tile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const uvs: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uvs.push((pos[i] + mesh.position.x) / tile, (pos[i + 2] + mesh.position.z) / tile);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/** A strip of ground along a rim segment, `inset` to `inset + width` inside the floor. */
function rimStrip(scene: Scene, name: string, from: { x: number; z: number }, to: { x: number; z: number }, inset: number, width: number, y: number): Mesh {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const dx = (to.x - from.x) / len;
  const dz = (to.z - from.z) / len;
  // Which side is floor: test a point just off the middle of the segment.
  const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  let nx = -dz;
  let nz = dx;
  if (!onFloor({ x: mid.x + nx * 0.05, z: mid.z + nz * 0.05 })) {
    nx = -nx;
    nz = -nz;
  }
  const strip = MeshBuilder.CreateGround(name, { width: len, height: width }, scene);
  strip.rotation.y = -Math.atan2(dz, dx);
  strip.position.set(mid.x + nx * (inset + width / 2), y, mid.z + nz * (inset + width / 2));
  strip.isPickable = false;
  return strip;
}

/** The rock underside of one slab: a jagged downward point, as wide as the slab at the top, flat-shaded. */
function underside(scene: Scene, r: Rect, t: ArenaTheme, rnd: () => number): Mesh {
  const depth = 1.4 + Math.min(r.halfWidth, r.halfDepth) * 0.45;
  const m = MeshBuilder.CreateCylinder(`underside-${r.x}`, { diameterTop: 1, diameterBottom: 0.12, height: depth, tessellation: 10, subdivisions: 3 }, scene);
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
  const colors: number[] = [];
  const top = C(t.soil);
  const bottom = C(t.rockDark);
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    const k = (depth / 2 - y) / depth; // 0 at the top, 1 at the point
    const j = k > 0.05 ? 1 + (rnd() - 0.5) * 0.35 : 1;
    pos[i] *= j;
    pos[i + 2] *= j;
    pos[i + 1] += k > 0.05 && k < 0.95 ? (rnd() - 0.5) * 0.18 : 0;
    const c = Color3.Lerp(top, bottom, Math.min(1, k * 1.2));
    colors.push(c.r, c.g, c.b, 1);
  }
  m.setVerticesData(VertexBuffer.PositionKind, pos);
  m.setVerticesData(VertexBuffer.ColorKind, colors);
  m.convertToFlatShadedMesh();
  // Square-ish: as wide and deep as the slab (a touch inside it, so it never pokes past the floor's outline).
  m.scaling.set(r.halfWidth * 2 * 0.97, 1, r.halfDepth * 2 * 0.97);
  m.position.set(r.x, -ARENA.thickness - depth / 2 + 0.02, r.z);
  m.isPickable = false;
  return m;
}

/** The sweeper's circle: a patch of worn grass with a dashed ring at the bar's reach. */
function sweeperZone(scene: Scene, t: ArenaTheme): Mesh {
  const px = 512;
  const tex = new DynamicTexture('sweep-zone-tex', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, px, px);
  const c = px / 2;
  const reachPx = (SWEEPER.reach / (SWEEPER.reach + 0.2)) * c;
  const g = ctx.createRadialGradient(c, c, reachPx * 0.2, c, c, reachPx);
  g.addColorStop(0, t.sweeperZone);
  g.addColorStop(1, t.sweeperZone);
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(c, c, reachPx, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = t.edgeTrim;
  ctx.lineWidth = 7;
  ctx.setLineDash([22, 16]);
  ctx.beginPath();
  ctx.arc(c, c, reachPx - 4, 0, Math.PI * 2);
  ctx.stroke();
  tex.update();
  tex.hasAlpha = true;
  const mat = new StandardMaterial('sweep-zone-mat', scene);
  mat.diffuseTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.specularColor = Color3.Black();
  mat.zOffset = -2;
  const disc = MeshBuilder.CreateGround('sweep-zone', { width: (SWEEPER.reach + 0.2) * 2, height: (SWEEPER.reach + 0.2) * 2 }, scene);
  disc.position.set(SWEEPER.pivot.x, 0.004, SWEEPER.pivot.z);
  disc.material = mat;
  disc.receiveShadows = true;
  disc.isPickable = false;
  return disc;
}

/** The decoration pieces: one source mesh per kind (and petal colour), instanced at the spots. */
function decoration(scene: Scene, t: ArenaTheme): Mesh[] {
  const sources = new Map<string, Mesh>();
  const baseY = new Map<Mesh, number>();
  const made: Mesh[] = [];
  const flower = (petal: string) => {
    const parts: Mesh[] = [];
    for (let k = 0; k < 5; k++) {
      const p = MeshBuilder.CreateSphere('petal', { diameter: 0.07, segments: 4 }, scene);
      const a = (k / 5) * Math.PI * 2;
      p.position.set(Math.cos(a) * 0.045, 0.035, Math.sin(a) * 0.045);
      p.scaling.y = 0.35;
      parts.push(p);
    }
    const petals = Mesh.MergeMeshes(parts, true)!;
    petals.material = flat(scene, `petal-${petal}`, petal);
    const heart = MeshBuilder.CreateSphere('heart', { diameter: 0.05, segments: 4 }, scene);
    heart.position.y = 0.045;
    heart.material = flat(scene, 'flower-heart', t.flowerHeart);
    const stem = MeshBuilder.CreateCylinder('stem', { diameter: 0.012, height: 0.04, tessellation: 4 }, scene);
    stem.position.y = 0.02;
    stem.material = flat(scene, 'flower-stem', t.tuft);
    return Mesh.MergeMeshes([petals, heart, stem], true, true, undefined, false, true)!;
  };
  const tuft = () => {
    const parts: Mesh[] = [];
    const rnd = seeded(13);
    for (let k = 0; k < 5; k++) {
      const h = 0.1 + rnd() * 0.06;
      const b = MeshBuilder.CreateCylinder('blade', { diameterTop: 0, diameterBottom: 0.025, height: h, tessellation: 3 }, scene);
      const a = (k / 5) * Math.PI * 2;
      b.position.set(Math.cos(a) * 0.03, h / 2, Math.sin(a) * 0.03);
      b.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
      parts.push(b);
    }
    const m = Mesh.MergeMeshes(parts, true)!;
    m.material = flat(scene, 'tuft-mat', t.tuft);
    return m;
  };
  const stone = () => {
    const m = MeshBuilder.CreateIcoSphere('stone', { radius: 0.06, subdivisions: 1, flat: true }, scene);
    m.scaling.y = 0.55;
    m.bakeCurrentTransformIntoVertices();
    m.position.y = 0.012;
    m.material = flat(scene, 'stone-mat', t.stone);
    return m;
  };
  const mushroom = () => {
    const stem = MeshBuilder.CreateCylinder('mush-stem', { diameter: 0.035, height: 0.08, tessellation: 6 }, scene);
    stem.position.y = 0.04;
    stem.material = flat(scene, 'mush-stem', t.edgeTrim);
    const cap = MeshBuilder.CreateSphere('mush-cap', { diameter: 0.11, segments: 6, slice: 0.5 }, scene);
    cap.position.y = 0.075;
    cap.material = flat(scene, 'mush-cap', t.mushroomCap);
    return Mesh.MergeMeshes([stem, cap], true, true, undefined, false, true)!;
  };
  const source = (kind: DecorKind, variant: number): Mesh => {
    const key = kind === 'flower' ? `flower-${Math.floor(variant * t.petals.length)}` : kind;
    let m = sources.get(key);
    if (!m) {
      m = kind === 'flower' ? flower(t.petals[Math.floor(variant * t.petals.length)]) : kind === 'tuft' ? tuft() : kind === 'stone' ? stone() : mushroom();
      m.name = `decor-${key}`;
      m.isPickable = false;
      m.receiveShadows = true;
      baseY.set(m, m.position.y);
      sources.set(key, m);
      made.push(m);
    }
    return m;
  };
  // Thin instances: each kind is one draw, and nothing per piece is updated or culled per frame.
  const add = (src: Mesh, x: number, z: number, rotation: number, scale: number) => {
    src.thinInstanceAdd(Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.RotationYawPitchRoll(rotation, 0, 0), new Vector3(x, baseY.get(src)!, z)));
  };
  for (const s of decorSpots()) {
    const src = source(s.kind, s.variant);
    add(src, s.x, s.z, s.rotation, s.scale);
    // A flower patch: two more small flowers beside the first.
    if (s.kind === 'flower')
      for (const [dx, dz] of [
        [0.11, 0.05],
        [-0.06, 0.1],
      ])
        add(src, s.x + dx, s.z + dz, s.rotation + dx * 10, s.scale * 0.8);
  }
  for (const m of made) {
    m.position.set(0, 0, 0);
    m.thinInstanceRefreshBoundingInfo(false);
    m.freezeWorldMatrix();
  }
  return made;
}

export function createArena(scene: Scene, shadows?: ShadowGenerator, theme: ArenaTheme = GARDEN): Arena {
  const disposables: { dispose(): void }[] = [];
  const slabs: Mesh[] = [];
  const t = theme;

  // The lawn: one material, world-space UVs, so the three pieces are one surface.
  const lawnMat = new StandardMaterial('lawn-mat', scene);
  lawnMat.diffuseTexture = lawnTexture(scene, t);
  lawnMat.specularColor = new Color3(0.04, 0.05, 0.04);
  const soilMat = new StandardMaterial('soil-mat', scene);
  soilMat.diffuseTexture = soilTexture(scene, t);
  soilMat.specularColor = Color3.Black();
  soilMat.emissiveColor = new Color3(0.06, 0.04, 0.03);
  const rockMat = new StandardMaterial('rock-mat', scene);
  rockMat.specularColor = Color3.Black();
  rockMat.emissiveColor = new Color3(0.05, 0.04, 0.04);
  disposables.push(lawnMat, soilMat, rockMat);
  const rnd = seeded(17);

  const tops: Mesh[] = [];
  const bodies: Mesh[] = [];
  const unders: Mesh[] = [];
  floorSlabs().forEach((r: Rect, i) => {
    const top = MeshBuilder.CreateGround(`lawn-${i}`, { width: r.halfWidth * 2, height: r.halfDepth * 2, subdivisions: 1 }, scene);
    top.position.set(r.x, 0, r.z);
    worldUVs(top, 2);
    tops.push(top);
    // The soil: exactly the floor's footprint and depth, so its edges are the rim's.
    const body = MeshBuilder.CreateBox(`soil-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: ARENA.thickness }, scene);
    body.position.set(r.x, -ARENA.thickness / 2 - 0.001, r.z);
    bodies.push(body);
    unders.push(underside(scene, r, t, rnd));
  });
  // One mesh per material: three draws for the whole island's body.
  const merge = (parts: Mesh[], name: string, mat: StandardMaterial) => {
    const m = Mesh.MergeMeshes(parts, true)!;
    m.name = name;
    m.material = mat;
    m.isPickable = false;
    disposables.push(m);
    return m;
  };
  const lawn = merge(tops, 'lawn', lawnMat);
  // Nothing of the island moves: its world matrices are computed once.
  lawn.receiveShadows = true;
  slabs.push(lawn);
  merge(bodies, 'soil', soilMat);
  merge(unders, 'underside', rockMat);

  // The boundary of play: a darker band of grass, then a cream trim exactly at the rim (flush: a line, not a rail).
  const bandMat = flat(scene, 'rim-band-mat', t.grassEdge);
  bandMat.alpha = 0.55;
  bandMat.zOffset = -1;
  const trimMat = flat(scene, 'rim-trim-mat', t.edgeTrim);
  trimMat.emissiveColor = C(t.edgeTrim).scale(0.25);
  trimMat.zOffset = -3;
  disposables.push(bandMat, trimMat);
  const bands: Mesh[] = [];
  const trims: Mesh[] = [];
  rimSegments().forEach(([from, to], i) => {
    bands.push(rimStrip(scene, `rim-band-${i}`, from, to, 0.1, 0.32, 0.002));
    trims.push(rimStrip(scene, `rim-trim-${i}`, from, to, 0, 0.1, 0.004));
  });
  merge(bands, 'rim-band', bandMat).receiveShadows = true;
  merge(trims, 'rim-trim', trimMat).receiveShadows = true;

  disposables.push(sweeperZone(scene, t));
  disposables.push(...decoration(scene, t));
  for (const d of disposables) if (d instanceof Mesh) d.freezeWorldMatrix();
  void shadows;

  return {
    slabs,
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
