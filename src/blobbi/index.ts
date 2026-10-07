/**
 * blobbi-3d: a procedural 3D Blobbi for Babylon.js.
 *
 * ```ts
 * import { createBlobbi3D } from 'blobbi-3d';
 * const blobbi = createBlobbi3D(identityFromTheEvent, scene);
 * scene.onBeforeRenderObservable.add(() => blobbi.update({ dt, speed, grounded, verticalVelocity }));
 * ```
 *
 * Layers, lowest first (each depends only on those above it):
 *   identity/    seed, RNG, colours, genome, identity: a port of the kit, no 3D
 *   morphology/  genes resolved to bounded root-unit numbers: a port of the kit, no 3D
 *   geometry/    the body surface and the parts, in metres (Babylon mesh data)
 *   markings/    the skin texture painter (canvas 2D)
 *   face/        expressions (a port of the kit) and the 3D face
 *   materials/   the palette as materials
 *   rig/         pivots and poses
 *   animation/   motion states to poses
 *   renderer/    `createBlobbi3D` and the gameplay profile
 */
export * from './identity';
export { deriveMorphology, MORPHOLOGY_RANGES, type BlobbiMorphology } from './morphology/morphology';
export { buildBodySurface, buildBodyVertexData, type BodySurface, type SurfacePoint } from './geometry/body';
export { UNIT, VIEWER_X, m, worldX, worldY } from './geometry/units';
export { CANON_HEIGHT, GROUND } from './geometry/plan';
export { paintSkin } from './markings/painter';
export { EMOTIONS, expressionOf, resolveFacePose, NEUTRAL_POSE, KEY_POSES, type Emotion, type ExpressionWeights, type FacePose } from './face/expressions';
export { REST_POSE, lerpPose, clonePose, type BlobbiPose, type BlobbiRig } from './rig/rig';
export { BlobbiAnimator, MOTION_STATES, DEFAULT_TUNING, type AnimatorInput, type AnimatorTuning, type MotionState } from './animation/animator';
export { createBlobbi3D, createCanonicalBlobbi3D, type Blobbi3D, type Blobbi3DOptions, type ExpressionName } from './renderer/createBlobbi3D';
export { BLOBBI_GAMEPLAY_PROFILE, type BlobbiGameplayProfile } from './renderer/gameplay';
