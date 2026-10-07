/**
 * HOW THE ORBS LOOK: a bright sphere over a soft ground disc at each point,
 * bobbing and turning while it is there, gone the frame it is taken, with
 * a ring that bursts out of the floor where it was. Primitive geometry and
 * an emissive material; nothing of this is gameplay, and nothing of it is
 * the kit's.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { ORBS } from '../tuning';
import type { Orb } from './orbs';

const ORB_COLOUR = '#ffb020';
const BURST_TIME = 0.35;

export class OrbView {
  private readonly spheres: Mesh[] = [];
  private readonly discs: Mesh[] = [];
  private readonly bursts: Mesh[] = [];
  private readonly burstAge: number[] = [];
  private readonly reachRings: Mesh[] = [];
  private readonly orbMat: StandardMaterial;
  private readonly discMat: StandardMaterial;
  private readonly burstMat: StandardMaterial;
  private readonly reachMat: StandardMaterial;
  private time = 0;

  constructor(
    scene: Scene,
    private readonly orbs: Orb[],
    shadows?: ShadowGenerator,
  ) {
    this.orbMat = new StandardMaterial('orb-mat', scene);
    this.orbMat.diffuseColor = Color3.FromHexString(ORB_COLOUR);
    this.orbMat.emissiveColor = Color3.FromHexString(ORB_COLOUR).scale(0.6);
    this.orbMat.specularColor = new Color3(0.6, 0.6, 0.6);
    this.discMat = new StandardMaterial('orb-disc-mat', scene);
    this.discMat.emissiveColor = Color3.FromHexString(ORB_COLOUR);
    this.discMat.disableLighting = true;
    this.discMat.alpha = 0.28;
    this.burstMat = new StandardMaterial('orb-burst-mat', scene);
    this.burstMat.emissiveColor = Color3.FromHexString(ORB_COLOUR);
    this.burstMat.disableLighting = true;
    this.burstMat.alpha = 0.8;
    this.reachMat = new StandardMaterial('orb-reach-mat', scene);
    this.reachMat.emissiveColor = Color3.FromHexString('#ffd56a');
    this.reachMat.disableLighting = true;
    orbs.forEach((o, i) => {
      const sphere = MeshBuilder.CreateSphere(`orb-${i}`, { diameter: 0.44, segments: 16 }, scene);
      sphere.material = this.orbMat;
      sphere.position.set(o.x, o.y, o.z);
      sphere.isPickable = false;
      shadows?.addShadowCaster(sphere);
      this.spheres.push(sphere);
      const disc = MeshBuilder.CreateDisc(`orb-disc-${i}`, { radius: 0.36, tessellation: 32 }, scene);
      disc.material = this.discMat;
      disc.rotation.x = Math.PI / 2;
      disc.position.set(o.x, 0.012, o.z);
      disc.isPickable = false;
      this.discs.push(disc);
      const burst = MeshBuilder.CreateTorus(`orb-burst-${i}`, { diameter: 0.7, thickness: 0.05, tessellation: 40 }, scene);
      burst.material = this.burstMat.clone(`orb-burst-mat-${i}`);
      burst.position.set(o.x, 0.03, o.z);
      burst.isPickable = false;
      burst.setEnabled(false);
      this.bursts.push(burst);
      this.burstAge.push(-1);
      const reach = MeshBuilder.CreateTorus(`orb-reach-${i}`, { diameter: ORBS.collectRadius * 2, thickness: 0.02, tessellation: 48 }, scene);
      reach.material = this.reachMat;
      reach.position.set(o.x, 0.02, o.z);
      reach.isPickable = false;
      reach.setEnabled(false);
      this.reachRings.push(reach);
    });
  }

  /** Start the burst where orb `i` was taken. */
  taken(i: number) {
    this.burstAge[i] = 0;
    this.bursts[i].setEnabled(true);
  }

  /** Follow the state: show what is there, bob it, age the bursts. */
  update(dt: number) {
    this.time += dt;
    this.orbs.forEach((o, i) => {
      const sphere = this.spheres[i];
      sphere.setEnabled(o.active);
      this.discs[i].setEnabled(o.active);
      if (o.active) {
        sphere.position.y = o.y + 0.06 * Math.sin(this.time * 2.4 + i * 1.7);
        sphere.rotation.y += dt * 1.2;
        const pulse = 1 + 0.04 * Math.sin(this.time * 4 + i);
        sphere.scaling.set(pulse, pulse, pulse);
      }
      if (this.burstAge[i] >= 0) {
        this.burstAge[i] += dt;
        const u = Math.min(1, this.burstAge[i] / BURST_TIME);
        const burst = this.bursts[i];
        const k = 1 + 2.2 * u;
        burst.scaling.set(k, 1, k);
        (burst.material as StandardMaterial).alpha = 0.8 * (1 - u);
        if (u >= 1) {
          this.burstAge[i] = -1;
          burst.setEnabled(false);
        }
      }
    });
  }

  showDebug(on: boolean) {
    for (const ring of this.reachRings) ring.setEnabled(on);
  }

  dispose() {
    for (const m of [...this.spheres, ...this.discs, ...this.bursts, ...this.reachRings]) {
      m.material?.dispose();
      m.dispose();
    }
    this.orbMat.dispose();
    this.discMat.dispose();
    this.burstMat.dispose();
    this.reachMat.dispose();
  }
}
