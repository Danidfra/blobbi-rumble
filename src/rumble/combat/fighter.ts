/**
 * A FIGHTER: one player, the same class for both. A gameplay body owned by
 * Havok, an input, a combat state, a fall state, and the visual Blobbi
 * that follows the body. Everything either player can do is here, once.
 *
 * Each frame: read the intent (scaled by how much control the combat
 * state leaves), steer the body by a bounded impulse, start a punch or a
 * grab on request, then carry the visual Blobbi to the body and lay the
 * game's own feedback (a swinging arm, a lean, a face) over the kit's
 * animation. The kit knows nothing of any of this.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { createBlobbi3D, type Blobbi3D, type ExpressionName } from '@blobbi-kit/3d';
import { animatorInput, facingYaw, initialBridge, type BridgeState } from '../control/animationBridge';
import type { MoveIntent, PlayerInput } from '../control/input';
import { steer } from '../control/mover';
import { createGameplayBody, type GameplayBody } from '../physics/body';
import { RUMBLE_BODY, type RumbleBody } from '../profile';
import { initialFallState, updateFall, type FallState } from '../respawn';
import { COMBAT } from '../tuning';
import { controlFactor, createCombatState, isHolding, isPunching, isStunned, resetCombat, tryPunch, type CombatState, type Knock, type Planar } from './combat';

export interface FighterFrame {
  grounded: boolean;
  jumped: boolean;
  intent: MoveIntent;
}

export class Fighter {
  readonly blobbi: Blobbi3D;
  readonly body: GameplayBody;
  readonly combat: CombatState = createCombatState();
  fall: FallState = initialFallState();
  bridge: BridgeState = initialBridge();
  yaw: number;
  private lastExpression: ExpressionName = 'happy';
  private readonly rings: Mesh[] = [];

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
  }

  /** Capsule centre and facing in the ground plane. */
  at(): Planar {
    const p = this.body.position();
    return { x: p.x, z: p.z };
  }
  facing(): Planar {
    return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
  }
  velocity(): Planar {
    const v = this.body.velocity();
    return { x: v.x, z: v.z };
  }

  /** Steer by intent, within the control the combat state allows. Returns what happened, for combat and animation. */
  update(dt: number, cameraYaw: number): FighterFrame {
    const intent = this.input.read(cameraYaw);
    const control = controlFactor(this.combat);
    const grounded = this.body.grounded();
    const v = this.body.velocity();
    // Reduced control: the same steering with that much of its authority, and no jump.
    const scaled: RumbleBody = control < 1 ? { ...this.profile, acceleration: this.profile.acceleration * control, braking: this.profile.braking * control } : this.profile;
    const s = steer(v.x, v.z, { ...intent, jump: intent.jump && control >= 1 }, grounded, dt, scaled);
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

  /** A velocity change from a blow, a pull or a throw. */
  knock(k: Knock | Planar) {
    const dvy = 'dvy' in k ? k.dvy : 0;
    const dvx = 'dvx' in k ? k.dvx : k.x;
    const dvz = 'dvz' in k ? k.dvz : k.z;
    this.body.body.applyImpulse(new Vector3(dvx * this.profile.mass, dvy * this.profile.mass, dvz * this.profile.mass), this.body.position());
  }

  /** Carry the visual Blobbi to the body and lay the game's feedback over the kit's animation. */
  follow(dt: number, frame: FighterFrame) {
    const v = this.body.velocity();
    // A stunned or held body keeps its facing: it is not walking anywhere.
    if (!isStunned(this.combat) && !this.combat.held) this.yaw = facingYaw(v.x, v.z, this.yaw, dt);
    const feet = this.body.feet();
    const root = this.blobbi.rig.root;
    root.position.copyFrom(feet);
    root.rotation.y = this.yaw;
    this.blobbi.update(animatorInput({ vx: v.x, vy: v.y, vz: v.z, grounded: frame.grounded }, frame.jumped, this.bridge, dt));
    for (const ring of this.rings) ring.position.set(feet.x, feet.y + 0.02, feet.z);

    // Feedback the kit has no animation for yet, laid over its pose.
    const rig = this.blobbi.rig;
    const c = this.combat;
    let expression: ExpressionName = 'happy';
    if (isPunching(c)) {
      // The leading arm swings up and forward through the punch, then falls back.
      const u = Math.min(1, c.punchTime / (COMBAT.punchActive + COMBAT.punchRecovery));
      const swing = Math.sin(u * Math.PI);
      this.blobbi.parts.rightArm.pivot.rotation.x = -1.9 * swing;
      this.blobbi.parts.rightArm.pivot.rotation.z = 0.3 * swing;
      rig.body.rotation.x += 0.18 * swing;
      expression = 'upset';
    }
    if (isStunned(c)) {
      rig.body.rotation.x -= 0.3;
      expression = 'surprised';
    } else if (c.held) {
      rig.body.rotation.x -= 0.12;
      expression = 'sad';
    } else if (isHolding(c)) {
      this.blobbi.parts.leftArm.pivot.rotation.x = -1.3;
      this.blobbi.parts.rightArm.pivot.rotation.x = -1.3;
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

  /** Back to the spawn, at rest, with no transient state. */
  reset() {
    this.body.teleport(this.spawn);
    this.yaw = this.spawnYaw;
    this.fall = initialFallState();
    this.bridge = initialBridge();
    resetCombat(this.combat);
    this.blobbi.animator.setState(null);
  }

  showDebug(on: boolean) {
    for (const ring of this.rings) ring.setEnabled(on);
  }

  dispose() {
    this.body.dispose();
    this.blobbi.dispose();
    for (const ring of this.rings) ring.dispose();
  }
}
