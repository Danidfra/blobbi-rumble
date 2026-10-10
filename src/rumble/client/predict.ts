/**
 * LOCAL PREDICTION: the controlled fighter's locomotion drawn from the
 * player's own keys at once, instead of a round trip later, and pulled
 * back onto the server's account of it as that account arrives. Movement
 * only (walk, run, steering, jumping, falling): no hit, grab, throw, orb,
 * sweeper or ring-out is decided or even guessed here. Presentation only:
 * the predicted transform is drawn and goes nowhere else.
 *
 * The model is the server's own steering (`control/mover.ts`) with the
 * world reduced to what locomotion feels when nothing is in the way:
 * gravity, the floor and its friction, the body's damping (fitted against
 * the Havok match: velocities agree to about a millimetre a second). Other
 * bodies, the sweeper and everything combat does are the server's; when
 * they matter, reconciliation shows it.
 *
 * Reconciliation, on every authoritative state:
 *
 *   1. start from the server's position and velocity at its tick;
 *   2. drop the frames of input the server had already applied (seq < ack),
 *      and of the acknowledged input as much as the server had simulated of
 *      it (its ticks since `ackTick`);
 *   3. replay the remaining frames through the model: the prediction now;
 *   4. against the prediction itself: under `smallError`, keep drawing as is;
 *      over `snapError`, take the new prediction at once (a hard snap);
 *      between, take it but draw the difference as an offset that decays at
 *      `correctionRate`, so the correction is seen as a quick glide.
 *
 * While the server has the fighter in its hands (tumbling, recovering,
 * stunned, held, out of the round, between rounds) there is nothing to
 * predict: it is drawn where the interpolated authority puts it, and the
 * hand-over either way glides through the same decaying offset.
 */
import { onFloor } from '../arena/layout';
import { facingYaw } from '../control/facing';
import { steer } from '../control/mover';
import { speedMultiplier } from '../pickups/power';
import { RUMBLE_BODY } from '../profile';
import type { PlayerIntent } from '../sim/intent';
import type { FighterSnapshot } from '../sim/snapshot';
import { COMBAT } from '../tuning';

export const PREDICT = Object.freeze({
  /** A disagreement under this, metres, is left alone. */
  smallError: 0.05,
  /** Over this, metres, the prediction is replaced at once. */
  snapError: 1.2,
  /** How fast a drawn correction offset decays, 1/s (about 90% in 0.23 s at 10). */
  correctionRate: 10,
  /** The input history kept, seconds (more than any round trip worth predicting through). */
  history: 1.5,
  /** The longest step the model takes at once, seconds (the server's tick). */
  maxStep: 1 / 60,
  /** The floor extends this far under a body's footprint for support, metres (the server's ground rays reach 0.24). */
  footprint: 0.24,
});
export type PredictTuning = typeof PREDICT;

export interface Body {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
}

/** What the server's state says about how the fighter may move now. */
export interface Allowance {
  powerLevel: number;
  carrying: boolean;
}

const STAND_Y = RUMBLE_BODY.capsuleCenterY;

/** Whether the floor is under this centre (within the footprint) and the body is down on it. */
export function supported(b: Pick<Body, 'x' | 'y' | 'z'>, t: PredictTuning = PREDICT): boolean {
  return b.y <= STAND_Y + 1e-3 && onFloor({ x: b.x, z: b.z }, -t.footprint);
}

/**
 * One step of the locomotion model: the server's steering, then gravity,
 * ground friction and damping as Havok applies them, then the move, with
 * the floor holding the body up where it is. Returns the new body and
 * whether it jumped.
 */
export function stepBody(b: Body, intent: PlayerIntent, dt: number, allow: Allowance): { body: Body; jumped: boolean } {
  const p0 = RUMBLE_BODY;
  const k = speedMultiplier(allow.powerLevel);
  const carry = allow.carrying ? COMBAT.carrySpeed : 1;
  const p = { ...p0, walkSpeed: p0.walkSpeed * k * carry, runSpeed: p0.runSpeed * k * carry };
  const grounded = supported(b);
  const s = steer(b.vx, b.vz, { ...intent, jump: intent.jump && !allow.carrying }, grounded, dt, p);
  let vx = b.vx + s.dvx;
  let vz = b.vz + s.dvz;
  let vy = s.jumpTo ?? b.vy;
  vy -= p.gravity * dt;
  if (grounded && s.jumpTo === null) {
    const h = Math.hypot(vx, vz);
    const cut = Math.min(h, p.friction * p.gravity * dt);
    if (h > 0) {
      vx -= (vx / h) * cut;
      vz -= (vz / h) * cut;
    }
  }
  const damp = 1 / (1 + p.linearDamping * dt);
  vx *= damp;
  vz *= damp;
  vy *= damp;
  let y = b.y + vy * dt;
  const x = b.x + vx * dt;
  const z = b.z + vz * dt;
  // The floor: a body over it does not sink through.
  if (y < STAND_Y && onFloor({ x, z }, -PREDICT.footprint) && b.y >= STAND_Y - 0.05) {
    y = STAND_Y;
    vy = 0;
  }
  // The facing follows the velocity while it steers (a carrier only by its own steering), as on the server.
  const steering = intent.x !== 0 || intent.z !== 0;
  const yaw = !allow.carrying || steering ? facingYaw(vx, vz, b.yaw, dt) : b.yaw;
  return { body: { x, y, z, vx, vy, vz, yaw }, jumped: s.jumpTo !== null };
}

