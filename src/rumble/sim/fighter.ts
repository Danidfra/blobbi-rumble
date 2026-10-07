/**
 * A FIGHTER, AS THE MATCH KNOWS IT: one player's gameplay body owned by
 * Havok, its facing, combat state, fall state, power and whether it is
 * still in the round. The same class for every fighter, whoever produces
 * its intents. Nothing here is visual: how a fighter looks is the client's
 * (`view/fighterView.ts`), drawn from snapshots.
 *
 * Each step: steer by the intent (scaled by how much control the combat
 * state leaves) as a bounded impulse, start a punch on request; holds,
 * throws and tumbles are applied through `hold`, `react` and `settle`; and
 * the facing turns toward the velocity (`turn`), which is what punches and
 * grabs are aimed along.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { facingYaw } from '../control/facing';
import { steer, type Contest } from '../control/mover';
import { createGameplayBody, type GameplayBody } from '../physics/body';
import { RUMBLE_BODY, type RumbleBody } from '../profile';
import { powerMultiplier, pushAuthority, speedMultiplier } from '../pickups/power';
import { initialFallState, updateFall, type FallState } from '../respawn';
import { COMBAT } from '../tuning';
import {
  controlFactor,
  createCombatState,
  facingFollowsVelocity,
  holdAnchor,
  holdDirection,
  isDown,
  isHolding,
  isTumbling,
  resetCombat,
  startTumble,
  stepHold,
  tryPunch,
  type CombatState,
  type Planar,
  type Point,
  type Reaction,
} from '../combat/combat';
import type { PlayerIntent } from './intent';

/** A match-local player id: stable for the whole match, whatever the roster order. */
export type PlayerId = string;

export interface StepResult {
  grounded: boolean;
  jumped: boolean;
}

const UP = Vector3.Up();

export class FighterSim {
  readonly body: GameplayBody;
  readonly combat: CombatState = createCombatState();
  fall: FallState = initialFallState();
  yaw: number;
  /** Orbs taken this round; the impact multiplier they stand for is `power`. */
  powerLevel = 0;
  /** The impact of the last blow or throw this fighter received, m/s. */
  lastImpact = 0;
  /** Rung out of this round: parked out of play until the next. */
  eliminated = false;
  /** The capsule's tilt from upright, radians, as of the last settle. */
  tilt = 0;
  /** Ground contact as of the last steering. */
  grounded = true;

  constructor(
    readonly id: PlayerId,
    scene: Scene,
    readonly spawn: Vector3,
    readonly spawnYaw: number,
    readonly profile: RumbleBody = RUMBLE_BODY,
  ) {
    this.body = createGameplayBody(scene, `${id}-body`, spawn, profile);
    this.yaw = spawnYaw;
  }

  /** The impact multiplier this fighter's blows and throws carry. */
  get power(): number {
    return powerMultiplier(this.powerLevel);
  }
  /** How much harder it pushes, and holds its ground, body against body. */
  get pushAuthority(): number {
    return pushAuthority(this.powerLevel);
  }
  /** Its walk and run speeds' multiplier. */
  get speedMultiplier(): number {
    return speedMultiplier(this.powerLevel);
  }

  gainPower() {
    this.powerLevel += 1;
  }

  /** Capsule centre and facing in the ground plane; feet in space. */
  at(): Planar {
    const p = this.body.position();
    return { x: p.x, z: p.z };
  }
  feet(): Point {
    const f = this.body.feet();
    return { x: f.x, y: f.y, z: f.z };
  }
  facing(): Planar {
    return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
  }
  velocity(): Planar {
    const v = this.body.velocity();
    return { x: v.x, z: v.z };
  }
  velocity3(): Point {
    const v = this.body.velocity();
    return { x: v.x, y: v.y, z: v.z };
  }
  /** How fast it moves along its facing, m/s. */
  speedAlongFacing(): number {
    const v = this.velocity();
    const f = this.facing();
    return v.x * f.x + v.z * f.z;
  }

  /**
   * Steer by intent, within the control the combat state allows. `contest`
   * is given while this body is against another fighter's: the steering
   * then pushes as a bounded spring, with this fighter's push authority.
   */
  update(dt: number, intent: PlayerIntent, contest?: Contest): StepResult {
    const control = controlFactor(this.combat);
    const carrying = isHolding(this.combat);
    const grounded = this.body.grounded();
    const v = this.body.velocity();
    // Reduced control: the same steering with that much of its authority; carrying slows; neither may jump.
    // Power: a little more walk and run speed (never the jump, never the air share).
    let p = { ...this.profile, walkSpeed: this.profile.walkSpeed * this.speedMultiplier, runSpeed: this.profile.runSpeed * this.speedMultiplier };
    if (control < 1) p = { ...p, acceleration: p.acceleration * control, braking: p.braking * control };
    if (carrying) p = { ...p, walkSpeed: p.walkSpeed * COMBAT.carrySpeed, runSpeed: p.runSpeed * COMBAT.carrySpeed };
    const s = steer(v.x, v.z, { ...intent, jump: intent.jump && control >= 1 && !carrying }, grounded, dt, p, contest);
    const b = this.body.body;
    if (s.dvx !== 0 || s.dvz !== 0) b.applyImpulse(new Vector3(s.dvx * this.profile.mass, 0, s.dvz * this.profile.mass), this.body.position());
    let jumped = false;
    if (s.jumpTo !== null) {
      b.setLinearVelocity(new Vector3(v.x + s.dvx, s.jumpTo, v.z + s.dvz));
      jumped = true;
    }
    if (intent.punch) tryPunch(this.combat);
    this.grounded = grounded;
    return { grounded, jumped };
  }

