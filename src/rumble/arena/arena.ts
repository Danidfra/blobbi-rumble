/**
 * THE ARENA, built: three floor slabs over a void (a wide centre, a
 * narrower wing each side), a rim lip along every outer edge so the void
 * reads from any angle, the sweeper's circle faintly on its wing, and the
 * two spawns. Primitive geometry, no art. Its physics is three static
 * boxes on the ground layer; nothing stops a body going over the rim. The
 * shape itself is `layout.ts`; this only draws and solidifies it.
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { LAYER } from '../profile';
import { SWEEPER } from '../tuning';
import { ARENA, floorSlabs, rimSegments, type Rect } from './layout';

export { ARENA } from './layout';

export interface Arena {
  slabs: Mesh[];
  spawns: { a: Vector3; b: Vector3 };
  dispose(): void;
}

function gridTexture(scene: Scene, name: string, fill: string, metresWide: number, metresDeep: number): DynamicTexture {
  const px = 128;
  const w = Math.round(metresWide * px);
  const h = Math.round(metresDeep * px);
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(70,80,100,0.16)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= w; x += px) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let z = 0; z <= h; z += px) {
    ctx.beginPath();
    ctx.moveTo(0, z);
    ctx.lineTo(w, z);
    ctx.stroke();
  }
  tex.update();
  return tex;
}

export function createArena(scene: Scene, shadows?: ShadowGenerator): Arena {
  const disposables: { dispose(): void }[] = [];
  const slabs: Mesh[] = [];
  const colours = ['#ebe6d8', '#dcd3bf', '#dcd3bf'];
  floorSlabs().forEach((r: Rect, i) => {
    const slab = MeshBuilder.CreateBox(`arena-slab-${i}`, { width: r.halfWidth * 2, depth: r.halfDepth * 2, height: ARENA.thickness }, scene);
    slab.position.set(r.x, -ARENA.thickness / 2, r.z);
    const mat = new StandardMaterial(`arena-slab-mat-${i}`, scene);
    const tex = gridTexture(scene, `arena-slab-tex-${i}`, colours[i], r.halfWidth * 2, r.halfDepth * 2);
    mat.diffuseTexture = tex;
    mat.specularColor = Color3.Black();
    slab.material = mat;
    slab.receiveShadows = true;
    const aggregate = new PhysicsAggregate(slab, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0 }, scene);
    aggregate.shape.filterMembershipMask = LAYER.ground;
    aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
    shadows?.addShadowCaster(slab);
    slabs.push(slab);
    disposables.push(aggregate, slab, mat, tex);
  });

  // The rim: a red lip along every outer edge, flush with the floor, so the void reads.
  const lipMat = new StandardMaterial('arena-lip-mat', scene);
  lipMat.diffuseColor = Color3.FromHexString('#d9534f');
  lipMat.emissiveColor = Color3.FromHexString('#d9534f').scale(0.25);
  lipMat.specularColor = Color3.Black();
  disposables.push(lipMat);
  rimSegments().forEach(([from, to], i) => {
    const len = Math.hypot(to.x - from.x, to.z - from.z);
    const lip = MeshBuilder.CreateBox(`arena-lip-${i}`, { width: len, depth: 0.28, height: 0.05 }, scene);
    lip.position.set((from.x + to.x) / 2, 0.025, (from.z + to.z) / 2);
    lip.rotation.y = -Math.atan2(to.z - from.z, to.x - from.x);
    // Nudged inward (toward the arena's middle) so the lip sits on the floor, not over the void.
    const nx = -(to.z - from.z) / len;
    const nz = (to.x - from.x) / len;
    const sign = Math.sign(-((from.x + to.x) / 2) * nx - ((from.z + to.z) / 2) * nz) || 1;
    lip.position.x += nx * sign * 0.1;
    lip.position.z += nz * sign * 0.1;
    lip.material = lipMat;
    lip.isPickable = false;
    disposables.push(lip);
  });

  // The sweeper's circle, faint on its wing's floor: where the bar reaches.
  const sweep = MeshBuilder.CreateDisc('arena-sweep', { radius: SWEEPER.reach + 0.15, tessellation: 64 }, scene);
  sweep.rotation.x = Math.PI / 2;
  sweep.position.set(SWEEPER.pivot.x, 0.006, SWEEPER.pivot.z);
  const sweepMat = new StandardMaterial('arena-sweep-mat', scene);
  sweepMat.diffuseColor = Color3.FromHexString('#c9553f');
  sweepMat.emissiveColor = Color3.FromHexString('#c9553f').scale(0.3);
  sweepMat.specularColor = Color3.Black();
  sweepMat.alpha = 0.16;
  sweep.material = sweepMat;
  sweep.isPickable = false;
  disposables.push(sweep, sweepMat);

  return {
    slabs,
    spawns: { a: new Vector3(ARENA.spawns.a.x, 0, ARENA.spawns.a.z), b: new Vector3(ARENA.spawns.b.x, 0, ARENA.spawns.b.z) },
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
}
