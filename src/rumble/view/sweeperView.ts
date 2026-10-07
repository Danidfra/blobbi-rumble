/**
 * HOW THE SWEEPER LOOKS: a post at the pivot and a bar turned to the angle
 * the match reports, and the bar's reach ring for the debug view. No
 * physics: the bar that shoves is the match's (`sim/sweeperBody.ts`).
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { SWEEPER } from '../tuning';
import { SWEEPER_POST } from '../sim/sweeperBody';

export class SweeperView {
  readonly bar: Mesh;
  readonly post: Mesh;
  private readonly reachRing: Mesh;
  private readonly mats: StandardMaterial[] = [];

  constructor(scene: Scene, shadows?: ShadowGenerator) {
    const t = SWEEPER;
    const barMat = new StandardMaterial('sweeper-bar-mat', scene);
    barMat.diffuseColor = Color3.FromHexString('#c9553f');
    barMat.specularColor = new Color3(0.3, 0.3, 0.3);
    const postMat = new StandardMaterial('sweeper-post-mat', scene);
    postMat.diffuseColor = Color3.FromHexString('#5a5f73');
    this.mats.push(barMat, postMat);

    this.bar = MeshBuilder.CreateBox('sweeper-bar', { width: t.reach * 2, height: t.top, depth: t.halfWidth * 2 }, scene);
    this.bar.position.set(t.pivot.x, t.top / 2, t.pivot.z);
    this.bar.material = barMat;
    this.bar.isPickable = false;
    shadows?.addShadowCaster(this.bar);

    this.post = MeshBuilder.CreateCylinder('sweeper-post', { diameter: SWEEPER_POST.diameter, height: SWEEPER_POST.height, tessellation: 24 }, scene);
    this.post.position.set(t.pivot.x, SWEEPER_POST.height / 2, t.pivot.z);
    this.post.material = postMat;
    this.post.isPickable = false;
    shadows?.addShadowCaster(this.post);

    this.reachRing = MeshBuilder.CreateTorus('sweeper-reach', { diameter: t.reach * 2, thickness: 0.03, tessellation: 64 }, scene);
    this.reachRing.position.set(t.pivot.x, t.top + 0.02, t.pivot.z);
    const ringMat = new StandardMaterial('sweeper-reach-mat', scene);
    ringMat.emissiveColor = Color3.FromHexString('#ff6a4d');
    ringMat.disableLighting = true;
    this.reachRing.material = ringMat;
    this.reachRing.isPickable = false;
    this.reachRing.setEnabled(false);
    this.mats.push(ringMat);
  }

  /** Turn the bar to the match's angle (Babylon's rotation.y). */
  apply(angle: number) {
    this.bar.rotation.y = angle;
  }

  showDebug(on: boolean) {
    this.reachRing.setEnabled(on);
  }

  dispose() {
    this.bar.dispose();
    this.post.dispose();
    this.reachRing.dispose();
    for (const m of this.mats) m.dispose();
  }
}
