/**
 * THE PLAYER CONTROLLER: input and a gameplay body, nothing visual. Each
 * frame it reads the intent, asks the steering for a bounded velocity
 * change, and applies it to the Havok body as an impulse; a jump sets the
 * vertical velocity. It reports the frame's state for the animation bridge.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { GameplayBody } from '../physics/body';
import { RUMBLE_BODY, type RumbleBody } from '../profile';
import type { KeyboardInput } from './input';
import { steer } from './mover';

export interface ControllerFrame {
  grounded: boolean;
  jumped: boolean;
  velocity: Vector3;
}

export class PlayerController {
  constructor(
    private readonly body: GameplayBody,
    private readonly input: KeyboardInput,
    private readonly profile: RumbleBody = RUMBLE_BODY,
  ) {}

  update(dt: number, cameraYaw: number): ControllerFrame {
    const intent = this.input.read(cameraYaw);
    const grounded = this.body.grounded();
    const v = this.body.velocity();
    const s = steer(v.x, v.z, intent, grounded, dt, this.profile);
    const b = this.body.body;
    if (s.dvx !== 0 || s.dvz !== 0) b.applyImpulse(new Vector3(s.dvx * this.profile.mass, 0, s.dvz * this.profile.mass), this.body.position());
    let jumped = false;
    if (s.jumpTo !== null) {
      b.setLinearVelocity(new Vector3(v.x + s.dvx, s.jumpTo, v.z + s.dvz));
      jumped = true;
    }
    return { grounded, jumped, velocity: v };
  }
}
