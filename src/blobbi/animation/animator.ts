/**
 * THE ANIMATOR: motion state in, pose out. Procedural, like the kit's 2D
 * motion: each state is a pure function from time (and a stride phase) to
 * a pose, and the animator blends between states so a Blobbi never snaps.
 *
 * It knows nothing about input devices or physics. A host feeds it what
 * its character controller knows each frame (how fast the character moves,
 * whether it stands on the ground, whether it just jumped or landed) and
 * applies the pose to the rig. For a cutscene or a menu the host can pin a
 * state instead (`setState`).
 *
 * States implemented now: idle, walk, run, jump, fall, land. The list below
 * reserves the party-game states (grab, push, stunned, ragdoll, getup) so a
 * host can already drive them; until they are authored they fall back to
 * idle, and a ragdoll is the physics engine's to pose, not this.
 */
import { lerp, TAU } from '../geometry/math';
import { clonePose, lerpPose, REST_POSE, type BlobbiPose } from '../rig/rig';

export const MOTION_STATES = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'grab', 'push', 'stunned', 'ragdoll', 'getup'] as const;
export type MotionState = (typeof MOTION_STATES)[number];

export interface AnimatorInput {
  /** Seconds since the last update. */
  dt: number;
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  /** Vertical velocity, m/s (positive up). */
  verticalVelocity: number;
  /** True on the frame a jump starts. */
  jumped?: boolean;
  /** True on the frame the character touched down; `impact` is the landing speed, m/s. */
  landed?: boolean;
  impact?: number;
}

export interface AnimatorTuning {
  walkSpeed: number;
  runSpeed: number;
  /** Stride cycles per metre travelled. */
  strideRate: number;
  /** How quickly the pose follows its target (1/s). */
  follow: number;
}

export const DEFAULT_TUNING: AnimatorTuning = { walkSpeed: 0.4, runSpeed: 3.2, strideRate: 1.0, follow: 22 };

const wave = (phase: number, lag = 0) => Math.sin(TAU * (phase - lag));
const ease = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const DEG = Math.PI / 180;

export class BlobbiAnimator {
  state: MotionState = 'idle';
  /** When set, the state is pinned and the input no longer chooses it. */
  pinned: MotionState | null = null;
  pose: BlobbiPose = clonePose(REST_POSE);
  private target: BlobbiPose = clonePose(REST_POSE);
  private time = 0;
  private stateTime = 0;
  private stride = 0;
  private landImpact = 0;
  private readonly tuning: AnimatorTuning;

