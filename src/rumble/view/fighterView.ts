/**
 * HOW A FIGHTER LOOKS: the visual Blobbi from `@blobbi-kit/3d`, carried to
 * where the match says the fighter's body is, with the game's own feedback
 * laid over the kit's animation (a swinging arm, a lean, a squash, a face),
 * the debug reach rings, the power ring and the name tag. Presentation
 * only: it reads a fighter's snapshot and the match's events and decides
 * nothing; nothing here feeds back into the match.
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Mesh as MeshClass } from '@babylonjs/core/Meshes/mesh';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { createBlobbi3D, type AnimatorInput, type Blobbi3D, type ExpressionName } from '@blobbi-kit/3d';
import { animatorInput, initialBridge, type BridgeState } from '../control/animationBridge';
import { RUMBLE_BODY } from '../profile';
import { powerCap } from '../pickups/power';
import { COMBAT } from '../tuning';
import { isHolding, isPunching, isRecovering, isStunned, isTumbling, type CombatState } from '../combat/combat';
import { combatOf } from '../sim/read';
import type { FighterSnapshot } from '../sim/snapshot';

export { combatOf };

/** What the kit's animator is told: the body's truth, unless the combat state says the body is not walking anywhere. */
export function presentationInput(c: CombatState, truth: AnimatorInput): AnimatorInput {
  if (c.held) return { ...truth, speed: 0, grounded: true, verticalVelocity: 0, jumped: false, landed: false };
  if (isTumbling(c)) return { ...truth, speed: 0, grounded: false, verticalVelocity: -1, jumped: false, landed: false };
  if (isRecovering(c)) return { ...truth, speed: 0, grounded: true, verticalVelocity: 0, jumped: false };
  return truth;
}

export class FighterView {
  readonly blobbi: Blobbi3D;
  private bridge: BridgeState = initialBridge();
  private lastExpression: ExpressionName = 'happy';
  private squash = 0;
  private powerFlash = 0;
  /** The struggle wiggle: a rock of the body to one side, decaying. */
  private wiggle = 0;
  private wiggleSide = 1;
  private debugOn = false;
  private hidden = false;
  private readonly rings: Mesh[] = [];
  private readonly powerRing: Mesh;
  private readonly powerRingMat: StandardMaterial;
  /** Who is who, among four: the label floating over the head, facing the camera. */
  private readonly tag: Mesh;
  private readonly tagMat: StandardMaterial;
  private readonly tagTex: DynamicTexture;
  private tagText = '';

  constructor(
    readonly id: string,
    readonly label: string,
    scene: Scene,
    seed: string,
    shadows?: ShadowGenerator,
  ) {
    this.blobbi = createBlobbi3D(seed, scene, { name: label, shadows });
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
    this.tag = MeshBuilder.CreatePlane(`${label}-tag`, { width: 1, height: 0.25 }, scene);
    this.tag.billboardMode = MeshClass.BILLBOARDMODE_ALL;
    this.tag.isPickable = false;
    this.tagTex = new DynamicTexture(`${label}-tag-tex`, { width: 256, height: 64 }, scene, true);
    this.tagTex.hasAlpha = true;
    this.setTag(label, true);
    this.tagMat = new StandardMaterial(`${label}-tag-mat`, scene);
    this.tagMat.diffuseTexture = this.tagTex;
    this.tagMat.emissiveColor = Color3.White();
    this.tagMat.disableLighting = true;
    this.tagMat.useAlphaFromDiffuseTexture = true;
    this.tagMat.backFaceCulling = false;
    this.tag.material = this.tagMat;
  }