/** Advance a body by `dt` in model steps no longer than the server's tick. */
export function advance(b: Body, intent: PlayerIntent, dt: number, allow: Allowance, t: PredictTuning = PREDICT): { body: Body; jumped: boolean } {
  let body = b;
  let jumped = false;
  let left = dt;
  let first = true;
  while (left > 1e-9) {
    const h = Math.min(t.maxStep, left);
    // A jump request belongs to the first step of the frame only.
    const r = stepBody(body, first ? intent : { ...intent, jump: false }, h, allow);
    body = r.body;
    jumped ||= r.jumped;
    left -= h;
    first = false;
  }
  return { body, jumped };
}

/** Whether the server's state leaves the fighter's locomotion to its player (and so to prediction). */
export function predictable(f: FighterSnapshot, playing: boolean): boolean {
  const c = f.combat;
  return playing && !f.eliminated && c.tumble < 0 && c.recovering < 0 && c.stun <= 0 && f.heldBy === null && f.ledge === null;
}

/** One frame of the local input timeline: the input message it was sent under (its seq), how long, and what was held. */
export interface Frame {
  seq: number;
  dt: number;
  intent: PlayerIntent;
}

export interface Reconciliation {
  /** How far the replayed prediction was from what was being drawn, metres. */
  error: number;
  /** 'resumed': prediction taken back from the server (after a tumble, a round reset…), not a prediction error. */
  kind: 'none' | 'kept' | 'smoothed' | 'snapped' | 'resumed' | 'authority';
  /** Frames still unacknowledged. */
  pending: number;
}

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export class LocalPredictor {
  /** The predicted body while predicting; null while the server has it. */
  body: Body | null = null;
  /** The drawn correction: added to whatever is drawn, decaying to nothing. */
  offset: Vec = { x: 0, y: 0, z: 0 };
  readonly history: Frame[] = [];
  /** Where the fighter was last drawn, and with what facing. */
  shown: Body | null = null;
  /** Error figures count steady prediction only; taking the fighter back from the server (a resume) is counted apart. */
  readonly metrics = { reconciles: 0, kept: 0, smoothed: 0, snapped: 0, resumed: 0, resumeSnaps: 0, lastError: 0, maxError: 0, sumError: 0, pending: 0, offset: 0 };
  /** Set by the frame that predicted a jump, for the jump animation. */
  jumpedThisFrame = false;
  private allow: Allowance = { powerLevel: 0, carrying: false };

  constructor(private readonly t: PredictTuning = PREDICT) {}

  get predicting() {
    return this.body !== null;
  }

  /**
   * A client frame: record the input it ran under, advance the prediction
   * (if predicting), and decay the drawn offset.
   */
  frame(dt: number, seq: number, intent: PlayerIntent) {
    this.history.push({ seq, dt, intent });
    let span = this.history.reduce((s, f) => s + f.dt, 0);
    while (span > this.t.history && this.history.length > 1) span -= this.history.shift()!.dt;
    this.jumpedThisFrame = false;
    if (this.body) {
      const r = advance(this.body, intent, dt, this.allow, this.t);
      this.body = r.body;
      this.jumpedThisFrame = r.jumped;
    }
    const k = Math.exp(-this.t.correctionRate * dt);
    this.offset = { x: this.offset.x * k, y: this.offset.y * k, z: this.offset.z * k };
    this.metrics.offset = Math.hypot(this.offset.x, this.offset.y, this.offset.z);
  }

  /**
   * An authoritative state of this fighter: `auth` at `tick` (seconds per
   * tick `tickDt`), having applied this client's inputs through `ack`,
   * first applied at `ackTick`. `allowed`: whether the server leaves its
   * locomotion to the player now.
   */
  reconcile(auth: FighterSnapshot, tick: number, tickDt: number, ack: number, ackTick: number, allowed: boolean): Reconciliation {
    // What the server has applied is history no longer needed.
    while (this.history.length > 0 && this.history[0].seq < ack) this.history.shift();
    this.allow = { powerLevel: auth.powerLevel, carrying: auth.holding !== null };
    const pending = this.history.filter((f) => f.seq > ack).length;
    this.metrics.pending = pending;
    if (!allowed) {
      // The server has it: stop predicting; the drawn position hands over through the offset (see `show`).
      this.body = null;
      return { error: 0, kind: 'authority', pending };
    }
    // Replay: from the server's body, the input it has not simulated yet.
    let body: Body = { x: auth.position.x, y: auth.position.y, z: auth.position.z, vx: auth.velocity.x, vy: auth.velocity.y, vz: auth.velocity.z, yaw: auth.yaw };
    let skip = ack >= 0 ? Math.max(0, tick - ackTick + 1) * tickDt : 0;
    for (const f of this.history) {
      let dt = f.dt;
      if (f.seq === ack && skip > 0) {
        const used = Math.min(skip, dt);
        skip -= used;
        dt -= used;
      }
      if (f.seq < ack || dt <= 1e-9) continue;
      body = advance(body, f.intent, dt, this.allow, this.t).body;
    }
    const was = this.body ?? this.shown;
    this.metrics.reconciles += 1;
    if (!was) {
      this.body = body;
      return { error: 0, kind: 'none', pending };
    }
    // The prediction's error: the replayed account against the prediction (a correction still showing is not error).
    // What is drawn (prediction plus that correction) stays continuous either way.
    const drawn = this.body ? { x: was.x + this.offset.x, y: was.y + this.offset.y, z: was.z + this.offset.z } : { x: was.x, y: was.y, z: was.z };
    const error = Math.hypot(body.x - was.x, body.y - was.y, body.z - was.z);
    const resuming = this.body === null;
    if (resuming) this.metrics.resumed += 1;
    else {
      this.metrics.lastError = error;
      this.metrics.maxError = Math.max(this.metrics.maxError, error);
      this.metrics.sumError += error;
    }
    if (!resuming && error < this.t.smallError) {
      // Close enough: keep the prediction, but take the server's velocity so the drift cannot build.
      this.body = { ...this.body!, vx: body.vx, vy: body.vy, vz: body.vz };
      this.metrics.kept += 1;
      return { error, kind: 'kept', pending };
    }
    if (error > this.t.snapError) {
      this.body = body;
      this.offset = { x: 0, y: 0, z: 0 };
      if (resuming) this.metrics.resumeSnaps += 1;
      else this.metrics.snapped += 1;
      return { error, kind: resuming ? 'resumed' : 'snapped', pending };
    }
    if (resuming) {
      this.offset = { x: drawn.x - body.x, y: drawn.y - body.y, z: drawn.z - body.z };
      this.body = body;
      return { error, kind: 'resumed', pending };
    }
    // Take the corrected prediction, and draw the difference away smoothly.
    this.offset = { x: drawn.x - body.x, y: drawn.y - body.y, z: drawn.z - body.z };
    this.body = body;
    this.metrics.smoothed += 1;
    return { error, kind: 'smoothed', pending };
  }

  /**
   * Where to draw the fighter this frame. Predicting: the prediction plus
   * the decaying offset. Not predicting: `authority` (the interpolated
   * server state) plus the offset; a hand-over between the two starts the
   * offset at the jump, so it glides instead of popping.
   */
  show(authority: Body): Body {
    const base = this.body ?? authority;
    if (this.shown && this.lastBase && (this.body === null) !== this.lastWasAuthority) {
      // A hand-over: whatever the base jumped by is drawn away.
      this.offset = { x: this.offset.x + this.lastBase.x - base.x, y: this.offset.y + this.lastBase.y - base.y, z: this.offset.z + this.lastBase.z - base.z };
      if (Math.hypot(this.offset.x, this.offset.y, this.offset.z) > this.t.snapError) this.offset = { x: 0, y: 0, z: 0 };
    }
    this.lastWasAuthority = this.body === null;
    this.lastBase = base;
    this.shown = { ...base, x: base.x + this.offset.x, y: base.y + this.offset.y, z: base.z + this.offset.z };
    return this.shown;
  }
  private lastBase: Body | null = null;
  private lastWasAuthority = true;

  /** Forget everything (a reconnect, a new slot). */
  reset() {
    this.body = null;
    this.shown = null;
    this.lastBase = null;
    this.lastWasAuthority = true;
    this.offset = { x: 0, y: 0, z: 0 };
    this.history.length = 0;
  }
}
