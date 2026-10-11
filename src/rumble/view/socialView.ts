/**
 * HOW BLOBBI PLAZA LOOKS (L4): the social lobby's space
 * (`arena/lobbySpace.ts`), drawn its own way, so it never reads as a combat
 * arena with the scoring off. A small floating square in candy colours:
 *
 *   the floor     cream and peach tiles, a pastel gathering circle in the
 *                 middle (a painted mosaic: flat, nothing to trip over)
 *   the hedge     round bushes with flowers all along the fence (the fence
 *                 itself is the collider's: higher than the hedge, unseen)
 *   the rim       outside the fence, out of reach: lanterns, mushrooms, a
 *                 bench at each side, and on the north side a portal arch
 *                 (inert for now: L6's teleport has a place to happen) beside
 *                 a sign naming the next match's arena
 *   the island    a soft rounded underside hanging into the sky
 *
 * Light on purpose: every static piece is merged by material (a handful of
 * draws), nothing but the Blobbis casts a shadow, and everything here is
 * disposed with it. Presentation only: nothing here collides or decides.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { PLAZA } from '../arena/lobbySpace';
import type { Arena } from './arenaView';
import { seeded } from './seeded';

const C = Color3.FromHexString;

/** The plaza's palette: warm, soft, unmistakably not a battlefield. */
export const PLAZA_COLORS = Object.freeze({
  tileA: '#fbe9d4',
  tileB: '#f6d9c2',
  grout: '#ecc9ae',
  circle: '#e8d6f7',
  ring: '#c9a7ec',
  dots: ['#ff9fb8', '#ffd36b', '#8fd3ff', '#9fe0a8'],
  hedge: ['#7cc98a', '#8fd49a', '#6fbf80'],
  flower: ['#ff8fb1', '#ffe17a', '#ffffff', '#b99cff'],
  soil: '#e7b9a3',
  underside: '#d9a7c4',
  lantern: '#fff1b8',
  post: '#a98bd6',
  capA: '#ff8f9f',
  capB: '#9fd0ff',
  stem: '#fff4e6',
  arch: '#c49bff',
  bench: '#e8a57a',
});

/** The rim around the fence that holds the decoration (beyond reach), metres. */
const RIM = 1.6;

function flat(scene: Scene, name: string, hex: string, glow = 0): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = C(hex);
  m.specularColor = Color3.Black();
  if (glow) m.emissiveColor = C(hex).scale(glow);
  return m;
}

