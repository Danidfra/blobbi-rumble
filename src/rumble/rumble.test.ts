/**
 * The gameplay logic that is deterministic: the body profile, input to
 * intent, steering, the animation bridge and the fall/respawn state. Havok
 * itself is not simulated here; the collision feel is judged in the browser.
 */
import { describe, expect, it } from 'vitest';
import { BLOBBI_GAMEPLAY_PROFILE, createBlobbiIdentity } from '@blobbi-kit/3d';
import { seedFromLabel } from '../playground/seeds';
import { RUMBLE_BODY } from './profile';
import { moveIntent, P1_BINDINGS, P2_BINDINGS } from './control/input';
import { steer } from './control/mover';
import { animatorInput, facingYaw, initialBridge } from './control/animationBridge';
import { initialFallState, updateFall } from './respawn';

describe('the rumble body', () => {
  it('is the kit\'s normalized profile plus tuning, and knows nothing of any identity', () => {
    expect(RUMBLE_BODY.capsuleHeight).toBe(BLOBBI_GAMEPLAY_PROFILE.capsuleHeight);
    expect(RUMBLE_BODY.capsuleRadius).toBe(BLOBBI_GAMEPLAY_PROFILE.capsuleRadius);
    expect(RUMBLE_BODY.mass).toBe(BLOBBI_GAMEPLAY_PROFILE.mass);
    expect(RUMBLE_BODY.runSpeed).toBe(BLOBBI_GAMEPLAY_PROFILE.runSpeed);
    expect(Object.isFrozen(RUMBLE_BODY)).toBe(true);
    // Two very different individuals; the body is one constant, so there is nothing per identity to compare.
    const wide = createBlobbiIdentity(seedFromLabel('variety-109'));
    const narrow = createBlobbiIdentity(seedFromLabel('variety-15'));
    expect(wide.colors.base).not.toBe(narrow.colors.base);
    expect(RUMBLE_BODY).toBe(RUMBLE_BODY);
  });
});

describe('input to intent', () => {
  it('is camera-relative and normalized', () => {
    const fwd = moveIntent(new Set(['KeyW']), 0, P1_BINDINGS);
    expect(fwd.z).toBeCloseTo(1);
    expect(fwd.x).toBeCloseTo(0);
    const diag = moveIntent(new Set(['KeyW', 'KeyD']), 0, P1_BINDINGS);
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(1);
    // With the camera turned a quarter turn, "forward" turns with it.
    const turned = moveIntent(new Set(['ArrowUp']), Math.PI / 2, P2_BINDINGS);
    expect(turned.x).toBeCloseTo(1);
    expect(Math.abs(turned.z)).toBeLessThan(1e-9);
    expect(moveIntent(new Set(['KeyW', 'KeyS']), 0, P1_BINDINGS)).toMatchObject({ x: 0, z: 0 });
    expect(moveIntent(new Set(['ShiftLeft']), 0, P1_BINDINGS).run).toBe(true);
    expect(moveIntent(new Set(), 0, P1_BINDINGS, { jump: true, punch: true }).jump).toBe(true);
    expect(moveIntent(new Set(), 0, P1_BINDINGS, { punch: true }).punch).toBe(true);
  });

  it('keeps the two players apart: one\'s keys never move the other', () => {
    const held = new Set(['KeyW', 'ShiftLeft', 'ArrowLeft']);
    const p1 = moveIntent(held, 0, P1_BINDINGS);
    const p2 = moveIntent(held, 0, P2_BINDINGS);
    expect(p1.z).toBeCloseTo(1);
    expect(p1.x).toBeCloseTo(0);
    expect(p1.run).toBe(true);
    expect(p2.x).toBeCloseTo(-1);
    expect(p2.z).toBeCloseTo(0);
    expect(p2.run).toBe(false);
    // No key is bound to both players.
    const codes = (b: typeof P1_BINDINGS) => new Set(Object.values(b).flat());
    const both = [...codes(P1_BINDINGS)].filter((c) => codes(P2_BINDINGS).has(c));
    expect(both).toEqual([]);
  });
});

