/**
 * HOW AN ARENA LOOKS (M11A): built from its definition. Every platform is
 * drawn exactly where the match's collider is (`sim/arenaBody.ts`): a top
 * surface by its kind, a body as deep as its thickness, a rim trim at its
 * edges, an underside hanging into the sky. The classic island keeps its
 * garden (the lawn, the soil, the rock, the decoration); the others reuse
 * the same pieces in their own theme.
 *
 *   floor / platform   lawn (garden), riveted plate (factory), ice (frozen)
 *   bridge             wooden planks on two beams, with rope posts
 *   conveyor           a dark belt with chevrons that scroll the way it moves
 *   ice                pale translucent ice; cracks appear as it warns
 *
 * Dynamic pieces (M11B) are kept apart so `applyPieces` can shake them in
 * warning (a tremor and a darkening), lower them as they fall (the same
 * drop the collider has) and hide them when gone. Presentation only;
 * nothing here collides or decides.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { CLASSIC, type ArenaDef } from '../arena/arenas';
import { rimSegmentsOf, type Platform } from '../arena/geometry';
import { onFloor } from '../arena/layout';
import type { PiecePhase } from '../arena/pieces';
import { decorSpots, type DecorKind } from './decor';
import { seeded } from './seeded';
import { themeFor, type ArenaTheme } from './theme';

export interface Arena {
  /** The play surfaces (one mesh per platform). */
  slabs: Mesh[];
  /** M11B: place the dynamic pieces as the snapshot has them. */
  applyPieces(pieces: readonly { phase: PiecePhase; t: number; drop: number }[], time: number): void;
  /** M11D: scroll the belts. */
  applyTime(time: number): void;
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

