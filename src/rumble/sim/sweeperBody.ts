/**
 * THE SWEEPER'S BODY: a post at the pivot and a bar that Havok moves as an
 * animated body, so it shoves what it meets with its own velocity, and the
 * fighters' capsules stand on it or are pushed by it like by any solid
 * thing. Each step the bar is set to the pure state's angle. The blow a
 * hit deals is the pure sweeper's (`arena/sweeper.ts`); this is the thing
 * that is there. How it looks is the client's (`view/sweeperView.ts`).
 */
import { PhysicsAggregate } from '@babylonjs/core/Physics/v2/physicsAggregate';
import { PhysicsMotionType, PhysicsShapeType } from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import { LAYER } from '../profile';
import { SWEEPER } from '../tuning';
import type { SweeperState, SweeperTuning } from '../arena/sweeper';

/** The post's size, metres: a cylinder at the pivot. */
export const SWEEPER_POST = Object.freeze({ diameter: SWEEPER.postRadius * 2, height: 0.9 });

export class SweeperBody {
  readonly bar: Mesh;
  private readonly post: Mesh;
  private readonly aggregate: PhysicsAggregate;
  private readonly postAggregate: PhysicsAggregate;
  private readonly pivotPosition: Vector3;
  private readonly plugin: HavokPlugin;
  private readonly orientation = new Quaternion();

  constructor(scene: Scene, t: SweeperTuning = SWEEPER) {
    this.plugin = scene.getPhysicsEngine()!.getPhysicsPlugin() as HavokPlugin;
    this.bar = MeshBuilder.CreateBox('sweeper-bar', { width: t.reach * 2, height: t.top, depth: t.halfWidth * 2 }, scene);
    this.bar.position.set(t.pivot.x, t.top / 2, t.pivot.z);
    this.bar.isVisible = false;
    // Animated: each step Havok is told where the bar must be next, and moves it there with the matching velocity.
    this.aggregate = new PhysicsAggregate(this.bar, PhysicsShapeType.BOX, { mass: 0, friction: 0.4, restitution: 0 }, scene);
    this.aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);
    this.aggregate.body.disablePreStep = true;
    this.aggregate.shape.filterMembershipMask = LAYER.ground;
    this.aggregate.shape.filterCollideMask = LAYER.character;
    this.pivotPosition = new Vector3(t.pivot.x, t.top / 2, t.pivot.z);

    this.post = MeshBuilder.CreateCylinder('sweeper-post', { diameter: SWEEPER_POST.diameter, height: SWEEPER_POST.height, tessellation: 24 }, scene);
    this.post.position.set(t.pivot.x, SWEEPER_POST.height / 2, t.pivot.z);
    this.post.isVisible = false;
    this.postAggregate = new PhysicsAggregate(this.post, PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.4, restitution: 0 }, scene);
    this.postAggregate.shape.filterMembershipMask = LAYER.ground;
    this.postAggregate.shape.filterCollideMask = LAYER.character;
  }

  /**
   * Ask Havok to bring the bar to the state's angle by the next step (so
   * contacts feel its velocity). A large jump (a reset) is a teleport
   * instead: moved as a sweep it would fling whatever stood in the way
   * across the arena.
   */
  apply(s: SweeperState) {
    Quaternion.RotationYawPitchRollToRef(s.angle, 0, 0, this.orientation);
    if (!this.bar.rotationQuaternion) this.bar.rotationQuaternion = new Quaternion();
    const current = this.bar.rotationQuaternion.toEulerAngles().y;
    const jump = Math.abs(Math.atan2(Math.sin(s.angle - current), Math.cos(s.angle - current)));
    this.bar.rotationQuaternion.copyFrom(this.orientation);
    if (jump > 0.25) {
      // A teleport needs the TELEPORT prestep for this one call: with the prestep disabled (as the animated bar otherwise
      // keeps it) Babylon only warns and ignores it, and up to M6 the bar then swung back to its start in a single step.
      const body = this.aggregate.body;
      body.setAngularVelocity(Vector3.Zero());
      body.setLinearVelocity(Vector3.Zero());
      body.disablePreStep = false;
      this.plugin.setPhysicsBodyTransformation(body, this.bar);
      body.disablePreStep = true;
      return;
    }
    this.aggregate.body.setTargetTransform(this.pivotPosition, this.orientation);
  }

  dispose() {
    this.aggregate.dispose();
    this.postAggregate.dispose();
    this.bar.dispose();
    this.post.dispose();
  }
}
