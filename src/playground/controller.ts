/**
 * A minimal character controller for judging how the Blobbi feels to
 * move: WASD / arrows to walk (hold Shift to run), Space to jump. Gravity
 * and a flat floor at y = 0, nothing more. The controller moves a
 * NORMALIZED body (the gameplay profile's capsule, the same for every
 * identity), and the visual Blobbi follows it; the visual morphology never
 * feeds back into movement.
 *
 * This is a stand-in for a physics engine (Havok), kept trivially simple so
 * that the character, not the physics, is what gets judged.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { BLOBBI_GAMEPLAY_PROFILE } from '@blobbi-kit/3d';

export interface ControllerState {
  position: Vector3;
  velocity: Vector3;
  /** Facing, radians about Y. */
  yaw: number;
  grounded: boolean;
  /** Frame flags for the animator. */
  jumped: boolean;
  landed: boolean;
  impact: number;
  speed: number;
}

const GRAVITY = -14;

export class CharacterController {
  readonly state: ControllerState = { position: new Vector3(0, 0, 0), velocity: new Vector3(), yaw: 0, grounded: true, jumped: false, landed: false, impact: 0, speed: 0 };
  private keys = new Set<string>();
  private jumpQueued = false;
  enabled = true;

  constructor(target: HTMLElement | Window = window) {
    target.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if ((ev.target as HTMLElement | null)?.tagName === 'INPUT' || (ev.target as HTMLElement | null)?.tagName === 'SELECT') return;
      this.keys.add(ev.code);
      if (ev.code === 'Space') {
        this.jumpQueued = true;
        ev.preventDefault();
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.code)) ev.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Camera-relative move axes: forward is away from the camera. */
  private axes(cameraYaw: number): { x: number; z: number; run: boolean } {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    const c = Math.cos(cameraYaw);
    const s = Math.sin(cameraYaw);
    return { x: x * c + z * s, z: -x * s + z * c, run: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') };
  }

  update(dt: number, cameraYaw: number) {
    const st = this.state;
    const p = BLOBBI_GAMEPLAY_PROFILE;
    st.jumped = false;
    st.landed = false;
    const input = this.enabled ? this.axes(cameraYaw) : { x: 0, z: 0, run: false };
    const wanted = input.run ? p.runSpeed : p.walkSpeed;
    const targetVx = input.x * wanted;
    const targetVz = input.z * wanted;
    // Quick acceleration on the ground, floaty in the air.
    const accel = st.grounded ? 18 : 6;
    const k = 1 - Math.exp(-dt * accel);
    st.velocity.x += (targetVx - st.velocity.x) * k;
    st.velocity.z += (targetVz - st.velocity.z) * k;

    if (this.jumpQueued) {
      this.jumpQueued = false;
      if (st.grounded && this.enabled) {
        st.velocity.y = p.jumpSpeed;
        st.grounded = false;
        st.jumped = true;
      }
    }
    if (!st.grounded) st.velocity.y += GRAVITY * dt;

    st.position.addInPlace(st.velocity.scale(dt));
    if (st.position.y <= 0 && st.velocity.y <= 0) {
      if (!st.grounded) {
        st.landed = true;
        st.impact = -st.velocity.y;
      }
      st.position.y = 0;
      st.velocity.y = 0;
      st.grounded = true;
    }
    // Keep inside the playground.
    const limit = 12;
    st.position.x = Math.max(-limit, Math.min(limit, st.position.x));
    st.position.z = Math.max(-limit, Math.min(limit, st.position.z));

    st.speed = Math.hypot(st.velocity.x, st.velocity.z);
    if (st.speed > 0.15) {
      const target = Math.atan2(st.velocity.x, st.velocity.z);
      let d = target - st.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      st.yaw += d * (1 - Math.exp(-dt * 12));
    }
  }
}