  constructor(tuning: Partial<AnimatorTuning> = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  setState(state: MotionState | null) {
    this.pinned = state;
    if (state) this.enter(state);
  }

  private enter(state: MotionState) {
    if (state === this.state) return;
    this.state = state;
    this.stateTime = 0;
  }

  /** Choose the state the input calls for. */
  private choose(input: AnimatorInput) {
    if (this.pinned) {
      // A pinned walk or run still needs a stride; a pinned idle breathes.
      this.enter(this.pinned);
      return;
    }
    if (input.jumped) return this.enter('jump');
    if (input.landed && this.state !== 'land') {
      this.landImpact = Math.min(1, (input.impact ?? 0) / 7);
      return this.enter('land');
    }
    if (!input.grounded) {
      if (this.state === 'jump' && input.verticalVelocity > 0.2) return;
      return this.enter(input.verticalVelocity > 0.2 ? 'jump' : 'fall');
    }
    if (this.state === 'land' && this.stateTime < 0.28) return;
    const t = this.tuning;
    if (input.speed > (t.walkSpeed + t.runSpeed) / 2) return this.enter('run');
    if (input.speed > t.walkSpeed * 0.5) return this.enter('walk');
    return this.enter('idle');
  }

  update(input: AnimatorInput): BlobbiPose {
    const dt = Math.min(0.1, Math.max(0, input.dt));
    this.time += dt;
    this.stateTime += dt;
    this.choose(input);
    const t = this.tuning;
    // The stride advances with the ground covered, so feet never slide; a pinned gait walks at its own pace.
    const strideSpeed = this.pinned === 'walk' ? 1.6 : this.pinned === 'run' ? t.runSpeed : input.speed;
    if (this.state === 'walk' || this.state === 'run') this.stride = (this.stride + dt * strideSpeed * t.strideRate) % 1;
    else this.stride = this.stride * Math.max(0, 1 - dt * 6);

    const target = this.target;
    lerpPose(REST_POSE, REST_POSE, 0, target);
    switch (this.state) {
      case 'idle':
        this.idle(target);
        break;
      case 'walk':
        this.gait(target, 0);
        break;
      case 'run':
        this.gait(target, 1);
        break;
      case 'jump':
        this.jump(target);
        break;
      case 'fall':
        this.fall(target);
        break;
      case 'land':
        this.land(target);
        break;
      default:
        this.idle(target);
    }
    // Within a gait the pose should track its cycle closely; the smoothing is for the transitions between states.
    const snappy = this.state === 'land' || this.state === 'jump' ? 2 : this.state === 'walk' || this.state === 'run' ? 1.6 : 1;
    const k = 1 - Math.exp(-dt * t.follow * snappy);
    lerpPose(this.pose, target, k, this.pose);
    return this.pose;
  }

  private idle(p: BlobbiPose) {
    const breath = (1 - Math.cos(TAU * (this.time / 4))) / 2;
    p.body.scaleY = 1 + 0.018 * breath;
    p.body.scaleX = 1 + 0.012 * breath;
    p.body.scaleZ = 1 + 0.012 * breath;
    p.body.y = 0.004 * breath;
    const ph = this.time / 4;
    p.tuft = 1.2 * DEG * wave(ph, 0.1);
    p.antenna = 2.5 * DEG * wave(ph);
    p.ear = 1.4 * DEG * wave(ph, 0.15);
    p.tail = 4 * DEG * wave(ph, 0.05);
    // A slow, barely-there weight shift.
    p.body.roll = 0.6 * DEG * wave(this.time / 7);
    p.leftArm.raise = 2 * DEG * breath;
    p.rightArm.raise = 2 * DEG * breath;
  }

  /** The walk (`run` = 0) to the run (`run` = 1): feet planted and carried back, then lifted and swung forward. */
  private gait(p: BlobbiPose, run: number) {
    const ph = this.stride;
    const stride = lerp(0.055, 0.1, run);
    const lift = lerp(0.045, 0.085, run);
    const bounce = lerp(0.012, 0.03, run);
    const foot = (phase: number) => {
      const f = phase - Math.floor(phase);
      if (f < 0.5) return { forward: stride * (1 - 4 * f), lift: 0 };
      const u = (f - 0.5) / 0.5;
      return { forward: stride * (-1 + 2 * ease(u)), lift: lift * Math.sin(Math.PI * u) };
    };
    const l = foot(ph);
    const r = foot(ph + 0.5);
    p.leftFoot.forward = l.forward;
    p.leftFoot.lift = l.lift;
    p.rightFoot.forward = r.forward;
    p.rightFoot.lift = r.lift;
    // Highest as the legs pass each other, lowest with both feet down; rocks toward the planted foot.
    const up = Math.sin(TAU * ph) ** 2;
    p.body.y = bounce * up;
    p.body.scaleY = 1 + lerp(0.01, 0.035, run) * (up - 0.5);
    p.body.scaleX = 1 - lerp(0.006, 0.02, run) * (up - 0.5);
    p.body.scaleZ = p.body.scaleX;
    p.body.roll = lerp(1.1, 2.2, run) * DEG * wave(ph);
    p.body.pitch = lerp(2, 9, run) * DEG;
    const swing = lerp(13, 38, run) * DEG * Math.cos(TAU * ph);
    p.leftArm.swing = -swing;
    p.rightArm.swing = swing;
    p.leftArm.raise = lerp(2, 14, run) * DEG;
    p.rightArm.raise = p.leftArm.raise;
    const follow = lerp(1, 1.8, run);
    p.tuft = follow * 3.2 * DEG * wave(2 * ph, 0.16);
    p.antenna = follow * 6 * DEG * wave(2 * ph, 0.22);
    p.ear = follow * 3.6 * DEG * wave(2 * ph, 0.2);
    p.tail = follow * (7 * DEG * wave(ph, 0.12) + 2.5 * DEG * wave(2 * ph, 0.2));
  }

  private jump(p: BlobbiPose) {
    // Launch: a stretch that settles into the fall pose over the rise.
    const u = clamp01(this.stateTime / 0.35);
    const stretch = 1 - ease(u);
    p.body.scaleY = 1 + 0.16 * stretch;
    p.body.scaleX = 1 - 0.09 * stretch;
    p.body.scaleZ = p.body.scaleX;
    p.body.pitch = -4 * DEG;
    p.leftArm.raise = lerp(70, 50, u) * DEG;
    p.rightArm.raise = p.leftArm.raise;
    p.leftArm.swing = 20 * DEG;
    p.rightArm.swing = 20 * DEG;
    p.leftFoot.lift = 0.05 + 0.02 * stretch;
    p.rightFoot.lift = 0.045;
    p.leftFoot.forward = 0.02;
    p.rightFoot.forward = -0.03;
    p.antenna = -8 * DEG;
    p.tuft = -4 * DEG;
    p.ear = -6 * DEG;
    p.tail = 0;
  }

  private fall(p: BlobbiPose) {
    const flail = this.stateTime * 7;
    p.body.scaleY = 1.05;
    p.body.scaleX = 0.97;
    p.body.scaleZ = 0.97;
    p.body.pitch = -6 * DEG;
    p.leftArm.raise = 45 * DEG + 8 * DEG * Math.sin(flail);
    p.rightArm.raise = 45 * DEG - 8 * DEG * Math.sin(flail);
    p.leftArm.swing = 10 * DEG * Math.cos(flail);
    p.rightArm.swing = -10 * DEG * Math.cos(flail);
    p.leftFoot.lift = 0.04 + 0.01 * Math.sin(flail);
    p.rightFoot.lift = 0.04 - 0.01 * Math.sin(flail);
    p.antenna = -10 * DEG;
    p.tuft = -5 * DEG;
    p.ear = -8 * DEG;
    p.tail = 6 * DEG * Math.sin(flail);
  }

  private land(p: BlobbiPose) {
    // A squash on impact that springs back: the amount scales with the landing speed.
    const amount = 0.5 + 0.5 * this.landImpact;
    const u = clamp01(this.stateTime / 0.32);
    const squash = (1 - u) * Math.cos(u * Math.PI * 1.5) * amount;
    p.body.scaleY = 1 - 0.22 * squash;
    p.body.scaleX = 1 + 0.14 * squash;
    p.body.scaleZ = p.body.scaleX;
    p.body.y = -0.015 * Math.max(0, squash);
    p.body.pitch = 3 * DEG * squash;
    p.leftArm.raise = 30 * DEG * Math.max(0, squash);
    p.rightArm.raise = p.leftArm.raise;
    p.antenna = 12 * DEG * squash;
    p.tuft = 6 * DEG * squash;
    p.ear = 8 * DEG * squash;
  }
}