/** The floor's texture: tiles, and the gathering circle in the middle. One texture over the whole square. */
function floorTexture(scene: Scene, halfW: number, halfD: number): DynamicTexture {
  const px = 1024;
  const tex = new DynamicTexture('plaza-floor', { width: px, height: px }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const k = px / (halfW * 2);
  const tile = 1;
  const pz = halfD * 2 * k;
  ctx.fillStyle = PLAZA_COLORS.grout;
  ctx.fillRect(0, 0, px, px);
  for (let x = 0; x < halfW * 2; x += tile)
    for (let z = 0; z < halfD * 2; z += tile) {
      ctx.fillStyle = (Math.floor(x) + Math.floor(z)) % 2 ? PLAZA_COLORS.tileA : PLAZA_COLORS.tileB;
      ctx.fillRect(x * k + 2, z * k + 2, tile * k - 4, tile * k - 4);
    }
  // The gathering circle: a lilac disc, a ring, a ring of coloured dots.
  const cx = px / 2;
  const cy = pz / 2;
  ctx.fillStyle = PLAZA_COLORS.circle;
  ctx.beginPath();
  ctx.arc(cx, cy, 2.6 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = PLAZA_COLORS.ring;
  ctx.lineWidth = 0.16 * k;
  ctx.beginPath();
  ctx.arc(cx, cy, 2.6 * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 1.1 * k, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.fillStyle = PLAZA_COLORS.dots[i % PLAZA_COLORS.dots.length];
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 1.85 * k, cy + Math.sin(a) * 1.85 * k, 0.13 * k, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  // The canvas is square; the floor is not: only its top part is used.
  tex.vScale = pz / px;
  return tex;
}

/** The view of the plaza, with a sign the page can set (the next match's arena). */
export interface SocialArena extends Arena {
  setSign(text: string): void;
}

export function createSocialView(scene: Scene): SocialArena {
  // Whatever this view makes goes with it: what the scene gained while it was built is disposed with it too.
  const hadMaterials = new Set(scene.materials);
  const hadTextures = new Set(scene.textures);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(d: T): T => (disposables.push(d), d);
  const rnd = seeded(29);
  const hw = PLAZA.halfWidth + PLAZA.wallThickness;
  const hd = PLAZA.halfDepth + PLAZA.wallThickness;
  const ow = hw + RIM;
  const od = hd + RIM;
  /** Static parts, merged per material at the end. */
  const parts = new Map<StandardMaterial, Mesh[]>();
  const add = (mat: StandardMaterial, m: Mesh) => {
    m.isPickable = false;
    (parts.get(mat) ?? parts.set(mat, []).get(mat)!).push(m);
    return m;
  };

  // The floor: the walkable square (with its texture) and the rim around it.
  const floorMat = keep(new StandardMaterial('plaza-floor-mat', scene));
  floorMat.diffuseTexture = keep(floorTexture(scene, hw, hd));
  floorMat.specularColor = Color3.Black();
  const top = MeshBuilder.CreateGround('plaza-top', { width: hw * 2, height: hd * 2 }, scene);
  top.material = floorMat;
  top.receiveShadows = true;
  top.isPickable = false;
  top.freezeWorldMatrix();
  keep(top);
  const rimMat = keep(flat(scene, 'plaza-rim-mat', PLAZA_COLORS.tileB));
  for (const [x, z, w, d] of [
    [0, hd + RIM / 2, ow * 2, RIM],
    [0, -(hd + RIM / 2), ow * 2, RIM],
    [hw + RIM / 2, 0, RIM, hd * 2],
    [-(hw + RIM / 2), 0, RIM, hd * 2],
  ]) {
    const g = MeshBuilder.CreateGround('plaza-rim', { width: w, height: d }, scene);
    g.position.set(x, -0.002, z);
    add(rimMat, g);
  }
  // The island: a slab and a soft rounded underside.
  const soilMat = keep(flat(scene, 'plaza-soil-mat', PLAZA_COLORS.soil));
  const slab = MeshBuilder.CreateBox('plaza-slab', { width: ow * 2, depth: od * 2, height: 0.6 }, scene);
  slab.position.y = -0.302;
  add(soilMat, slab);
  const underMat = keep(flat(scene, 'plaza-under-mat', PLAZA_COLORS.underside));
  const under = MeshBuilder.CreateCylinder('plaza-under', { diameterTop: 2, diameterBottom: 0.3, height: 3.6, tessellation: 28 }, scene);
  under.scaling.set(ow, 1, od);
  under.position.y = -0.6 - 1.8;
  add(underMat, under);

  // The hedge along the fence: round bushes, flowers on them.
  const hedgeMats = PLAZA_COLORS.hedge.map((c, i) => keep(flat(scene, `plaza-hedge-${i}`, c)));
  const flowerMats = PLAZA_COLORS.flower.map((c, i) => keep(flat(scene, `plaza-flower-${i}`, c, 0.15)));
  const bush = (x: number, z: number) => {
    const r = 0.32 + rnd() * 0.12;
    const b = MeshBuilder.CreateSphere('bush', { diameter: r * 2, segments: 6 }, scene);
    b.position.set(x, r * 0.8, z);
    b.scaling.y = 0.85;
    add(hedgeMats[Math.floor(rnd() * hedgeMats.length)], b);
    for (let f = 0; f < 2; f++) {
      const a = rnd() * Math.PI * 2;
      const fl = MeshBuilder.CreateSphere('flower', { diameter: 0.1, segments: 3 }, scene);
      fl.position.set(x + Math.cos(a) * r * 0.7, r * 0.8 + r * 0.55, z + Math.sin(a) * r * 0.7);
      add(flowerMats[Math.floor(rnd() * flowerMats.length)], fl);
    }
  };
  const fx = PLAZA.halfWidth + PLAZA.wallThickness / 2;
  const fz = PLAZA.halfDepth + PLAZA.wallThickness / 2;
  for (let x = -fx; x <= fx + 1e-6; x += 0.55) {
    // The north side leaves a gap where the arch stands.
    if (Math.abs(x) > 1.4) bush(x, fz);
    bush(x, -fz);
  }
  for (let z = -fz + 0.55; z < fz - 0.3; z += 0.55) {
    bush(fx, z);
    bush(-fx, z);
  }

  // Lanterns at the corners and halfway along the sides.
  const postMat = keep(flat(scene, 'plaza-post', PLAZA_COLORS.post));
  const lampMat = keep(flat(scene, 'plaza-lamp', PLAZA_COLORS.lantern, 0.9));
  for (const [x, z] of [
    [-ow + 0.5, -od + 0.5],
    [ow - 0.5, -od + 0.5],
    [-ow + 0.5, od - 0.5],
    [ow - 0.5, od - 0.5],
    [-ow + 0.5, 0],
    [ow - 0.5, 0],
  ]) {
    const post = MeshBuilder.CreateCylinder('lantern-post', { diameter: 0.1, height: 1.3, tessellation: 8 }, scene);
    post.position.set(x, 0.65, z);
    add(postMat, post);
    const lamp = MeshBuilder.CreateSphere('lantern', { diameter: 0.32, segments: 8 }, scene);
    lamp.position.set(x, 1.42, z);
    add(lampMat, lamp);
  }
  // Mushrooms and benches on the rim.
  const stemMat = keep(flat(scene, 'plaza-stem', PLAZA_COLORS.stem));
  const capMats = [keep(flat(scene, 'plaza-cap-a', PLAZA_COLORS.capA)), keep(flat(scene, 'plaza-cap-b', PLAZA_COLORS.capB))];
  [
    [-ow + 1.1, -od + 0.45],
    [ow - 1.2, -od + 0.5],
    [-ow + 0.45, od - 1.3],
    [ow - 0.5, od - 1.4],
    [-3.5, od - 0.5],
    [4.6, -od + 0.5],
  ].forEach(([x, z], i) => {
    const h = 0.35 + rnd() * 0.3;
    const stem = MeshBuilder.CreateCylinder('mush-stem', { diameterTop: 0.14, diameterBottom: 0.2, height: h, tessellation: 8 }, scene);
    stem.position.set(x, h / 2, z);
    add(stemMat, stem);
    const cap = MeshBuilder.CreateSphere('mush-cap', { diameter: 0.5 + rnd() * 0.25, segments: 8, slice: 0.5 }, scene);
    cap.position.set(x, h - 0.02, z);
    add(capMats[i % 2], cap);
  });
  const benchMat = keep(flat(scene, 'plaza-bench', PLAZA_COLORS.bench));
  for (const x of [-(hw + RIM / 2), hw + RIM / 2]) {
    const seat = MeshBuilder.CreateBox('bench-seat', { width: 0.45, depth: 1.6, height: 0.1 }, scene);
    seat.position.set(x, 0.42, 2.6);
    add(benchMat, seat);
    for (const dz of [-0.65, 0.65]) {
      const leg = MeshBuilder.CreateBox('bench-leg', { width: 0.35, depth: 0.1, height: 0.42 }, scene);
      leg.position.set(x, 0.21, 2.6 + dz);
      add(benchMat, leg);
    }
  }

  // The portal arch on the north side (inert, kept low enough for the camera to pass over), and its sign.
  const archMat = keep(flat(scene, 'plaza-arch', PLAZA_COLORS.arch, 0.45));
  const arch = MeshBuilder.CreateTorus('portal-arch', { diameter: 2.1, thickness: 0.16, tessellation: 32 }, scene);
  arch.rotation.x = Math.PI / 2;
  arch.position.set(0, 1.12, od - 0.7);
  add(archMat, arch);
  const veilMat = keep(flat(scene, 'plaza-veil', PLAZA_COLORS.circle, 0.6));
  veilMat.alpha = 0.35;
  veilMat.backFaceCulling = false;
  const veil = MeshBuilder.CreateDisc('portal-veil', { radius: 0.98, tessellation: 32 }, scene);
  veil.position.set(0, 1.12, od - 0.7);
  veil.isPickable = false;
  veil.material = veilMat;
  veil.freezeWorldMatrix();
  keep(veil);
  const signTex = keep(new DynamicTexture('plaza-sign-tex', { width: 512, height: 160 }, scene, true));
  signTex.hasAlpha = false;
  const signMat = keep(new StandardMaterial('plaza-sign-mat', scene));
  signMat.diffuseTexture = signTex;
  signMat.emissiveColor = new Color3(0.35, 0.35, 0.35);
  signMat.specularColor = Color3.Black();
  signMat.backFaceCulling = false;
  const board = MeshBuilder.CreatePlane('plaza-sign', { width: 2.2, height: 0.69 }, scene);
  board.position.set(2.9, 1.2, od - 0.6);
  // Readable from the plaza: a plane's face looks south (toward the players) as it is made; turned, its text would read backwards.
  board.material = signMat;
  board.isPickable = false;
  board.freezeWorldMatrix();
  keep(board);
  for (const dx of [-0.9, 0.9]) {
    const leg = MeshBuilder.CreateCylinder('sign-leg', { diameter: 0.08, height: 1.2, tessellation: 6 }, scene);
    leg.position.set(2.9 + dx, 0.6, od - 0.58);
    add(postMat, leg);
  }
  let signText = '';
  const setSign = (text: string) => {
    if (text === signText) return;
    signText = text;
    const ctx = signTex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = '#fff8ef';
    ctx.fillRect(0, 0, 512, 160);
    ctx.strokeStyle = PLAZA_COLORS.ring;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 502, 150);
    ctx.fillStyle = '#6b5a86';
    ctx.textAlign = 'center';
    ctx.font = '600 30px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('NEXT ARENA', 256, 56);
    ctx.fillStyle = '#2b2b3a';
    ctx.font = '700 40px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(text.length > 24 ? `${text.slice(0, 23)}…` : text, 256, 116);
    signTex.update();
  };
  setSign('Blobbi Rumble');

  // Merge the statics: one draw per material.
  for (const [mat, list] of parts) {
    const m = Mesh.MergeMeshes(list, true, true)!;
    m.name = `plaza-${mat.name}`;
    m.material = mat;
    m.isPickable = false;
    m.receiveShadows = mat === rimMat || mat === soilMat;
    m.freezeWorldMatrix();
    disposables.push(m);
  }

  const made = { materials: scene.materials.filter((m) => !hadMaterials.has(m)), textures: scene.textures.filter((x) => !hadTextures.has(x)) };
  return {
    slabs: [top],
    applyPieces: () => {},
    applyTime: () => {},
    setSign,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const m of made.materials) m.dispose(false, true);
      for (const tex of made.textures) tex.dispose();
    },
  };
}
