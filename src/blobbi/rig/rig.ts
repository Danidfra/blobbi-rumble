/**
 * THE RIG: the named moving parts of one Blobbi and a POSE that moves them.
 *
 * A pose is plain numbers (metres, radians, scales) about anatomical
 * pivots: "the body bounces 3 cm and leans 5°", "the left arm swings
 * forward 20°", "the right foot is 10 cm ahead and 4 cm up". The animator
 * produces poses; the rig applies them. Nothing in a pose knows what shape
 * the parts have, so the same animation drives every individual.
 *
 * The hierarchy:
 *
 *   root                  the character's place and facing in the world
 *   ├─ body               the soft body, pivot on the ground under it: squash, stretch, bounce, lean
 *   │  ├─ skin, face, tuft, antennae, horns, ears, tail, arms (at their shoulders)
 *   └─ feet               each foot, pivot at its own centre: stride, lift
 *
 * The body and the feet are siblings on purpose: a body can bounce,
 * squash and lean while the feet stay planted.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { BlobbiParts } from '../geometry/parts';

export interface BodyPose {
  /** Vertical bounce, metres. */
  y: number;
  /** Forward/back lean (pitch, radians, positive leans forward) and sideways rock (roll). */
  pitch: number;
  roll: number;
  /** A small turn of the body (yaw) about the root's facing. */
  yaw: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

export interface ArmPose {
  /** Swing forward (+) / back (-), radians, about the shoulder. */
  swing: number;
  /** Raise outward from the body, radians. */
  raise: number;
}

export interface FootPose {
  /** Ahead (+) / behind (-), metres, along the facing. */
  forward: number;
  /** Lift off the ground, metres. */
  lift: number;
  /** Sideways offset, metres. */
  side: number;
}

export interface BlobbiPose {
  body: BodyPose;
  leftArm: ArmPose;
  rightArm: ArmPose;
  leftFoot: FootPose;
  rightFoot: FootPose;
  /** Secondary sways, radians: the soft parts trail the body. */
  tuft: number;
  antenna: number;
  ear: number;
  tail: number;
}

export const REST_POSE: Readonly<BlobbiPose> = Object.freeze({
  body: { y: 0, pitch: 0, roll: 0, yaw: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
  leftArm: { swing: 0, raise: 0 },
  rightArm: { swing: 0, raise: 0 },
  leftFoot: { forward: 0, lift: 0, side: 0 },
  rightFoot: { forward: 0, lift: 0, side: 0 },
  tuft: 0,
  antenna: 0,
  ear: 0,
  tail: 0,
});

export function clonePose(pose: Readonly<BlobbiPose>): BlobbiPose {
  return {
    body: { ...pose.body },
    leftArm: { ...pose.leftArm },
    rightArm: { ...pose.rightArm },
    leftFoot: { ...pose.leftFoot },
    rightFoot: { ...pose.rightFoot },
    tuft: pose.tuft,
    antenna: pose.antenna,
    ear: pose.ear,
    tail: pose.tail,
  };
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend two poses, `t` of the way from `a` to `b`, into `out`. */
export function lerpPose(a: Readonly<BlobbiPose>, b: Readonly<BlobbiPose>, t: number, out: BlobbiPose): BlobbiPose {
  for (const key of ['y', 'pitch', 'roll', 'yaw', 'scaleX', 'scaleY', 'scaleZ'] as const) out.body[key] = mix(a.body[key], b.body[key], t);
  for (const arm of ['leftArm', 'rightArm'] as const) {
    out[arm].swing = mix(a[arm].swing, b[arm].swing, t);
    out[arm].raise = mix(a[arm].raise, b[arm].raise, t);
  }
  for (const foot of ['leftFoot', 'rightFoot'] as const) {
    out[foot].forward = mix(a[foot].forward, b[foot].forward, t);
    out[foot].lift = mix(a[foot].lift, b[foot].lift, t);
    out[foot].side = mix(a[foot].side, b[foot].side, t);
  }
  out.tuft = mix(a.tuft, b.tuft, t);
  out.antenna = mix(a.antenna, b.antenna, t);
  out.ear = mix(a.ear, b.ear, t);
  out.tail = mix(a.tail, b.tail, t);
  return out;
}

export interface BlobbiRig {
  root: TransformNode;
  body: TransformNode;
  feet: TransformNode;
  parts: BlobbiParts;
  /** The rest position of each foot pivot and of the body, to pose relative to. */
  apply(pose: Readonly<BlobbiPose>): void;
}

export function createRig(scene: Scene, name: string): { root: TransformNode; body: TransformNode; feet: TransformNode } {
  const root = new TransformNode(`${name}-root`, scene);
  const body = new TransformNode(`${name}-body`, scene);
  body.parent = root;
  const feet = new TransformNode(`${name}-feet`, scene);
  feet.parent = root;
  return { root, body, feet };
}

/** Bind the parts to the rig: remembers rest transforms and returns the pose applier. */
export function bindRig(root: TransformNode, body: TransformNode, feet: TransformNode, parts: BlobbiParts): BlobbiRig {
  const restLeft = parts.leftFoot.pivot.position.clone();
  const restRight = parts.rightFoot.pivot.position.clone();
  const sideSign = (pivot: TransformNode) => Math.sign(pivot.position.x) || 1;
  const apply = (pose: Readonly<BlobbiPose>) => {
    body.position.y = pose.body.y;
    body.rotation.set(pose.body.pitch, pose.body.yaw, pose.body.roll);
    body.scaling.set(pose.body.scaleX, pose.body.scaleY, pose.body.scaleZ);
    for (const [part, arm] of [
      [parts.leftArm, pose.leftArm],
      [parts.rightArm, pose.rightArm],
    ] as const) {
      // Swing is about the shoulder's lateral axis; raise lifts the arm out to its side.
      part.pivot.rotation.set(-arm.swing, 0, -sideSign(part.pivot) * arm.raise);
    }
    parts.leftFoot.pivot.position.set(restLeft.x + pose.leftFoot.side, restLeft.y + pose.leftFoot.lift, restLeft.z + pose.leftFoot.forward);
    parts.rightFoot.pivot.position.set(restRight.x + pose.rightFoot.side, restRight.y + pose.rightFoot.lift, restRight.z + pose.rightFoot.forward);
    // A lifted foot tips its toe down a little.
    parts.leftFoot.pivot.rotation.x = pose.leftFoot.lift * 4;
    parts.rightFoot.pivot.rotation.x = pose.rightFoot.lift * 4;
    if (parts.tuft) parts.tuft.pivot.rotation.z = pose.tuft;
    for (const a of parts.antennae) a.pivot.rotation.x = pose.antenna;
    for (const e of parts.ears) e.pivot.rotation.z = pose.ear * sideSign(e.pivot);
    if (parts.tail) parts.tail.pivot.rotation.y = pose.tail;
  };
  return { root, body, feet, parts, apply };
}