  /** A velocity change, m/s. */
  push(dvx: number, dvy: number, dvz: number) {
    this.body.body.applyImpulse(new Vector3(dvx * this.profile.mass, dvy * this.profile.mass, dvz * this.profile.mass), this.body.position());
  }

  /** Receive a blow or a throw: the velocity change, and a tumble when the reaction says so. */
  react(r: Reaction, spin: number) {
    this.push(r.dvx, r.dvy, r.dvz);
    this.lastImpact = r.impact;
    if (r.kind === 'tumble') this.knockDown(r.dir, spin);
  }

  /** Off its feet: the capsule is freed to rotate and set spinning over its direction of travel. */
  knockDown(dir: Planar, spin: number) {
    startTumble(this.combat);
    this.body.setGravityFactor(1);
    this.body.setUpright(false);
    // Pitching forward over the travel direction: the axis is up × dir.
    const axis = Vector3.Cross(UP, new Vector3(dir.x, 0, dir.z));
    if (axis.lengthSquared() < 1e-9) axis.set(1, 0, 0);
    this.body.setAngularVelocity(axis.normalize().scale(spin));
  }

  /** Take hold of `victim`: weightless, carried by the spring. */
  hold(victim: FighterSim) {
    victim.body.setGravityFactor(0);
  }

  /** Let `victim` go, whatever the reason: it has weight again. */
  letGo(victim: FighterSim) {
    victim.body.setGravityFactor(1);
  }

  /** Turn the hold direction toward the facing, and give the anchor the held body is kept at. */
  holdStep(dt: number): Point {
    stepHold(this.combat, this.yaw, dt);
    return holdAnchor(this.feet(), this.combat.holdAngle);
  }
  holdDir(): Planar {
    return holdDirection(this.combat);
  }

  /**
   * Keep the physics in step with the combat state: while recovering the
   * capsule is turned upright at a bounded rate, and locked the moment it
   * is nearly there (or when the recovery ends). Returns the tilt, radians.
   */
  settle(): number {
    this.tilt = this.settleTilt();
    return this.tilt;
  }
  private settleTilt(): number {
    const c = this.combat;
    if (!isDown(c)) {
      if (!this.body.isUpright()) this.lock();
      return 0;
    }
    const q = this.body.rotation();
    const bodyUp = UP.applyRotationQuaternion(q);
    const tilt = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(bodyUp, UP))));
    if (isTumbling(c)) return tilt;
    // Recovering: angular velocity that closes the tilt, capped; snap and lock when it is small or time is up.
    if (tilt < COMBAT.uprightSnap || c.recovering >= COMBAT.recoveryDuration - 1e-6) {
      this.lock();
      return 0;
    }
    const axis = Vector3.Cross(bodyUp, UP);
    if (axis.lengthSquared() > 1e-9) this.body.setAngularVelocity(axis.normalize().scale(Math.min(COMBAT.uprightMaxRate, tilt * COMBAT.uprightRate)));
    return tilt;
  }

  /** Lock upright, keeping the facing the tumble left the body with. */
  private lock() {
    const q = this.body.rotation();
    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).applyRotationQuaternion(q);
    if (Math.hypot(forward.x, forward.z) > 1e-6) this.yaw = Math.atan2(forward.x, forward.z);
    this.body.setUpright(true);
  }

  /** The facing follows the velocity, unless stunned, held or down; a carrier turns only by its own steering. */
  turn(dt: number, steering: boolean) {
    if (!facingFollowsVelocity(this.combat, steering)) return;
    const v = this.body.velocity();
    this.yaw = facingYaw(v.x, v.z, this.yaw, dt);
  }

  /** Advance the fall state; true on the step the body crossed the fall line. */
  checkFall(dt: number): boolean {
    const before = this.fall.fallen;
    updateFall(this.fall, this.body.feet().y, dt);
    return !before && this.fall.fallen;
  }

  /** Out of the round: the body leaves play, parked under the arena where it touches nothing. */
  eliminate(parking: Vector3) {
    this.eliminated = true;
    this.body.park(parking);
  }

  /** Back to the spawn, upright and at rest, with no transient state; back in play if it was out. */
  reset() {
    this.eliminated = false;
    this.body.teleport(this.spawn);
    this.yaw = this.spawnYaw;
    this.fall = initialFallState();
    resetCombat(this.combat);
    this.powerLevel = 0;
    this.lastImpact = 0;
    this.tilt = 0;
    this.grounded = true;
  }

  dispose() {
    this.body.dispose();
  }
}
