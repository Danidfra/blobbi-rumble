/**
 * `createBlobbi3D(identity, scene)`: one procedural 3D Blobbi.
 *
 * ```
 *   identity ──► genome ──► morphology (root units) ──► body surface ──► skin texture
 *                                                         │              face meshes
 *                                                         │              limbs and traits
 *                                                         └──► rig ◄── animator (pose)
 * ```
 *
 * Everything identity-derived is deterministic: the same identity builds
 * the same surface, the same texture and the same parts, to the number.
 * Animation, blinking and gaze are runtime state and are the host's to
 * drive (`update`, `setExpression`, `setGaze`, `animator`).
 *
 * The returned handle owns every node, mesh, material and texture it made
 * and frees them all in `dispose()`.
 */
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import { BlobbiAnimator, type AnimatorInput, type AnimatorTuning } from '../animation/animator';
import { EMOTIONS, lerpFacePose, NEUTRAL_POSE, resolveFacePose, type Emotion, type ExpressionWeights, type FacePose } from '../face/expressions';
import { buildFace, type FaceRig, type Gaze } from '../face/features';
import { buildBodySurface, buildBodyVertexData, type BodySurface } from '../geometry/body';
import { buildParts, type BlobbiParts } from '../geometry/parts';
import { createRng } from '../identity/rng';
import { genomeOf, resolveBlobbiIdentity, type BlobbiIdentity, type BlobbiIdentityInput } from '../identity/identity';
import { canonicalGenome, type BlobbiGenome } from '../identity/genome';
import { paintSkin } from '../markings/painter';
import { createBlobbiMaterials, type BlobbiMaterials } from '../materials/materials';
import { deriveMorphology, type BlobbiMorphology } from '../morphology/morphology';
import { bindRig, createRig, type BlobbiRig } from '../rig/rig';

export interface Blobbi3DOptions {
  /** A name prefix for every node and mesh. */
  name?: string;
  /** Register every mesh as a shadow caster. */
  shadows?: ShadowGenerator | null;
  /** Texture size; the default is sharp enough for a close-up. */
  textureWidth?: number;
  animator?: Partial<AnimatorTuning>;
}

export type ExpressionName = Emotion | 'neutral';

export interface Blobbi3D {
  identity: BlobbiIdentity;
  /** Fields the input did not state and that were taken from the seed. */
  inferred: string[];
  genome: BlobbiGenome;
  morphology: BlobbiMorphology;
  surface: BodySurface;
  rig: BlobbiRig;
  parts: BlobbiParts;
  face: FaceRig;
  materials: BlobbiMaterials;
  skin: DynamicTexture;
  animator: BlobbiAnimator;
  /** All meshes, for a host that wants to pick, highlight or shadow them. */
  meshes: Mesh[];
  /** Height of the standing character, metres (crown of the body, without traits). */
  height: number;
  /** Set the face: a named expression, or weights to blend, eased over `seconds`. */
  setExpression(expression: ExpressionName | ExpressionWeights, seconds?: number): void;
  setSleeping(sleeping: boolean): void;
  /** Where the eyes look, -1..1 per axis (x = 1 is the viewer's right when the Blobbi faces the viewer). */
  setGaze(x: number, y: number): void;
  /** Advance runtime state: animation pose, expression easing, blinks. */
  update(input: AnimatorInput): void;
  /** Blink now (the Blobbi also blinks on its own). */
  blink(): void;
  dispose(): void;
}

/** A blink: quick to close, a moment shut, slower to open. Seconds. */
const BLINK_DURATION = 0.22;
function blinkClosure(u: number): number {
  const ease = (t: number) => t * t * (3 - 2 * t);
  if (u < 0.35) return ease(u / 0.35);
  if (u < 0.45) return 1;
  return 1 - ease((u - 0.45) / 0.55);
}

export function createBlobbi3D(input: BlobbiIdentityInput | string, scene: Scene, options: Blobbi3DOptions = {}): Blobbi3D {
  const { identity, inferred } = resolveBlobbiIdentity(input);
  return buildBlobbi3D(identity, genomeOf(identity), inferred, scene, options);
}

/** The canonical Blobbi: every gene at zero, the authored purple. The comparison point for every individual. */
export function createCanonicalBlobbi3D(scene: Scene, options: Blobbi3DOptions = {}): Blobbi3D {
  const genome = canonicalGenome();
  const identity: BlobbiIdentity = {
    seed: genome.seed,
    algorithm: genome.version,
    colors: { base: '#8749ef', secondary: '#481696', eye: '#201538' },
    traits: { antenna: 'none', horns: 'none', ears: 'none', tail: 'none', pattern: 'solid', specialMark: 'none', belly: false, freckles: false },
  };
  return buildBlobbi3D(identity, genome, [], scene, options);
}

