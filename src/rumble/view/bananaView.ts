/**
 * HOW THE BANANA PEELS LOOK (M11F): a yellow crescent (a tube along an arc)
 * with brown tips, lying flat on the floor and turning slowly; a soft
 * shadow disc under it; a ring that bursts out where one was slipped on;
 * and, for a player out of the round who is aiming, a reticle on the floor
 * where the next peel would land. A small pool of meshes, reused.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { MatchSnapshot } from '../sim/snapshot';
import { BANANAS } from '../tuning';

type Peel = MatchSnapshot['bananas'][number];

const PEEL = '#ffd21f';
const TIP = '#6b4a1e';
const RETICLE = '#fff1a6';
const BURST_TIME = 0.4;

export class BananaView {
  private readonly peels: Mesh[] = [];
  private readonly shadows: Mesh[] = [];
  private readonly bursts: Mesh[] = [];
  private readonly burstAge: number[] = [];
  private readonly reticle: Mesh;
  private readonly reticleDot: Mesh;
  private readonly peelMat: StandardMaterial;
  private readonly tipMat: StandardMaterial;
  private readonly shadowMat: StandardMaterial;
  private readonly burstMat: StandardMaterial;
  private readonly reticleMat: StandardMaterial;
  private readonly template: Mesh;
  private time = 0;

  constructor(
    private readonly scene: Scene,
    private readonly shadowGen?: ShadowGenerator,
  ) {
    this.peelMat = new StandardMaterial('peel-mat', scene);
    this.peelMat.diffuseColor = Color3.FromHexString(PEEL);
    this.peelMat.specularColor = new Color3(0.5, 0.5, 0.3);
    this.peelMat.specularPower = 32;
    this.tipMat = new StandardMaterial('peel-tip-mat', scene);
    this.tipMat.diffuseColor = Color3.FromHexString(TIP);
    this.tipMat.specularColor = Color3.Black();
    this.shadowMat = new StandardMaterial('peel-shadow-mat', scene);
    this.shadowMat.diffuseColor = Color3.Black();
    this.shadowMat.emissiveColor = Color3.Black();
    this.shadowMat.alpha = 0.22;
    this.shadowMat.disableLighting = true;
    this.burstMat = new StandardMaterial('peel-burst-mat', scene);
    this.burstMat.emissiveColor = Color3.FromHexString(PEEL);
    this.burstMat.disableLighting = true;
    this.burstMat.alpha = 0.8;
    this.reticleMat = new StandardMaterial('peel-reticle-mat', scene);
    this.reticleMat.emissiveColor = Color3.FromHexString(RETICLE);
    this.reticleMat.disableLighting = true;
    this.reticleMat.alpha = 0.85;

    // The peel: a crescent of tube, a brown cap at each tip, merged into one mesh to clone.
    const arc: Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = -0.95 + (1.9 * i) / 12;
      arc.push(new Vector3(Math.sin(a) * 0.26, 0.03 + (1 - Math.cos(a)) * 0.05, Math.cos(a) * 0.26 - 0.2));
    }
    const body = MeshBuilder.CreateTube('peel-body', { path: arc, radius: 0.055, tessellation: 10, cap: Mesh.CAP_ALL }, scene);
    body.material = this.peelMat;
    const tipA = MeshBuilder.CreateSphere('peel-tip-a', { diameter: 0.09, segments: 6 }, scene);
    tipA.position.copyFrom(arc[0]);
    tipA.material = this.tipMat;
    const tipB = MeshBuilder.CreateSphere('peel-tip-b', { diameter: 0.09, segments: 6 }, scene);
    tipB.position.copyFrom(arc[arc.length - 1]);
    tipB.material = this.tipMat;
    const merged = Mesh.MergeMeshes([body, tipA, tipB], true, true, undefined, false, true);
    this.template = merged ?? body;
    this.template.setEnabled(false);
    for (let i = 0; i < BANANAS.maxActive; i++) {
      const peel = this.template.clone(`peel-${i}`);
      peel.setEnabled(false);
      shadowGen?.addShadowCaster(peel);
      this.peels.push(peel);
      const shadow = MeshBuilder.CreateDisc(`peel-shadow-${i}`, { radius: 0.3, tessellation: 20 }, scene);
      shadow.rotation.x = Math.PI / 2;
      shadow.material = this.shadowMat;
      shadow.setEnabled(false);
      this.shadows.push(shadow);
    }
    this.reticle = MeshBuilder.CreateTorus('peel-reticle', { diameter: 0.9, thickness: 0.05, tessellation: 32 }, scene);
    this.reticle.material = this.reticleMat;
    this.reticle.setEnabled(false);
    this.reticleDot = MeshBuilder.CreateDisc('peel-reticle-dot', { radius: 0.07, tessellation: 12 }, scene);
    this.reticleDot.rotation.x = Math.PI / 2;
    this.reticleDot.material = this.reticleMat;
    this.reticleDot.setEnabled(false);
  }

  /** A peel was slipped on (or went) here: a ring bursts out of the floor. */
  burst(x: number, y: number, z: number) {
    const ring = MeshBuilder.CreateTorus(`peel-burst-${this.bursts.length}`, { diameter: 0.6, thickness: 0.05, tessellation: 28 }, this.scene);
    ring.position.set(x, y + 0.03, z);
    ring.material = this.burstMat;
    this.bursts.push(ring);
    this.burstAge.push(0);
  }

  update(dt: number, peels: readonly Peel[], aim: { x: number; y: number; z: number } | null) {
    this.time += dt;
    this.peels.forEach((peel, i) => {
      const p = peels[i];
      const on = !!p;
      if (peel.isEnabled() !== on) {
        peel.setEnabled(on);
        this.shadows[i].setEnabled(on);
      }
      if (!p) return;
      peel.position.set(p.x, p.y, p.z);
      peel.rotation.y = p.x * 1.7 + p.z * 2.3 + this.time * 0.6;
      // Fresh from the throw: a little bounce as it lands.
      const landing = Math.max(0, 0.25 - p.age) / 0.25;
      peel.position.y += Math.sin(landing * Math.PI) * 0.35;
      this.shadows[i].position.set(p.x, p.y - BANANAS.height + 0.012, p.z);
    });
    const show = aim !== null;
    if (this.reticle.isEnabled() !== show) {
      this.reticle.setEnabled(show);
      this.reticleDot.setEnabled(show);
    }
    if (aim) {
      const pulse = 1 + 0.08 * Math.sin(this.time * 6);
      this.reticle.position.set(aim.x, aim.y + 0.05, aim.z);
      this.reticle.scaling.set(pulse, 1, pulse);
      this.reticleDot.position.set(aim.x, aim.y + 0.05, aim.z);
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      this.burstAge[i] += dt;
      const u = this.burstAge[i] / BURST_TIME;
      if (u >= 1) {
        this.bursts[i].dispose();
        this.bursts.splice(i, 1);
        this.burstAge.splice(i, 1);
        continue;
      }
      const s = 1 + 3 * u;
      this.bursts[i].scaling.set(s, 1, s);
      this.bursts[i].visibility = 1 - u;
    }
  }

  dispose() {
    for (const m of [...this.peels, ...this.shadows, ...this.bursts, this.reticle, this.reticleDot, this.template]) {
      this.shadowGen?.removeShadowCaster(m);
      m.dispose();
    }
    for (const m of [this.peelMat, this.tipMat, this.shadowMat, this.burstMat, this.reticleMat]) m.dispose();
  }
}
