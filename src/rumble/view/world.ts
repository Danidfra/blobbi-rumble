/**
 * THE WORLD AROUND THE ARENA: the camera (the same orbit camera the game
 * has always had: the presenter still drives its target and distance), a
 * bright daytime light rig, the sky, and a few cheap distant things (cloud
 * puffs, tiny floating islands) so the arena floats somewhere. Presentation
 * only, built from a theme; nothing here touches the match.
 *
 * Lighting: a hemispheric sky light (cool from above, a soft green bounce
 * from below) for fill, and one warm sun, high and nearly overhead, so a
 * Blobbi's shadow falls close under it and grounds it from the gameplay
 * camera. Shadows are a single 2048 map with PCF filtering (no blur passes),
 * cast only by the fighters, the sweeper and the orbs.
 */
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { GARDEN, type ArenaTheme } from './theme';
import { seeded } from './seeded';

export interface World {
  camera: ArcRotateCamera;
  shadows: ShadowGenerator;
}

const C = Color3.FromHexString;

export function createWorld(scene: Scene, canvas: HTMLCanvasElement, theme: ArenaTheme = GARDEN): World {
  scene.clearColor = Color4.FromColor3(C(theme.skyHorizon), 1);
  scene.ambientColor = new Color3(0.32, 0.34, 0.36);

  // The camera: as before (the presenter sets its angles, limits and framing every frame).
  const camera = new ArcRotateCamera('camera', Math.PI / 2 - 0.3, 1.3, 3.6, new Vector3(0, 0.55, 0), scene);
  camera.lowerRadiusLimit = 1.2;
  camera.upperRadiusLimit = 14;
  camera.upperBetaLimit = Math.PI / 2 - 0.04;
  camera.wheelDeltaPercentage = 0.02;
  camera.minZ = 0.05;
  camera.maxZ = 400;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

  const sky = new HemisphericLight('sky', new Vector3(0.15, 1, 0.1), scene);
  sky.intensity = 0.72;
  sky.diffuse = C(theme.skyLight);
  sky.groundColor = C(theme.groundBounce);
  sky.specular = new Color3(0.05, 0.05, 0.05);

  const sun = new DirectionalLight('sun', new Vector3(-0.32, -1, -0.42).normalize(), scene);
  sun.position = new Vector3(6, 16, 8);
  sun.intensity = 0.95;
  sun.diffuse = C(theme.sun);
  sun.specular = new Color3(0.25, 0.24, 0.22);
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 40;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.002;
  shadows.normalBias = 0.01;
  shadows.darkness = 0.38;

  buildSky(scene, theme);
  buildClouds(scene, theme);
  buildIslands(scene, theme);

  // Distant things fade into the horizon; the arena itself is always nearer than the fog.
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = 30;
  scene.fogEnd = 95;
  scene.fogColor = C(theme.fog);

  return { camera, shadows };
}