function buildBlobbi3D(identity: BlobbiIdentity, genome: BlobbiGenome, inferred: string[], scene: Scene, options: Blobbi3DOptions): Blobbi3D {
  const name = options.name ?? 'blobbi';
  const morphology = deriveMorphology(genome);
  const surface = buildBodySurface({
    bodyWidth: morphology.bodyWidth,
    bodyHeight: morphology.bodyHeight,
    topWidth: morphology.topWidth,
    belly: morphology.belly,
    roundness: morphology.roundness,
    lean: morphology.lean,
  });

  const nodes = createRig(scene, name);

  // The skin.
  const W = options.textureWidth ?? 2048;
  const H = W / 2;
  const skin = new DynamicTexture(`${name}-skin`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  skin.wrapU = Texture.WRAP_ADDRESSMODE;
  skin.wrapV = Texture.CLAMP_ADDRESSMODE;
  skin.anisotropicFilteringLevel = 8;
  const ctx = skin.getContext() as CanvasRenderingContext2D;
  let facePose: FacePose = NEUTRAL_POSE;
  let sleeping = false;
  const repaint = () => {
    paintSkin(ctx, W, H, surface, morphology, { pose: facePose, sleeping });
    skin.update(true);
  };
  repaint();

  const materials = createBlobbiMaterials(scene, morphology.palette, skin, name);

  const bodyMesh = new Mesh(`${name}-skin-mesh`, scene);
  bodyMesh.parent = nodes.body;
  buildBodyVertexData(surface).applyToMesh(bodyMesh, false);
  bodyMesh.material = materials.body;
  bodyMesh.isPickable = false;

  const face = buildFace(scene, nodes.body, surface, morphology, materials, name);
  const parts = buildParts(scene, nodes.body, nodes.feet, surface, morphology, materials, name);
  const rig = bindRig(nodes.root, nodes.body, nodes.feet, parts);
  const meshes: Mesh[] = [bodyMesh, ...parts.all];
  face.root.getChildMeshes().forEach((m) => meshes.push(m as Mesh));
  if (options.shadows) for (const mesh of meshes) options.shadows.addShadowCaster(mesh, false);

  const animator = new BlobbiAnimator(options.animator);

  // Expression easing and blinking: runtime state, the Blobbi's own.
  let fromPose: FacePose = NEUTRAL_POSE;
  let toPose: FacePose = NEUTRAL_POSE;
  let easeT = 1;
  let easeSeconds = 0.18;
  let lastBlush = NEUTRAL_POSE.blush;
  const gaze: Gaze = { x: 0, y: 0 };
  const blinkRng = createRng(`${identity.seed}\u0000blink`);
  let nextBlink = 2 + blinkRng.next() * 3;
  let blinkT = -1;

  const setExpression = (expression: ExpressionName | ExpressionWeights, seconds = 0.18) => {
    const weights: ExpressionWeights = typeof expression === 'string' ? (expression === 'neutral' ? {} : { [expression]: 1 }) : expression;
    fromPose = facePose;
    toPose = resolveFacePose(weights);
    easeT = 0;
    easeSeconds = Math.max(0.001, seconds);
  };

  const update = (input: AnimatorInput) => {
    const dt = Math.min(0.1, Math.max(0, input.dt));
    rig.apply(animator.update(input));
    if (easeT < 1) {
      easeT = Math.min(1, easeT + dt / easeSeconds);
      facePose = lerpFacePose(fromPose, toPose, easeT * easeT * (3 - 2 * easeT));
    }
    nextBlink -= dt;
    if (nextBlink <= 0 && blinkT < 0) {
      blinkT = 0;
      nextBlink = 2.5 + blinkRng.next() * 4;
    }
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      const u = blinkT / BLINK_DURATION;
      blink = u < 1 ? blinkClosure(u) : 0;
      if (u >= 1) blinkT = -1;
    }
    face.apply(facePose, gaze, sleeping, blink);
    if (Math.abs(facePose.blush - lastBlush) > 0.02 && easeT >= 1) {
      lastBlush = facePose.blush;
      repaint();
    }
  };
  face.apply(facePose, gaze, sleeping, 0);

  return {
    identity,
    inferred,
    genome,
    morphology,
    surface,
    rig,
    parts,
    face,
    materials,
    skin,
    animator,
    meshes,
    height: surface.topY,
    setExpression,
    setSleeping: (value) => {
      sleeping = value;
      repaint();
    },
    blink: () => {
      if (blinkT < 0) blinkT = 0;
    },
    setGaze: (x, y) => {
      gaze.x = Math.max(-1, Math.min(1, x));
      gaze.y = Math.max(-1, Math.min(1, y));
    },
    update,
    dispose: () => {
      nodes.root.dispose(false, true);
      materials.dispose();
      skin.dispose();
    },
  };
}

export { EMOTIONS };