  /**
   * The name tag's text: the slot label (monospace, as always) or a
   * person's name. Drawn as canvas text, never markup; redrawn only when it
   * changes. The caller keeps it short.
   */
  setTag(text: string, mono = false) {
    if (text === this.tagText) return;
    this.tagText = text;
    const ctx = this.tagTex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = mono ? 'bold 36px ui-monospace, Menlo, monospace' : 'bold 30px ui-sans-serif, system-ui, sans-serif';
    const w = Math.min(244, Math.max(72, ctx.measureText(text).width + 36));
    ctx.fillStyle = 'rgba(30,34,52,0.72)';
    ctx.beginPath();
    ctx.roundRect(128 - w / 2, 6, w, 52, 18);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 34, 220);
    this.tagTex.update();
  }

  /** A blow or a throw landed on this fighter: the short squash. */
  struck() {
    this.squash = COMBAT.hitSquash;
  }

  /** A struggle stroke counted (the server's progress went up): the held body rocks, the other way each time. */
  struggled() {
    this.wiggleSide = -this.wiggleSide;
    this.wiggle = 1;
  }

  /** An orb taken: the power ring flashes. */
  powered() {
    this.powerFlash = 0.3;
  }

  /** A new round: no transient look left over. */
  reset() {
    this.bridge = initialBridge();
    this.squash = 0;
    this.powerFlash = 0;
    this.wiggle = 0;
    this.blobbi.animator.setState(null);
  }

  showDebug(on: boolean) {
    this.debugOn = on;
    for (const ring of this.rings) ring.setEnabled(on && !this.hidden);
  }

  /** Draw the fighter as the snapshot has it. `jumped`: the match reported its jump this step. */
  apply(f: FighterSnapshot, dt: number, jumped: boolean) {
    // Out of the round: hidden until the next.
    const hidden = f.eliminated;
    if (hidden !== this.hidden) {
      this.hidden = hidden;
      this.blobbi.rig.root.setEnabled(!hidden);
      this.tag.setEnabled(!hidden);
      for (const ring of this.rings) ring.setEnabled(this.debugOn && !hidden);
      if (hidden) this.powerRing.setEnabled(false);
    }
    if (hidden) return;
    const c = combatOf(f);
    const v = f.velocity;
    const root = this.blobbi.rig.root;
    const centre = new Vector3(f.position.x, f.position.y, f.position.z);
    const feet = new Vector3(f.position.x, f.position.y - RUMBLE_BODY.capsuleCenterY, f.position.z);
    if (!f.upright) {
      // The whole Blobbi turns with its capsule, about the capsule's centre.
      const q = new Quaternion(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
      if (!root.rotationQuaternion) root.rotationQuaternion = new Quaternion();
      Quaternion.RotationYawPitchRollToRef(f.yaw, 0, 0, root.rotationQuaternion);
      q.multiplyToRef(root.rotationQuaternion, root.rotationQuaternion);
      const down = new Vector3(0, -RUMBLE_BODY.capsuleCenterY, 0).applyRotationQuaternion(q);
      root.position.copyFrom(centre.add(down));
    } else {
      root.rotationQuaternion = null;
      root.rotation.set(0, f.yaw, 0);
      root.position.copyFrom(feet);
    }
    const truth = animatorInput({ vx: v.x, vy: v.y, vz: v.z, grounded: f.grounded }, jumped, this.bridge, dt);
    this.blobbi.update(presentationInput(c, truth));
    for (const ring of this.rings) ring.position.set(feet.x, feet.y + 0.02, feet.z);
    this.tag.position.set(centre.x, centre.y + 1.0, centre.z);
    // Power shows as the ground ring: on from the first level, a little brighter and wider each level, with a flash on gain.
    this.powerFlash = Math.max(0, this.powerFlash - dt);
    const powered = f.powerLevel > 0;
    this.powerRing.setEnabled(powered);
    if (powered) {
      const k = Math.min(1, f.powerLevel / powerCap());
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
      // Held up: arms out, feet dangling, a little back; struggling, it rocks side to side and kicks, more as it nears free.
      this.wiggle = Math.max(0, this.wiggle - dt * 6);
      const rock = this.wiggleSide * Math.sin(this.wiggle * Math.PI) * (0.18 + 0.12 * c.struggle);
      parts.leftArm.pivot.rotation.z = 1.1 + rock;
      parts.rightArm.pivot.rotation.z = -1.1 + rock;
      parts.leftFoot.pivot.rotation.x = 0.5 + rock;
      parts.rightFoot.pivot.rotation.x = 0.5 - rock;
      rig.body.rotation.x -= 0.12;
      rig.body.rotation.z += rock;
      expression = c.struggle > 0 ? 'upset' : 'sad';
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

  dispose() {
    this.blobbi.dispose();
    for (const ring of this.rings) ring.dispose();
    this.powerRing.dispose();
    this.powerRingMat.dispose();
    this.tag.dispose();
    this.tagMat.dispose();
    this.tagTex.dispose();
  }
}
