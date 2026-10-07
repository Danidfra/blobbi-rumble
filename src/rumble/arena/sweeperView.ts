/**
 * THE SWEEPER IN THE SCENE: a post at the pivot and a bar that Havok moves
 * as an animated body, so it shoves what it meets with its own velocity,
 * and the fighters' capsules stand on it or are pushed by it like by any
 * solid thing. Each frame the bar is set to the pure state's angle and
 * given the matching angular velocity. The blow a hit deals is the pure
 * sweeper's; this is the thing that is there.
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsMotionType, PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import type { Scene } from '@babylonjs/core/scene';
import type { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import { LAYER } from '../profile';
import { SWEEPER } from '../tuning';
import type { SweeperState } from './sweeper';

export class SweeperView {
  readonly bar: Mesh;
  readonly post: Mesh;
  private readonly aggregate: PhysicsAggregate;
  private readonly postAggregate: PhysicsAggregate;
  private readonly reachRing: Mesh;
  private readonly mats: StandardMaterial[] = [];
  private readonly pivotPosition: Vector3;
  private readonly plugin: HavokPlugin;
  private readonly orientation = new Quaternion();

  constructor(scene: Scene, shadows?: ShadowGenerator) {
    const t = SWEEPER;
    this.plugin = scene.getPhysicsEngine()!.getPhysicsPlugin() as HavokPlugin;
    const barMat = new StandardMaterial('sweeper-bar-mat', scene);
    barMat.diffuseColor = Color3.FromHexString('#c9553f');
    barMat.specularColor = new Color3(0.3, 0.3, 0.3);
    const postMat = new StandardMaterial('sweeper-post-mat', scene);
    postMat.diffuseColor = Color3.FromHexString('#5a5f73');
    this.mats.push(barMat, postMat);

    this.bar = MeshBuilder.CreateBox('sweeper-bar', { width: t.reach * 2, height: t.top, depth: t.halfWidth * 2 }, scene);
    this.bar.position.set(t.pivot.x, t.top / 2, t.pivot.z);
    this.bar.material = barMat;
    this.bar.isPickable = false;
    shadows?.addShadowCaster(this.bar);
    // Animated: each frame Havok is told where the bar must be next, and moves it there with the matching velocity.
    this.aggregate = new PhysicsAggregate(this.bar, PhysicsShapeType.BOX, { mass: 0, friction: 0.4, restitution: 0 }, scene);
    this.aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);
    this.aggregate.body.disablePreStep = true;
    this.aggregate.shape.filterMembershipMask = LAYER.ground;
    this.aggregate.shape.filterCollideMask = LAYER.character;
    this.pivotPosition = new Vector3(t.pivot.x, t.top / 2, t.pivot.z);

    this.post = MeshBuilder.CreateCylinder('sweeper-post', { diameter: 0.5, height: 0.9, tessellation: 24 }, scene);
    this.post.position.set(t.pivot.x, 0.45, t.pivot.z);
    this.post.material = postMat;
    this.post.isPickable = false;
    shadows?.addShadowCaster(this.post);
    this.postAggregate = new PhysicsAggregate(this.post, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.4, restitution: 0 }, scene);
    this.postAggregate.shape.filterMembershipMask = LAYER.ground;
    this.postAggregate.shape.filterCollideMask = LAYER.character;

    this.reachRing = MeshBuilder.CreateTorus('sweeper-reach', { diameter: t.reach * 2, thickness: 0.03, tessellation: 64 }, scene);
    this.reachRing.position.set(t.pivot.x, t.top + 0.02, t.pivot.z);
    const ringMat = new StandardMaterial('sweeper-reach-mat', scene);
    ringMat.emissiveColor = Color3.FromHexString('#ff6a4d');
    ringMat.disableLighting = true;
    this.reachRing.material = ringMat;
    this.reachRing.isPickable = false;
    this.reachRing.setEnabled(false);
    this.mats.push(ringMat);
  }

  /**
   * Ask Havok to bring the bar to the state's angle by the next step (so
   * contacts feel its velocity), and show it there now. A large jump (a
   * reset) is a teleport instead: moved as a sweep it would fling whatever
   * stood in the way across the arena.
   */
  apply(s: SweeperState) {
    Quaternion.RotationYawPitchRollToRef(s.angle, 0, 0, this.orientation);
    if (!this.bar.rotationQuaternion) this.bar.rotationQuaternion = new Quaternion();
    const current = this.bar.rotationQuaternion.toEulerAngles().y;
    const jump = Math.abs(Math.atan2(Math.sin(s.angle - current), Math.cos(s.angle - current)));
    this.bar.rotationQuaternion.copyFrom(this.orientation);
    if (jump > 0.25) {
      // Teleport: put the body where the mesh is, with no velocity.
      this.aggregate.body.setAngularVelocity(Vector3.Zero());
      this.aggregate.body.setLinearVelocity(Vector3.Zero());
      this.plugin.setPhysicsBodyTransformation(this.aggregate.body, this.bar);
      return;
    }
    this.aggregate.body.setTargetTransform(this.pivotPosition, this.orientation);
  }

  showDebug(on: boolean) {
    this.reachRing.setEnabled(on);
  }

  dispose() {
    this.aggregate.dispose();
    this.postAggregate.dispose();
    this.bar.dispose();
    this.post.dispose();
    this.reachRing.dispose();
    for (const m of this.mats) m.dispose();
  }
}
