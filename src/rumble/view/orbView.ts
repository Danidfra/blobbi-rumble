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
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { ORBS } from '../tuning';
import type { OrbSnapshot } from '../sim/snapshot';

type Orb = Pick<OrbSnapshot, 'x' | 'y' | 'z' | 'active'>;

const ORB_COLOUR = '#ffd33d';
const GLOW_COLOUR = '#fff2a8';
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
  private readonly haloMat: StandardMaterial;
  private readonly glowTex: DynamicTexture;
  private readonly halos: Mesh[] = [];
  private time = 0;

  constructor(
    scene: Scene,
    private orbs: readonly Orb[],
    shadows?: ShadowGenerator,
  ) {
    this.orbMat = new StandardMaterial('orb-mat', scene);
    this.orbMat.diffuseColor = Color3.FromHexString(ORB_COLOUR);
    this.orbMat.emissiveColor = Color3.FromHexString(ORB_COLOUR).scale(0.72);
    this.orbMat.specularColor = new Color3(0.8, 0.8, 0.7);
    this.orbMat.specularPower = 48;
    // A soft radial glow: the pool of light on the grass under each orb, and the halo around it.
    const glow = new DynamicTexture('orb-glow-tex', { width: 128, height: 128 }, scene, true);
    const gctx = glow.getContext() as CanvasRenderingContext2D;
    const grad = gctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,248,200,1)');
    grad.addColorStop(0.35, 'rgba(255,230,120,0.55)');
    grad.addColorStop(1, 'rgba(255,220,100,0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 128, 128);
    glow.update();
    glow.hasAlpha = true;
    this.glowTex = glow;
    this.discMat = new StandardMaterial('orb-disc-mat', scene);
    this.discMat.emissiveColor = Color3.FromHexString(GLOW_COLOUR);
    this.discMat.diffuseTexture = glow;
    this.discMat.opacityTexture = glow;
    this.discMat.disableLighting = true;
    this.discMat.alpha = 0.8;
    this.discMat.zOffset = -4;
    this.haloMat = new StandardMaterial('orb-halo-mat', scene);
    this.haloMat.emissiveColor = Color3.FromHexString(GLOW_COLOUR);
    this.haloMat.opacityTexture = glow;
    this.haloMat.disableLighting = true;
    this.haloMat.alphaMode = Constants.ALPHA_ADD;
    this.haloMat.alpha = 0.55;
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
      const halo = MeshBuilder.CreatePlane(`orb-halo-${i}`, { size: 1.05 }, scene);
      halo.billboardMode = Mesh.BILLBOARDMODE_ALL;
      halo.material = this.haloMat;
      halo.isPickable = false;
      halo.parent = sphere;
      this.halos.push(halo);
      const disc = MeshBuilder.CreateDisc(`orb-disc-${i}`, { radius: 0.55, tessellation: 32 }, scene);
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

  /** Follow the match's orbs (a snapshot's): show what is there, bob it, age the bursts. */
  update(dt: number, orbs: readonly Orb[] = this.orbs) {
    this.orbs = orbs;
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
    for (const h of this.halos) h.dispose();
    this.haloMat.dispose();
    this.glowTex.dispose();
    this.discMat.dispose();
    this.burstMat.dispose();
    this.reachMat.dispose();
  }
}
