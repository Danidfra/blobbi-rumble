/**
 * THE ARENA: one flat elevated platform over a void, with visible edges and
 * room to run. Primitive geometry, no art. Its only physics is a static box
 * on the ground layer; nothing stops a body from going over the edge.
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
import { LAYER } from './profile';

export interface Arena {
  platform: Mesh;
  /** Half-extents of the platform's top, metres. */
  halfWidth: number;
  halfDepth: number;
  /** The platform's top surface height. */
  topY: number;
  spawns: { a: Vector3; b: Vector3 };
  dispose(): void;
}

export const ARENA = { width: 12, depth: 10, thickness: 0.6 } as const;

export function createArena(scene: Scene, shadows?: ShadowGenerator): Arena {
  const { width, depth, thickness } = ARENA;
  const platform = MeshBuilder.CreateBox('arena-platform', { width, depth, height: thickness }, scene);
  platform.position.y = -thickness / 2;
  const mat = new StandardMaterial('arena-mat', scene);
  // A pale top with a grid and a dark band at the rim, so the edge reads from any angle.
  const tex = new DynamicTexture('arena-tex', { width: 1024, height: 1024 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#e9e4d6';
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.strokeStyle = 'rgba(70,80,100,0.18)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 1024; i += 1024 / 12) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 1024);
    ctx.moveTo(0, i);
    ctx.lineTo(1024, i);
    ctx.stroke();
  }
  ctx.strokeStyle = '#d9534f';
  ctx.lineWidth = 28;
  ctx.strokeRect(14, 14, 996, 996);
  tex.update();
  mat.diffuseTexture = tex;
  mat.specularColor = Color3.Black();
  platform.material = mat;
  platform.receiveShadows = true;
  const aggregate = new PhysicsAggregate(platform, PhysicsShapeType.BOX, { mass: 0, friction: 0.8, restitution: 0 }, scene);
  aggregate.shape.filterMembershipMask = LAYER.ground;
  aggregate.shape.filterCollideMask = LAYER.ground | LAYER.character;
  shadows?.addShadowCaster(platform);
  return {
    platform,
    halfWidth: width / 2,
    halfDepth: depth / 2,
    topY: 0,
    spawns: { a: new Vector3(-2.5, 0, 0), b: new Vector3(2.5, 0, 0) },
    dispose: () => {
      aggregate.dispose();
      platform.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
