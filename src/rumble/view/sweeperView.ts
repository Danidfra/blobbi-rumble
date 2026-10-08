/**
 * HOW THE SWEEPER LOOKS: a whimsical garden spinner. A candy-striped pole
 * with a flower on top that spins with it, and a padded bar, coral and
 * cream, with round soft ends. It reads as the thing that turns and knocks
 * you away, without looking sharp. No physics: the bar that shoves is the
 * match's (`sim/sweeperBody.ts`), and this one matches it: the same pivot,
 * reach (the round ends stop exactly at it) and height (0.22 m, low enough
 * to jump), a hair thinner across than the collider's box.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { SWEEPER } from '../tuning';
import { SWEEPER_POST } from '../sim/sweeperBody';
import { GARDEN, type ArenaTheme } from './theme';

const C = Color3.FromHexString;

/** Stripes: `n` bands of two colours across the texture's u. */
function stripes(scene: Scene, name: string, a: string, b: string, n: number, vertical = false): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 256, height: 256 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const w = 256 / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    if (vertical) ctx.fillRect(0, i * w, 256, w);
    else ctx.fillRect(i * w, 0, w, 256);
  }
  tex.update();
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

export class SweeperView {
  /** The turning part (bar, ends, flower): rotated to the match's angle. */
  readonly spinner: TransformNode;
  readonly post: Mesh;
  private readonly reachRing: Mesh;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene, shadows?: ShadowGenerator, theme: ArenaTheme = GARDEN) {
    const t = SWEEPER;
    const radius = 0.11;
    this.spinner = new TransformNode('sweeper-spinner', scene);
    this.spinner.position.set(t.pivot.x, 0, t.pivot.z);

    // The padded bar: a cylinder along the bar with candy rings, round soft ends finishing exactly at the reach.
    const barMat = new StandardMaterial('sweeper-bar-mat', scene);
    // Candy rings along the bar (the cylinder's v runs along its length).
    const ring = stripes(scene, 'sweeper-bar-tex', theme.sweeperA, theme.sweeperB, 2, true);
    ring.vScale = 5;
    barMat.diffuseTexture = ring;
    barMat.specularColor = new Color3(0.18, 0.18, 0.18);
    barMat.emissiveColor = C(theme.sweeperA).scale(0.12);
    const bar = MeshBuilder.CreateCylinder('sweeper-bar', { diameter: radius * 2, height: (t.reach - radius) * 2, tessellation: 16 }, scene);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = radius;
    bar.material = barMat;
    bar.parent = this.spinner;
    const endMat = new StandardMaterial('sweeper-end-mat', scene);
    endMat.diffuseColor = C(theme.sweeperA);
    endMat.specularColor = new Color3(0.2, 0.2, 0.2);
    endMat.emissiveColor = C(theme.sweeperA).scale(0.15);
    for (const side of [-1, 1]) {
      const end = MeshBuilder.CreateSphere(`sweeper-end-${side}`, { diameter: radius * 2, segments: 10 }, scene);
      end.position.set(side * (t.reach - radius), radius, 0);
      end.material = endMat;
      end.parent = this.spinner;
      shadows?.addShadowCaster(end);
      this.disposables.push(end);
    }

    // The pole: candy stripes, the collider's own diameter and height.
    const poleMat = new StandardMaterial('sweeper-pole-mat', scene);
    const poleTex = stripes(scene, 'sweeper-pole-tex', theme.sweeperPole, theme.sweeperB, 8, true);
    poleMat.diffuseTexture = poleTex;
    poleMat.specularColor = new Color3(0.15, 0.15, 0.15);
    this.post = MeshBuilder.CreateCylinder('sweeper-post', { diameter: SWEEPER_POST.diameter, height: SWEEPER_POST.height, tessellation: 20 }, scene);
    this.post.position.set(t.pivot.x, SWEEPER_POST.height / 2, t.pivot.z);
    this.post.material = poleMat;
    this.post.isPickable = false;
    const rim = MeshBuilder.CreateTorus('sweeper-post-rim', { diameter: SWEEPER_POST.diameter, thickness: 0.08, tessellation: 20 }, scene);
    rim.position.set(t.pivot.x, SWEEPER_POST.height, t.pivot.z);
    rim.material = poleMat;

    // The flower on top: it spins with the bar, so the turning is seen even from far.
    const petalMat = new StandardMaterial('sweeper-petal-mat', scene);
    petalMat.diffuseColor = C(theme.sweeperCap);
    petalMat.specularColor = Color3.Black();
    petalMat.emissiveColor = C(theme.sweeperCap).scale(0.15);
    const parts: Mesh[] = [];
    for (let k = 0; k < 6; k++) {
      const p = MeshBuilder.CreateSphere('sweeper-petal', { diameter: 0.26, segments: 6 }, scene);
      const a = (k / 6) * Math.PI * 2;
      p.position.set(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17);
      p.scaling.set(1, 0.35, 0.65);
      p.rotation.y = -a;
      parts.push(p);
    }
    const petals = Mesh.MergeMeshes(parts, true)!;
    petals.material = petalMat;
    petals.position.y = SWEEPER_POST.height + 0.07;
    petals.parent = this.spinner;
    const heartMat = new StandardMaterial('sweeper-heart-mat', scene);
    heartMat.diffuseColor = C(theme.flowerHeart);
    heartMat.specularColor = Color3.Black();
    const heart = MeshBuilder.CreateSphere('sweeper-heart', { diameter: 0.18, segments: 8 }, scene);
    heart.scaling.y = 0.6;
    heart.position.y = SWEEPER_POST.height + 0.1;
    heart.material = heartMat;
    heart.parent = this.spinner;

    for (const m of [bar, this.post, rim, petals, heart]) {
      m.isPickable = false;
      shadows?.addShadowCaster(m);
    }

    this.reachRing = MeshBuilder.CreateTorus('sweeper-reach', { diameter: t.reach * 2, thickness: 0.03, tessellation: 64 }, scene);
    this.reachRing.position.set(t.pivot.x, t.top + 0.02, t.pivot.z);
    const ringMat = new StandardMaterial('sweeper-reach-mat', scene);
    ringMat.emissiveColor = C('#ff6a4d');
    ringMat.disableLighting = true;
    this.reachRing.material = ringMat;
    this.reachRing.isPickable = false;
    this.reachRing.setEnabled(false);
    this.disposables.push(bar, this.post, rim, petals, heart, this.reachRing, barMat, endMat, poleMat, petalMat, heartMat, ringMat, ring, poleTex, this.spinner);
  }

  /** Turn the spinner to the match's angle (Babylon's rotation.y). */
  apply(angle: number) {
    this.spinner.rotation.y = angle;
  }

  showDebug(on: boolean) {
    this.reachRing.setEnabled(on);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
