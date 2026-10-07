/**
 * A FIGHTER: one player, the same class for both. A gameplay body owned by
 * Havok, an input, a combat state, a fall state, and the visual Blobbi
 * that follows the body. Everything either player can do is here, once.
 *
 * Each frame: read the intent (scaled by how much control the combat
 * state leaves), steer the body by a bounded impulse, start a punch on
 * request, then carry the visual Blobbi to the body and lay the game's own
 * feedback (a swinging arm, a lean, a squash, a face) over the kit's
 * animation. Holds, throws and tumbles are applied to the body through
 * `hold`, `react` and `settle`. The kit knows nothing of any of this.
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { createBlobbi3D, type AnimatorInput, type Blobbi3D, type ExpressionName } from '@blobbi-kit/3d';
import { animatorInput, facingYaw, initialBridge, type BridgeState } from '../control/animationBridge';
import type { MoveIntent, PlayerInput } from '../control/input';
import { steer } from '../control/mover';
import { createGameplayBody, type GameplayBody } from '../physics/body';
import { RUMBLE_BODY, type RumbleBody } from '../profile';
import { powerCap, powerMultiplier } from '../pickups/power';
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
  isPunching,
  isRecovering,
  isStunned,
  isTumbling,
  resetCombat,
  startTumble,
  stepHold,
  tryPunch,
  type CombatState,
  type Planar,
  type Point,
  type Reaction,
} from './combat';

export interface FighterFrame {
  grounded: boolean;
  jumped: boolean;
  intent: MoveIntent;
}

/** What the kit's animator is told: the body's truth, unless the combat state says the body is not walking anywhere. */
export function presentationInput(c: CombatState, truth: AnimatorInput): AnimatorInput {
  if (c.held) return { ...truth, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: false };
  if (isTumbling(c)) return { ...truth, speed: 0, grounded: false, verticalVelocity: -1, jumped: false, landed: false };
  if (isRecovering(c)) return { ...truth, speed: 0, grounded: true, verticalVelocity: 0, jumped: false };
  return truth;
}

const UP = Vector3.Up();

export class Fighter {
  readonly blobbi: Blobbi3D;
  readonly body: GameplayBody;
  readonly combat: CombatState = createCombatState();
  fall: FallState = initialFallState();
  bridge: BridgeState = initialBridge();
  yaw: number;
  /** Orbs taken this round; the impact multiplier they stand for is `power`. */
  powerLevel = 0;
  /** The impact of the last blow or throw this fighter received, m/s (debug). */
  lastImpact = 0;
  private lastExpression: ExpressionName = 'happy';
  private squash = 0;
  private readonly rings: Mesh[] = [];
  private readonly powerRing: Mesh;
  private readonly powerRingMat: StandardMaterial;
  private powerFlash = 0;

  constructor(
    readonly label: string,
    readonly scene: Scene,
    seed: string,
    readonly spawn: Vector3,
    readonly spawnYaw: number,
    readonly input: PlayerInput,
    shadows?: ShadowGenerator,
    readonly profile: RumbleBody = RUMBLE_BODY,
  ) {
    this.blobbi = createBlobbi3D(seed, scene, { name: label, shadows });
    this.body = createGameplayBody(scene, `${label}-body`, spawn, profile);
    this.yaw = spawnYaw;
    this.blobbi.setExpression('happy', 0);
    // Debug rings: the grab and punch reach, on the ground under the fighter. Hidden unless debug is on.
    const ring = (name: string, radius: number, hex: string) => {
      const mesh = MeshBuilder.CreateTorus(`${label}-${name}`, { diameter: radius * 2, thickness: 0.03, tessellation: 48 }, scene);
      const mat = new StandardMaterial(`${label}-${name}-mat`, scene);
      mat.emissiveColor = Color3.FromHexString(hex);
      mat.disableLighting = true;
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.rings.push(mesh);
      return mesh;
    };
    ring('grab-ring', COMBAT.grabRange, '#2bb3ff');
    ring('punch-ring', COMBAT.punchRange, '#ff4d4d');
    // The power ring: a thin glow on the ground under a powered fighter, brighter with each level. Hidden at zero.
    this.powerRing = MeshBuilder.CreateTorus(`${label}-power-ring`, { diameter: 1.0, thickness: 0.05, tessellation: 48 }, scene);
    this.powerRingMat = new StandardMaterial(`${label}-power-ring-mat`, scene);
    this.powerRingMat.emissiveColor = Color3.FromHexString('#ffb020');
    this.powerRingMat.disableLighting = true;
    this.powerRing.material = this.powerRingMat;
    this.powerRing.isPickable = false;
    this.powerRing.setEnabled(false);
  }