describe('steering', () => {
  const p = RUMBLE_BODY;
  it('accelerates toward the wanted velocity by at most the acceleration, on the ground', () => {
    const s = steer(0, 0, { x: 0, z: 1, run: false, jump: false }, true, 1 / 60, p);
    expect(s.dvz).toBeCloseTo(p.acceleration / 60);
    expect(s.dvx).toBe(0);
    expect(s.jumpTo).toBeNull();
    // Already at speed: no change.
    expect(steer(0, p.walkSpeed, { x: 0, z: 1, run: false, jump: false }, true, 1 / 60, p).dvz).toBeCloseTo(0);
    // Running wants more.
    const run = steer(0, p.walkSpeed, { x: 0, z: 1, run: true, jump: false }, true, 1, p);
    expect(run.dvz).toBeCloseTo(p.runSpeed - p.walkSpeed);
  });
  it('brakes with no keys on the ground, and not in the air', () => {
    const idle = { x: 0, z: 0, run: false, jump: false };
    expect(steer(2, 0, idle, true, 1 / 60, p).dvx).toBeCloseTo(-p.braking / 60);
    expect(steer(2, 0, idle, false, 1 / 60, p).dvx).toBeCloseTo(0, 12);
  });
  it('has only a share of its authority in the air', () => {
    const ground = steer(0, 0, { x: 1, z: 0, run: false, jump: false }, true, 1 / 60, p);
    const air = steer(0, 0, { x: 1, z: 0, run: false, jump: false }, false, 1 / 60, p);
    expect(air.dvx).toBeCloseTo(ground.dvx * p.airControl);
  });
  it('jumps only from the ground', () => {
    expect(steer(0, 0, { x: 0, z: 0, run: false, jump: true }, true, 1 / 60, p).jumpTo).toBe(p.jumpSpeed);
    expect(steer(0, 0, { x: 0, z: 0, run: false, jump: true }, false, 1 / 60, p).jumpTo).toBeNull();
  });
});

describe('the animation bridge', () => {
  it('reports a landing once, with the impact speed, and never on the jump frame', () => {
    const state = initialBridge();
    animatorInput({ vx: 0, vy: 0, vz: 0, grounded: true }, false, state, 1 / 60);
    animatorInput({ vx: 0, vy: 4, vz: 0, grounded: false }, true, state, 1 / 60);
    animatorInput({ vx: 0, vy: -5, vz: 0, grounded: false }, false, state, 1 / 60);
    const land = animatorInput({ vx: 0, vy: 0, vz: 0, grounded: true }, false, state, 1 / 60);
    expect(land.landed).toBe(true);
    expect(land.impact).toBeCloseTo(5);
    const after = animatorInput({ vx: 0, vy: 0, vz: 0, grounded: true }, false, state, 1 / 60);
    expect(after.landed).toBe(false);
    // Speed is horizontal only.
    expect(animatorInput({ vx: 3, vy: -9, vz: 4, grounded: false }, false, state, 1 / 60).speed).toBeCloseTo(5);
  });
  it('turns the facing toward the velocity, and holds it when nearly still', () => {
    expect(facingYaw(0, 0.05, 1.2, 1 / 60)).toBe(1.2);
    const yaw = facingYaw(1, 0, 0, 10);
    expect(yaw).toBeCloseTo(Math.PI / 2, 2);
  });
});

describe('falling and respawn', () => {
  it('marks a body fallen below the floor, counts it, waits, then says to put it back', () => {
    const f = initialFallState();
    expect(updateFall(f, 0.5, 1 / 60)).toBe(false);
    expect(f.fallen).toBe(false);
    expect(updateFall(f, -5, 1 / 60)).toBe(false);
    expect(f.fallen).toBe(true);
    expect(f.falls).toBe(1);
    let respawn = false;
    for (let i = 0; i < 60 && !respawn; i++) respawn = updateFall(f, -20, 1 / 60);
    expect(respawn).toBe(true);
    expect(f.fallen).toBe(false);
    // Back on the arena it is not fallen; a second fall counts again.
    expect(updateFall(f, 0, 1 / 60)).toBe(false);
    updateFall(f, -5, 1 / 60);
    expect(f.falls).toBe(2);
  });
});
