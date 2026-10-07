/**
 * A small pleasant place to stand: a soft gradient sky, a pastel ground
 * with a faint grid, a few bushes, warm key light with soft shadows and a
 * cool fill. Nothing here is Blobbi-specific.
 */
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Scene } from '@babylonjs/core/scene';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';

export interface Environment {
  camera: ArcRotateCamera;
  shadows: ShadowGenerator;
  ground: Mesh;
}

export function createEnvironment(scene: Scene, canvas: HTMLCanvasElement): Environment {
  scene.clearColor = new Color4(0.86, 0.9, 0.97, 1);
  scene.ambientColor = new Color3(0.35, 0.35, 0.4);

  const camera = new ArcRotateCamera('camera', Math.PI / 2 - 0.3, 1.3, 3.6, new Vector3(0, 0.55, 0), scene);
  camera.lowerRadiusLimit = 1.2;
  camera.upperRadiusLimit = 14;
  camera.upperBetaLimit = Math.PI / 2 - 0.04;
  camera.wheelDeltaPercentage = 0.02;
  camera.minZ = 0.05;
  camera.attachControl(canvas, true);
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

  const sky = new HemisphericLight('sky', new Vector3(0.2, 1, 0.1), scene);
  sky.intensity = 0.75;
  sky.diffuse = new Color3(1, 0.98, 0.95);
  sky.groundColor = new Color3(0.62, 0.66, 0.78);
  sky.specular = new Color3(0.08, 0.08, 0.08);

  const sun = new DirectionalLight('sun', new Vector3(-0.55, -1, -0.65).normalize(), scene);
  sun.position = new Vector3(5, 10, 6);
  sun.intensity = 0.95;
  sun.diffuse = new Color3(1, 0.96, 0.9);
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 30;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.useBlurExponentialShadowMap = true;
  shadows.blurKernel = 24;
  shadows.darkness = 0.45;

  // The ground: a wide disc with a faint grid so motion reads.
  const ground = MeshBuilder.CreateGround('ground', { width: 60, height: 60, subdivisions: 2 }, scene);
  const groundMat = new StandardMaterial('ground-mat', scene);
  const tex = new DynamicTexture('ground-tex', { width: 512, height: 512 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = '#cfe3b9';
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(80,110,70,0.16)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  tex.update();
  tex.uScale = 30;
  tex.vScale = 30;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  groundMat.diffuseTexture = tex;
  groundMat.specularColor = Color3.Black();
  ground.material = groundMat;
  ground.receiveShadows = true;

  // A few bushes and a low wall for scale and for something to walk around.
  const bush = new StandardMaterial('bush-mat', scene);
  bush.diffuseColor = Color3.FromHexString('#7fb86a');
  bush.specularColor = Color3.Black();
  const stone = new StandardMaterial('stone-mat', scene);
  stone.diffuseColor = Color3.FromHexString('#d9cfc1');
  stone.specularColor = Color3.Black();
  const props: Mesh[] = [];
  const bushes: [number, number, number][] = [
    [-3.2, 2.6, 0.55],
    [-3.9, 1.9, 0.4],
    [3.4, 3.1, 0.6],
    [4.1, 2.3, 0.35],
    [2.6, -3.4, 0.5],
    [-2.9, -3.0, 0.45],
  ];
  for (const [x, z, r] of bushes) {
    const b = MeshBuilder.CreateSphere('bush', { diameter: r * 2, segments: 12 }, scene);
    b.position.set(x, r * 0.75, z);
    b.scaling.y = 0.75;
    b.material = bush;
    props.push(b);
  }
  const wall = MeshBuilder.CreateBox('wall', { width: 2.4, height: 0.35, depth: 0.5 }, scene);
  wall.position.set(0, 0.175, -4.2);
  wall.material = stone;
  props.push(wall);
  const stepBox = MeshBuilder.CreateBox('step', { width: 1.2, height: 0.25, depth: 1.2 }, scene);
  stepBox.position.set(3.0, 0.125, -1.2);
  stepBox.material = stone;
  props.push(stepBox);
  for (const p of props) {
    p.receiveShadows = true;
    shadows.addShadowCaster(p);
  }

  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = 14;
  scene.fogEnd = 34;
  scene.fogColor = new Color3(0.86, 0.9, 0.97);

  return { camera, shadows, ground };
}
