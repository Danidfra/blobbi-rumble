/**
 * PHYSICS STATE TO ANIMATOR INPUT: the kit's animator takes speed, ground
 * contact, vertical velocity and the landing/jump edges; this derives them
 * from what the body reports, frame to frame. Pure.
 */
import type { AnimatorInput } from '@blobbi-kit/3d';

export interface BodySample {
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

export interface BridgeState {
  wasGrounded: boolean;
  lastVy: number;
}

export const initialBridge = (): BridgeState => ({ wasGrounded: true, lastVy: 0 });

export function animatorInput(sample: BodySample, jumped: boolean, state: BridgeState, dt: number): AnimatorInput {
  const landed = sample.grounded && !state.wasGrounded && !jumped;
  const impact = landed ? Math.max(0, -state.lastVy) : 0;
  const input: AnimatorInput = { dt, speed: Math.hypot(sample.vx, sample.vz), grounded: sample.grounded, verticalVelocity: sample.vy, jumped, landed, impact };
  state.wasGrounded = sample.grounded;
  state.lastVy = sample.vy;
  return input;
}

/** The facing a moving character turns toward: along its horizontal velocity, once it is really moving. */
export function facingYaw(vx: number, vz: number, current: number, dt: number, turnRate = 12): number {
  if (Math.hypot(vx, vz) < 0.15) return current;
  const target = Math.atan2(vx, vz);
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return current + d * (1 - Math.exp(-dt * turnRate));
}