/** A big sphere seen from inside, painted top to bottom: sky blue overhead, pale at the horizon, a hazy blue below. */
function buildSky(scene: Scene, theme: ArenaTheme) {
  const tex = new DynamicTexture('sky-tex', { width: 16, height: 512 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, theme.skyTop);
  g.addColorStop(0.42, theme.skyHorizon);
  g.addColorStop(0.5, theme.skyHorizon);
  g.addColorStop(1, theme.skyBelow);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  tex.update();
  const mat = new StandardMaterial('sky-mat', scene);
  mat.emissiveTexture = tex;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.fogEnabled = false;
  const dome = MeshBuilder.CreateSphere('sky', { diameter: 600, segments: 16, sideOrientation: Mesh.BACKSIDE }, scene);
  dome.material = mat;
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
}

/** Soft cloud puffs: one merged puff mesh, many instances around and below the island. */
function buildClouds(scene: Scene, theme: ArenaTheme) {
  const parts: Mesh[] = [];
  for (const [x, y, z, r] of [
    [0, 0, 0, 1],
    [1.1, -0.15, 0.2, 0.75],
    [-1.05, -0.2, 0.1, 0.7],
    [0.4, 0.35, -0.3, 0.65],
    [-0.35, 0.25, 0.4, 0.55],
  ]) {
    const s = MeshBuilder.CreateSphere('cloud-part', { diameter: r * 2, segments: 8 }, scene);
    s.position.set(x, y, z);
    parts.push(s);
  }
  const puff = Mesh.MergeMeshes(parts, true)!;
  puff.name = 'cloud';
  puff.scaling.y = 0.6;
  const mat = new StandardMaterial('cloud-mat', scene);
  // Lit, so the puffs have soft form: bright tops from the sun and sky, a cool underside.
  mat.diffuseColor = C(theme.cloud);
  mat.emissiveColor = C('#d6e2f0').scale(0.62);
  mat.specularColor = Color3.Black();
  puff.material = mat;
  puff.isPickable = false;
  const rnd = seeded(7);
  // A ring of clouds below the island and a few on the horizon: the arena floats above them.
  const spots: [number, number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rnd() * 0.3;
    const d = 16 + rnd() * 22;
    spots.push([Math.cos(a) * d, -7 - rnd() * 6, Math.sin(a) * d, 1.6 + rnd() * 1.8]);
  }
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.15 + (i / 6) * Math.PI * 0.7 + rnd() * 0.2;
    spots.push([Math.cos(a) * 60, 6 + rnd() * 10, Math.sin(a) * 60, 3 + rnd() * 3]);
  }
  puff.scaling.y = 1;
  for (const [x, y, z, s] of spots) puff.thinInstanceAdd(Matrix.Compose(new Vector3(s, s * 0.55 * 0.6, s * 0.9), Quaternion.RotationYawPitchRoll(rnd() * Math.PI, 0, 0), new Vector3(x, y, z)));
  puff.thinInstanceRefreshBoundingInfo(false);
  puff.freezeWorldMatrix();
}

/** A few tiny floating islands in the distance: a grassy top over a rocky point. */
function buildIslands(scene: Scene, theme: ArenaTheme) {
  const top = MeshBuilder.CreateCylinder('isle-top', { diameterTop: 2.6, diameterBottom: 2.5, height: 0.3, tessellation: 9 }, scene);
  const grass = new StandardMaterial('isle-grass', scene);
  grass.diffuseColor = C(theme.grassA);
  grass.specularColor = Color3.Black();
  top.material = grass;
  const rock = MeshBuilder.CreateCylinder('isle-rock', { diameterTop: 2.45, diameterBottom: 0.2, height: 1.3, tessellation: 7 }, scene);
  rock.position.y = -0.8;
  const rockMat = new StandardMaterial('isle-rock-mat', scene);
  rockMat.diffuseColor = C(theme.soil);
  rockMat.specularColor = Color3.Black();
  rock.material = rockMat;
  const tree = MeshBuilder.CreateSphere('isle-tree', { diameter: 0.9, segments: 6 }, scene);
  tree.position.set(0.25, 0.65, 0.1);
  const treeMat = new StandardMaterial('isle-tree-mat', scene);
  treeMat.diffuseColor = C(theme.tuft);
  treeMat.specularColor = Color3.Black();
  tree.material = treeMat;
  const isle = Mesh.MergeMeshes([top, rock, tree], true, true, undefined, false, true)!;
  isle.name = 'isle';
  isle.isPickable = false;
  const rnd = seeded(11);
  // Far off and low, in the haze: a sense of a world, not something to look at.
  const spots: [number, number, number, number][] = [
    [-58, -1, 62, 2.6],
    [62, -3, 58, 2],
    [-75, 2, 8, 3],
    [78, 0, 18, 2.6],
    [18, 1, 85, 3.4],
    [-30, -4, 80, 1.8],
  ];
  for (const [x, y, z, s] of spots) isle.thinInstanceAdd(Matrix.Compose(new Vector3(s, s, s), Quaternion.RotationYawPitchRoll(rnd() * Math.PI * 2, 0, 0), new Vector3(x, y, z)));
  isle.thinInstanceRefreshBoundingInfo(false);
  isle.freezeWorldMatrix();
}