  /** The impact multiplier this fighter's blows and throws carry. */
  get power(): number {
    return powerMultiplier(this.powerLevel);
  }

  /** An orb taken: one level more (the multiplier caps on its own). */
  gainPower() {
    this.powerLevel += 1;
    this.powerFlash = 0.3;
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

  /** Steer by intent, within the control the combat state allows. Returns what happened, for combat and animation. */
  update(dt: number, cameraYaw: number): FighterFrame {
    const intent = this.input.read(cameraYaw);
    const control = controlFactor(this.combat);
    const carrying = isHolding(this.combat);
    const grounded = this.body.grounded();
    const v = this.body.velocity();
    // Reduced control: the same steering with that much of its authority; carrying slows; neither may jump.
    let p = this.profile;
    if (control < 1) p = { ...p, acceleration: p.acceleration * control, braking: p.braking * control };
    if (carrying) p = { ...p, walkSpeed: p.walkSpeed * COMBAT.carrySpeed, runSpeed: p.runSpeed * COMBAT.carrySpeed };
    const s = steer(v.x, v.z, { ...intent, jump: intent.jump && control >= 1 && !carrying }, grounded, dt, p);
    const b = this.body.body;
    if (s.dvx !== 0 || s.dvz !== 0) b.applyImpulse(new Vector3(s.dvx * this.profile.mass, 0, s.dvz * this.profile.mass), this.body.position());
    let jumped = false;
    if (s.jumpTo !== null) {
      b.setLinearVelocity(new Vector3(v.x + s.dvx, s.jumpTo, v.z + s.dvz));
      jumped = true;
    }
    if (intent.punch) tryPunch(this.combat);
    return { grounded, jumped, intent };
  }

  /** A velocity change, m/s. */
  push(dvx: number, dvy: number, dvz: number) {
    this.body.body.applyImpulse(new Vector3(dvx * this.profile.mass, dvy * this.profile.mass, dvz * this.profile.mass), this.body.position());
  }

  /** Receive a blow or a throw: the velocity change, and a tumble when the reaction says so. */
  react(r: Reaction, spin: number) {
    this.push(r.dvx, r.dvy, r.dvz);
    this.lastImpact = r.impact;
    this.squash = COMBAT.hitSquash;
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
  hold(victim: Fighter) {
    victim.body.setGravityFactor(0);
  }

  /** Let `victim` go, whatever the reason: it has weight again. */
  letGo(victim: Fighter) {
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

  /** Carry the visual Blobbi to the body and lay the game's feedback over the kit's animation. */
  follow(dt: number, frame: FighterFrame) {
    const c = this.combat;
    const v = this.body.velocity();
    // A stunned, held or downed body keeps its facing; a carrier turns only by its own steering.
    const steering = frame.intent.x !== 0 || frame.intent.z !== 0;
    if (facingFollowsVelocity(c, steering)) this.yaw = facingYaw(v.x, v.z, this.yaw, dt);
    const root = this.blobbi.rig.root;
    const centre = this.body.position();
    if (isDown(c) && !this.body.isUpright()) {
      // The whole Blobbi turns with its capsule, about the capsule's centre.
      const q = this.body.rotation();
      if (!root.rotationQuaternion) root.rotationQuaternion = new Quaternion();
      Quaternion.RotationYawPitchRollToRef(this.yaw, 0, 0, root.rotationQuaternion);
      q.multiplyToRef(root.rotationQuaternion, root.rotationQuaternion);
      const down = new Vector3(0, -this.profile.capsuleCenterY, 0).applyRotationQuaternion(q);
      root.position.copyFrom(centre.add(down));
    } else {
      root.rotationQuaternion = null;
      root.rotation.set(0, this.yaw, 0);
      root.position.copyFrom(this.body.feet());
    }
    const truth = animatorInput({ vx: v.x, vy: v.y, vz: v.z, grounded: frame.grounded }, frame.jumped, this.bridge, dt);
    this.blobbi.update(presentationInput(c, truth));
    const feet = this.body.feet();
    for (const ring of this.rings) ring.position.set(feet.x, feet.y + 0.02, feet.z);
    // Power shows as the ground ring: on from the first level, a little brighter and wider each level, with a flash on gain.
    this.powerFlash = Math.max(0, this.powerFlash - dt);
    const powered = this.powerLevel > 0;
    this.powerRing.setEnabled(powered);
    if (powered) {
      const k = Math.min(1, this.powerLevel / powerCap());
      const flash = this.powerFlash / 0.3;
      const size = 1 + 0.25 * k + 0.6 * flash;
      this.powerRing.position.set(feet.x, feet.y + 0.025, feet.z);
      this.powerRing.scaling.set(size, 1, size);
      this.powerRingMat.alpha = 0.35 + 0.45 * k + 0.2 * flash;
    }

    // Feedback the kit has no animation for yet, laid over its pose.
    const rig = this.blobbi.rig;
    const parts = this.blobbi.parts;
    let expression: ExpressionName = 'happy';
    if (isPunching(c)) {
      // The leading arm swings up and forward through the punch, then falls back.
      const u = Math.min(1, c.punchTime / (COMBAT.punchActive + COMBAT.punchRecovery));
      const swing = Math.sin(u * Math.PI);
      parts.rightArm.pivot.rotation.x = -1.9 * swing;
      parts.rightArm.pivot.rotation.z = 0.3 * swing;
      rig.body.rotation.x += 0.18 * swing;
      expression = 'upset';
    }
    if (this.squash > 0) {
      // A short squash on impact.
      this.squash = Math.max(0, this.squash - dt);
      const k = this.squash / COMBAT.hitSquash;
      rig.body.scaling.y *= 1 - 0.18 * k;
      rig.body.scaling.x *= 1 + 0.12 * k;
      rig.body.scaling.z *= 1 + 0.12 * k;
    }
    if (isTumbling(c)) {
      expression = 'surprised';
    } else if (isRecovering(c)) {
      // Dazed, pushing itself up.
      parts.leftArm.pivot.rotation.x = -0.9;
      parts.rightArm.pivot.rotation.x = -0.9;
      expression = 'sleepy';
    } else if (isStunned(c)) {
      rig.body.rotation.x -= 0.3;
      expression = 'surprised';
    } else if (c.held) {
      // Held up: arms out, feet dangling, a little back.
      parts.leftArm.pivot.rotation.z = 1.1;
      parts.rightArm.pivot.rotation.z = -1.1;
      parts.leftFoot.pivot.rotation.x = 0.5;
      parts.rightFoot.pivot.rotation.x = 0.5;
      rig.body.rotation.x -= 0.12;
      expression = 'sad';
    } else if (isHolding(c)) {
      parts.leftArm.pivot.rotation.x = -1.3;
      parts.rightArm.pivot.rotation.x = -1.3;
      expression = 'excited';
    }
    if (expression !== this.lastExpression) {
      this.lastExpression = expression;
      this.blobbi.setExpression(expression, 0.12);
    }
  }

  /** Advance the fall state; true on the frame the body crossed the fall line. */
  checkFall(dt: number): boolean {
    const before = this.fall.fallen;
    updateFall(this.fall, this.body.feet().y, dt);
    return !before && this.fall.fallen;
  }

  /** Back to the spawn, upright and at rest, with no transient state. */
  reset() {
    this.body.teleport(this.spawn);
    this.yaw = this.spawnYaw;
    this.fall = initialFallState();
    this.bridge = initialBridge();
    resetCombat(this.combat);
    this.squash = 0;
    this.powerLevel = 0;
    this.powerFlash = 0;
    this.lastImpact = 0;
    this.blobbi.animator.setState(null);
  }

  showDebug(on: boolean) {
    for (const ring of this.rings) ring.setEnabled(on);
  }

  dispose() {
    this.body.dispose();
    this.blobbi.dispose();
    for (const ring of this.rings) ring.dispose();
    this.powerRing.dispose();
    this.powerRingMat.dispose();
  }
}
