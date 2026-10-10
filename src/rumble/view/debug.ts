/**
 * DEBUG: a toggle (F3) that shows the gameplay colliders over the visual
 * Blobbis, and a HUD that prints what the match knows. The colliders live
 * in the match's own physics world, which is never drawn, so the client
 * draws wireframes of the same shapes where the snapshot puts them: each
 * fighter's capsule (turning with it when it tumbles), the sweeper's bar
 * and post, and the floor's three slabs (the lawn and its decoration are
 * only drawn over them). Off by default.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { RUMBLE_BODY } from '../profile';
import { CLASSIC, type ArenaDef } from '../arena/arenas';
import { SWEEPER_POST } from '../sim/sweeperBody';
import type { MatchSnapshot } from '../sim/snapshot';

export class PhysicsDebug {
  on = false;
  private readonly capsules = new Map<string, Mesh>();
  /** The floor's colliders, exactly as the match has them: compare with the lawn drawn over them. */
  private slabs: Mesh[] = [];
  private bar: Mesh | null = null;
  private post: Mesh | null = null;
  private readonly mat: StandardMaterial;
  private def: ArenaDef = CLASSIC;

  constructor(
    private readonly scene: Scene,
    private readonly hud: HTMLElement,
    def: ArenaDef = CLASSIC,
  ) {
    this.mat = new StandardMaterial('debug-collider-mat', scene);
    this.mat.wireframe = true;
    this.mat.emissiveColor = Color3.FromHexString('#2f6bff');
    this.mat.disableLighting = true;
    this.build(def);
  }

  /** M11A: the colliders of this arena, as the match has them (dynamic pieces follow the snapshot's drop). */
  build(def: ArenaDef) {
    for (const m of [this.bar, this.post, ...this.slabs]) m?.dispose();
    this.slabs = [];
    this.bar = this.post = null;
    this.def = def;
    const t = def.sweeper;
    if (t) {
      this.bar = MeshBuilder.CreateBox('debug-sweeper-bar', { width: t.reach * 2, height: t.top, depth: t.halfWidth * 2 }, this.scene);
      this.post = MeshBuilder.CreateCylinder('debug-sweeper-post', { diameter: t.postRadius * 2, height: SWEEPER_POST.height, tessellation: 24 }, this.scene);
      this.post.position.set(t.pivot.x, SWEEPER_POST.height / 2, t.pivot.z);
      this.bar.position.set(t.pivot.x, t.top / 2, t.pivot.z);
    }
    def.platforms.forEach((r, i) => {
      const slab = MeshBuilder.CreateBox(`debug-slab-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: r.thickness }, this.scene);
      slab.position.set(r.x, r.y - r.thickness / 2, r.z);
      this.slabs.push(slab);
    });
    for (const m of [this.bar, this.post, ...this.slabs]) {
      if (!m) continue;
      m.material = this.mat;
      m.isPickable = false;
      m.setEnabled(this.on);
    }
  }

  toggle() {
    this.on = !this.on;
    this.bar?.setEnabled(this.on);
    this.post?.setEnabled(this.on);
    for (const s of this.slabs) s.setEnabled(this.on);
    for (const c of this.capsules.values()) c.setEnabled(this.on);
  }

  /** Move the wireframes to where the snapshot has the bodies. */
  sync(s: MatchSnapshot) {
    if (!this.on) return;
    if (this.bar && s.sweeper) this.bar.rotation.y = s.sweeper.angle;
    this.def.dynamics.forEach((d, k) => {
      const slab = this.slabs[d.platform];
      const piece = s.pieces[k];
      if (slab && piece) slab.position.y = this.def.platforms[d.platform].y - this.def.platforms[d.platform].thickness / 2 - piece.drop;
    });
    for (const f of s.fighters) {
      let mesh = this.capsules.get(f.id);
      if (!mesh) {
        mesh = MeshBuilder.CreateCapsule(`debug-${f.id}`, { height: RUMBLE_BODY.capsuleHeight, radius: RUMBLE_BODY.capsuleRadius, tessellation: 12, subdivisions: 2 }, this.scene);
        mesh.material = this.mat;
        mesh.isPickable = false;
        mesh.rotationQuaternion = new Quaternion();
        this.capsules.set(f.id, mesh);
      }
      mesh.setEnabled(!f.eliminated);
      mesh.position.set(f.position.x, f.position.y, f.position.z);
      mesh.rotationQuaternion!.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
    }
  }

  print(lines: string[]) {
    this.hud.textContent = lines.join('\n');
  }
}