/** A riveted metal plate, 2 m tile: panels with a seam and a rivet at each corner. */
function plateTexture(scene: Scene, t: ArenaTheme): DynamicTexture {
  const px = 512;
  const tex = new DynamicTexture('plate-tex', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = t.grassA;
  ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = t.grassEdge;
  ctx.lineWidth = 6;
  for (const q of [0, px / 2]) {
    ctx.strokeRect(q + 3, 3, px / 2 - 6, px / 2 - 6);
    ctx.strokeRect(q + 3, px / 2 + 3, px / 2 - 6, px / 2 - 6);
  }
  ctx.fillStyle = t.grassFleck;
  for (const x of [20, px / 2 - 20, px / 2 + 20, px - 20]) for (const y of [20, px / 2 - 20, px / 2 + 20, px - 20]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Ice: a pale sheet with faint flow lines; the cracks are drawn later, by phase. */
function iceTexture(scene: Scene, name: string, t: ArenaTheme, cracks: 0 | 1 | 2): DynamicTexture {
  const px = 256;
  const tex = new DynamicTexture(name, { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = t.grassA;
  ctx.fillRect(0, 0, px, px);
  const rnd = seeded(9);
  ctx.strokeStyle = t.grassFleck;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  for (let k = 0; k < 12; k++) {
    ctx.beginPath();
    ctx.moveTo(rnd() * px, rnd() * px);
    ctx.bezierCurveTo(rnd() * px, rnd() * px, rnd() * px, rnd() * px, rnd() * px, rnd() * px);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (cracks) {
    ctx.strokeStyle = t.grassEdge;
    ctx.lineWidth = cracks === 2 ? 4 : 2.5;
    const c = seeded(21);
    for (let k = 0; k < (cracks === 2 ? 14 : 6); k++) {
      ctx.beginPath();
      let x = px / 2 + (c() - 0.5) * 40;
      let y = px / 2 + (c() - 0.5) * 40;
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        x += (c() - 0.5) * 70;
        y += (c() - 0.5) * 70;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** A belt: dark rubber with pale chevrons pointing along +u (the texture scrolls to show the motion). */
function beltTexture(scene: Scene, t: ArenaTheme): DynamicTexture {
  const px = 256;
  const tex = new DynamicTexture('belt-tex', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = t.sweeperPole;
  ctx.fillRect(0, 0, px, px);
  ctx.strokeStyle = t.edgeTrim;
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    const x = k * (px / 4) + 24;
    ctx.beginPath();
    ctx.moveTo(x, 24);
    ctx.lineTo(x + 40, px / 2);
    ctx.lineTo(x, px - 24);
    ctx.stroke();
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
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
  for (let k = 0; k < 40; k++) {
    ctx.fillStyle = rnd() < 0.5 ? t.rock : t.soilTop;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(rnd() * w, 60 + rnd() * (hgt - 70), 2 + rnd() * 4, 1.5 + rnd() * 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
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

/** World-space UVs for a top, so a tiled texture runs on unbroken across neighbouring platforms at one height. */
function worldUVs(mesh: Mesh, tile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const uvs: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uvs.push((pos[i] + mesh.position.x) / tile, (pos[i + 2] + mesh.position.z) / tile);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/** A strip of ground along a rim segment, `inset` to `inset + width` inside the floor, at height y. */
function rimStrip(scene: Scene, name: string, from: { x: number; z: number }, to: { x: number; z: number }, inset: number, width: number, y: number, inside: (p: { x: number; z: number }) => boolean): Mesh {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  const dx = (to.x - from.x) / len;
  const dz = (to.z - from.z) / len;
  const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  let nx = -dz;
  let nz = dx;
  if (!inside({ x: mid.x + nx * 0.05, z: mid.z + nz * 0.05 })) {
    nx = -nx;
    nz = -nz;
  }
  const strip = MeshBuilder.CreateGround(name, { width: len, height: width }, scene);
  strip.rotation.y = -Math.atan2(dz, dx);
  strip.position.set(mid.x + nx * (inset + width / 2), y, mid.z + nz * (inset + width / 2));
  strip.isPickable = false;
  return strip;
}

/** The rock underside of one platform: a jagged downward point, as wide as the slab at the top, flat-shaded. */
function underside(scene: Scene, r: Platform, t: ArenaTheme, rnd: () => number): Mesh {
  const depth = 1.0 + Math.min(r.halfWidth, r.halfDepth) * 0.45;
  const m = MeshBuilder.CreateCylinder(`underside-${r.x}-${r.z}`, { diameterTop: 1, diameterBottom: 0.12, height: depth, tessellation: 10, subdivisions: 3 }, scene);
  const pos = m.getVerticesData(VertexBuffer.PositionKind)!;
  const colors: number[] = [];
  const top = C(t.soil);
  const bottom = C(t.rockDark);
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1];
    const k = (depth / 2 - y) / depth;
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
  m.scaling.set(r.halfWidth * 2 * 0.97, 1, r.halfDepth * 2 * 0.97);
  m.position.set(r.x, r.y - r.thickness - depth / 2 + 0.02, r.z);
  m.isPickable = false;
  return m;
}

/** The sweeper's circle: a patch of worn ground with a dashed ring at the bar's reach. */
function sweeperZone(scene: Scene, t: ArenaTheme, pivot: { x: number; z: number }, reach: number, y: number): Mesh {
  const px = 512;
  const tex = new DynamicTexture('sweep-zone-tex', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, px, px);
  const c = px / 2;
  const reachPx = (reach / (reach + 0.2)) * c;
  ctx.fillStyle = t.sweeperZone;
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
  const disc = MeshBuilder.CreateGround('sweep-zone', { width: (reach + 0.2) * 2, height: (reach + 0.2) * 2 }, scene);
  disc.position.set(pivot.x, y + 0.004, pivot.z);
  disc.material = mat;
  disc.receiveShadows = true;
  disc.isPickable = false;
  return disc;
}

/** The classic garden's decoration pieces: one source mesh per kind (and petal colour), instanced at the spots. */
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
  const add = (src: Mesh, x: number, z: number, rotation: number, scale: number) => {
    src.thinInstanceAdd(Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.RotationYawPitchRoll(rotation, 0, 0), new Vector3(x, baseY.get(src)!, z)));
  };
  for (const s of decorSpots()) {
    const src = source(s.kind, s.variant);
    add(src, s.x, s.z, s.rotation, s.scale);
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

/** A bridge: planks across two beams, with a short post and a rope line at each corner. */
function bridgePieces(scene: Scene, r: Platform, t: ArenaTheme, plank: StandardMaterial, rope: StandardMaterial): Mesh[] {
  const out: Mesh[] = [];
  const along = r.halfWidth >= r.halfDepth ? 'x' : 'z';
  const length = along === 'x' ? r.halfWidth * 2 : r.halfDepth * 2;
  const width = along === 'x' ? r.halfDepth * 2 : r.halfWidth * 2;
  const n = Math.max(3, Math.round(length / 0.28));
  const planks: Mesh[] = [];
  for (let k = 0; k < n; k++) {
    const p = MeshBuilder.CreateBox('plank', { width: along === 'x' ? length / n - 0.03 : width, depth: along === 'x' ? width : length / n - 0.03, height: r.thickness }, scene);
    const u = -length / 2 + (k + 0.5) * (length / n);
    p.position.set(r.x + (along === 'x' ? u : 0), r.y - r.thickness / 2, r.z + (along === 'z' ? u : 0));
    planks.push(p);
  }
  const deck = Mesh.MergeMeshes(planks, true)!;
  deck.name = `bridge-deck-${r.x}-${r.z}`;
  deck.material = plank;
  deck.receiveShadows = true;
  out.push(deck);
  // Posts and ropes.
  const posts: Mesh[] = [];
  const corners = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  for (const [sx, sz] of corners) {
    const post = MeshBuilder.CreateCylinder('post', { diameter: 0.08, height: 0.5, tessellation: 6 }, scene);
    post.position.set(r.x + sx * (r.halfWidth - 0.06), r.y + 0.25, r.z + sz * (r.halfDepth - 0.06));
    posts.push(post);
  }
  for (const side of [-1, 1]) {
    const line = MeshBuilder.CreateCylinder('rope', { diameter: 0.025, height: length - 0.1, tessellation: 5 }, scene);
    line.rotation.set(along === 'z' ? Math.PI / 2 : 0, 0, along === 'x' ? Math.PI / 2 : 0);
    line.position.set(r.x + (along === 'z' ? side * (r.halfWidth - 0.06) : 0), r.y + 0.42, r.z + (along === 'x' ? side * (r.halfDepth - 0.06) : 0));
    posts.push(line);
  }
  const rails = Mesh.MergeMeshes(posts, true)!;
  rails.name = `bridge-rails-${r.x}-${r.z}`;
  rails.material = rope;
  out.push(rails);
  void t;
  for (const m of out) m.isPickable = false;
  return out;
}

export function createArena(scene: Scene, shadows?: ShadowGenerator, def: ArenaDef = CLASSIC): Arena {
  // L4: everything this view makes (its decoration's and hazards' materials, every texture) is found by what the scene gained, and disposed with it.
  const hadMaterials = new Set(scene.materials);
  const hadTextures = new Set(scene.textures);
  const t = themeFor(def.theme);
  const disposables: { dispose(): void }[] = [];
  const slabs: Mesh[] = [];
  const keep = <T extends { dispose(): void }>(d: T): T => (disposables.push(d), d);

  // Materials by kind.
  const topMat = new StandardMaterial('top-mat', scene);
  topMat.diffuseTexture = def.theme === 'garden' ? lawnTexture(scene, t) : def.theme === 'factory' ? plateTexture(scene, t) : iceTexture(scene, 'ice-tex', t, 0);
  topMat.specularColor = def.theme === 'frozen' ? new Color3(0.35, 0.4, 0.45) : new Color3(0.04, 0.05, 0.04);
  if (def.theme === 'frozen') topMat.alpha = 0.96;
  keep(topMat);
  const bodyMat = new StandardMaterial('body-mat', scene);
  if (def.theme === 'garden') bodyMat.diffuseTexture = soilTexture(scene, t);
  else bodyMat.diffuseColor = C(t.soil);
  bodyMat.specularColor = Color3.Black();
  bodyMat.emissiveColor = new Color3(0.06, 0.04, 0.03);
  keep(bodyMat);
  const rockMat = new StandardMaterial('rock-mat', scene);
  rockMat.specularColor = Color3.Black();
  rockMat.emissiveColor = new Color3(0.05, 0.04, 0.04);
  keep(rockMat);
  const plankMat = flat(scene, 'plank-mat', t.soilBand);
  const ropeMat = flat(scene, 'rope-mat', t.edgeTrim);
  keep(plankMat);
  keep(ropeMat);
  const beltTex = beltTexture(scene, t);
  keep(beltTex);
  /** One material per belt: each scrolls at its own speed and way. */
  const belts = def.conveyors.map((c) => {
    const m = new StandardMaterial(`belt-mat-${c.platform}`, scene);
    const tex = beltTex.clone() as Texture;
    m.diffuseTexture = tex;
    m.specularColor = new Color3(0.1, 0.1, 0.1);
    keep(m);
    return { platform: c.platform, mat: m, tex, vx: c.vx, vz: c.vz };
  });
  const crackedMat = new StandardMaterial('ice-cracked-mat', scene);
  crackedMat.diffuseTexture = iceTexture(scene, 'ice-cracked-tex', t, 1);
  crackedMat.specularColor = topMat.specularColor;
  keep(crackedMat);
  const breakingMat = new StandardMaterial('ice-breaking-mat', scene);
  breakingMat.diffuseTexture = iceTexture(scene, 'ice-breaking-tex', t, 2);
  breakingMat.specularColor = topMat.specularColor;
  keep(breakingMat);
  const warnMat = flat(scene, 'warn-mat', t.grassEdge);
  keep(warnMat);
  const rnd = seeded(17);

  const dynamicOf = new Map<number, number>();
  def.dynamics.forEach((d, k) => dynamicOf.set(d.platform, k));
  /** Per dynamic piece: its node (everything of it moves together), its top, and the normal material. */
  const pieces: { node: TransformNode; top: Mesh; rest: number; kind: Platform['kind'] }[] = [];
  const statics: { tops: Mesh[]; bodies: Mesh[]; unders: Mesh[]; belts: Mesh[]; bridges: Mesh[] } = { tops: [], bodies: [], unders: [], belts: [], bridges: [] };

  def.platforms.forEach((r, i) => {
    const dyn = dynamicOf.get(i);
    const node = dyn !== undefined ? new TransformNode(`piece-${dyn}`, scene) : null;
    if (r.kind === 'bridge') {
      const made = bridgePieces(scene, r, t, plankMat, ropeMat);
      if (node) {
        for (const m of made) m.parent = node;
        pieces[dyn!] = { node, top: made[0], rest: 0, kind: r.kind };
      } else statics.bridges.push(...made);
      return;
    }
    const top = MeshBuilder.CreateGround(`top-${i}`, { width: r.halfWidth * 2, height: r.halfDepth * 2, subdivisions: 1 }, scene);
    top.position.set(r.x, r.y, r.z);
    worldUVs(top, 2);
    top.material = r.kind === 'conveyor' ? (belts.find((b) => b.platform === i)?.mat ?? topMat) : topMat;
    top.receiveShadows = true;
    top.isPickable = false;
    slabs.push(top);
    const body = MeshBuilder.CreateBox(`body-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: r.thickness }, scene);
    body.position.set(r.x, r.y - r.thickness / 2 - 0.001, r.z);
    body.material = bodyMat;
    body.isPickable = false;
    const under = r.kind === 'conveyor' || r.kind === 'ice' ? null : underside(scene, r, t, rnd);
    if (under) under.material = rockMat;
    if (node) {
      top.parent = node;
      body.parent = node;
      if (under) under.parent = node;
      pieces[dyn!] = { node, top, rest: 0, kind: r.kind };
      disposables.push(top, body);
      if (under) disposables.push(under);
    } else {
      statics.tops.push(top);
      statics.bodies.push(body);
      if (under) statics.unders.push(under);
      if (r.kind === 'conveyor') statics.belts.push(top);
    }
  });
  // Static pieces by material: as few draws as possible. (Conveyors keep their own mesh: their texture scrolls.)
  const merge = (parts: Mesh[], name: string, mat: StandardMaterial | null) => {
    if (!parts.length) return null;
    const m = Mesh.MergeMeshes(parts, true, true, undefined, false, mat === null)!;
    m.name = name;
    if (mat) m.material = mat;
    m.isPickable = false;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    disposables.push(m);
    return m;
  };
  merge(
    statics.tops.filter((m) => !statics.belts.includes(m)),
    'tops',
    topMat,
  );
  merge(statics.bodies, 'bodies', bodyMat);
  merge(statics.unders, 'undersides', rockMat);
  for (const b of statics.bridges) {
    b.freezeWorldMatrix();
    disposables.push(b);
  }
  for (const b of statics.belts) disposables.push(b);

  // Rim trims: per height, the union's outer rim (a darker band, then a pale trim exactly at the edge).
  const bandMat = flat(scene, 'rim-band-mat', t.grassEdge);
  bandMat.alpha = 0.55;
  bandMat.zOffset = -1;
  const trimMat = flat(scene, 'rim-trim-mat', t.edgeTrim);
  trimMat.emissiveColor = C(t.edgeTrim).scale(0.25);
  trimMat.zOffset = -3;
  keep(bandMat);
  keep(trimMat);
  const heights = [...new Set(def.platforms.filter((r) => dynamicOf.get(def.platforms.indexOf(r)) === undefined && r.kind !== 'bridge').map((r) => r.y))];
  const bands: Mesh[] = [];
  const trims: Mesh[] = [];
  for (const y of heights) {
    const level = def.platforms.filter((r) => r.y === y && r.kind !== 'bridge' && dynamicOf.get(def.platforms.indexOf(r)) === undefined);
    // M11.1: a bridge at this height is part of the outline (a platform's edge is no rim where a bridge leaves it), but gets no trim of its own.
    const bridges = def.platforms.filter((r) => r.y === y && r.kind === 'bridge');
    const onBridge = (p: { x: number; z: number }) => bridges.some((b) => Math.abs(p.x - b.x) <= b.halfWidth + 1e-6 && Math.abs(p.z - b.z) <= b.halfDepth + 1e-6);
    const inside = (p: { x: number; z: number }) => level.some((r) => Math.abs(p.x - r.x) <= r.halfWidth + 1e-6 && Math.abs(p.z - r.z) <= r.halfDepth + 1e-6) || onBridge(p);
    rimSegmentsOf([...level, ...bridges]).forEach(([from, to], i) => {
      if (onBridge(from) && onBridge(to) && onBridge({ x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 })) return;
      bands.push(rimStrip(scene, `rim-band-${y}-${i}`, from, to, 0.1, 0.32, y + 0.002, inside));
      trims.push(rimStrip(scene, `rim-trim-${y}-${i}`, from, to, 0, 0.1, y + 0.004, inside));
    });
  }
  merge(bands, 'rim-band', bandMat);
  merge(trims, 'rim-trim', trimMat);
  // A dynamic piece gets its own trim, moving with it.
  pieces.forEach((p, k) => {
    const r = def.platforms[def.dynamics[k].platform];
    if (r.kind === 'bridge') return;
    const inside = (q: { x: number; z: number }) => Math.abs(q.x - r.x) <= r.halfWidth + 1e-6 && Math.abs(q.z - r.z) <= r.halfDepth + 1e-6;
    const own = rimSegmentsOf([r]).map(([from, to], i) => rimStrip(scene, `piece-trim-${k}-${i}`, from, to, 0, 0.1, r.y + 0.004, inside));
    const m = Mesh.MergeMeshes(own, true)!;
    m.material = trimMat;
    m.isPickable = false;
    m.parent = p.node;
    disposables.push(m);
  });

  if (def.sweeper) {
    const sw = def.sweeper;
    const under = def.platforms.find((r) => Math.abs(sw.pivot.x - r.x) <= r.halfWidth && Math.abs(sw.pivot.z - r.z) <= r.halfDepth);
    keep(sweeperZone(scene, t, sw.pivot, sw.reach, under?.y ?? 0));
  }
  if (def.id === CLASSIC.id) disposables.push(...decoration(scene, t));
  void onFloor;

  const made = { materials: scene.materials.filter((m) => !hadMaterials.has(m)), textures: scene.textures.filter((x) => !hadTextures.has(x)) };
  let shakeSeed = 0;
  return {
    slabs,
    applyPieces: (states, time) => {
      states.forEach((s, k) => {
        const p = pieces[k];
        if (!p) return;
        const r = def.platforms[def.dynamics[k].platform];
        p.node.setEnabled(s.phase !== 'gone');
        // Warning: a tremor that grows, and a darker / more cracked face; falling: the collider's own drop.
        const shake = s.phase === 'warning' ? 0.012 + 0.03 * Math.min(1, s.t / 1.2) : 0;
        shakeSeed += 1;
        p.node.position.set(shake * Math.sin(time * 41 + k), -s.drop, shake * Math.cos(time * 37 + k * 2));
        if (r.kind === 'ice') p.top.material = s.phase === 'warning' ? (s.t > 0.6 ? breakingMat : crackedMat) : s.phase === 'stable' ? topMat : breakingMat;
        else if (r.kind !== 'bridge') p.top.material = s.phase === 'warning' ? warnMat : topMat;
      });
    },
    applyTime: (time) => {
      // The belts scroll the way they carry: the texture's u runs along world x (2 m per tile), so the offset is the distance moved over the tile.
      for (const b of belts) b.tex.uOffset = (-(time * b.vx) / 2) % 1;
    },
    dispose: () => {
      for (const p of pieces) p.node.dispose();
      for (const d of disposables) d.dispose();
      for (const m of made.materials) if (!m.isFrozen) m.dispose(false, true);
      for (const tex of made.textures) tex.dispose();
    },
  };
}
