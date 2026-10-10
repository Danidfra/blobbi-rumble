/**
 * Hotfix: a carrier never runs, on the server, in the client's prediction
 * (which drives your own Blobbi's animation) or in what the client sends,
 * whether the run comes from Shift or from the touch stick's rim. Before,
 * the prediction let a carrier holding Shift reach the carry share of the
 * RUN speed (2.4 m/s): your Blobbi ran ahead of the server and played the
 * run animation, which nobody else saw. The run is back the moment the
 * hold ends.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { carrierGait, carrierIntent } from '../control/mover';
import { stickOutput } from '../control/stick';
import { NET_BINDINGS, moveIntent } from '../control/input';
import { RUMBLE_BODY } from '../profile';
import { loadHavokNode } from '../sim/havokNode';
import { createRumbleMatch } from '../sim/match';
import type { HavokInstance } from '../sim/physics';
import { COMBAT } from '../tuning';
import { advance, type Body } from './predict';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const CARRY_WALK = RUMBLE_BODY.walkSpeed * COMBAT.carrySpeed;
const start: Body = { x: 0, y: RUMBLE_BODY.capsuleCenterY, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
const speed = (b: Body) => Math.hypot(b.vx, b.vz);
/** Two seconds of prediction under `intent`. */
const predict = (intent: { x: number; z: number; run: boolean }, carrying: boolean) => {
  let b = start;
  let top = 0;
  for (let k = 0; k < 120; k++) {
    b = advance(b, { ...intent, jump: false, punch: false, grab: false }, 1 / 60, { powerLevel: 0, carrying }).body;
    top = Math.max(top, speed(b));
  }
  return { b, top };
};

describe('a carrier never runs', () => {
  it('the rule: no run request, and the run speed is the carry-slowed walk speed', () => {
    expect(carrierIntent({ x: 1, z: 0, run: true }, true).run).toBe(false);
    expect(carrierIntent({ x: 1, z: 0, run: true }, false).run).toBe(true);
    const p = carrierGait({ walkSpeed: 1.6, runSpeed: 3.2 }, true, 0.75);
    expect(p.runSpeed).toBeCloseTo(1.2, 9);
    expect(p.walkSpeed).toBeCloseTo(1.2, 9);
    expect(carrierGait({ walkSpeed: 1.6, runSpeed: 3.2 }, false, 0.75)).toEqual({ walkSpeed: 1.6, runSpeed: 3.2 });
  });

  it('predicted (your own Blobbi, its animation speed): Shift while carrying changes nothing, and stays at the carry walk', () => {
    const shift = predict({ x: 1, z: 0, run: true }, true);
    const plain = predict({ x: 1, z: 0, run: false }, true);
    expect(shift.b).toEqual(plain.b);
    expect(shift.top).toBeLessThanOrEqual(CARRY_WALK + 1e-6);
    // Below the walk speed, so the animator never blends toward its run.
    expect(shift.top).toBeLessThan(RUMBLE_BODY.walkSpeed);
  });

  it('the touch stick at its rim (its run) is the same as Shift: no run while carrying', () => {
    const rim = moveIntent(new Set(), 0, NET_BINDINGS, {}, stickOutput(60, 0, 60));
    expect(rim.run).toBe(true);
    const carried = predict(carrierIntent({ x: rim.x, z: rim.z, run: rim.run }, true), true);
    expect(carried.top).toBeLessThanOrEqual(CARRY_WALK + 1e-6);
  });

  it('the run is back the moment the hold ends', () => {
    let b = predict({ x: 1, z: 0, run: true }, true).b;
    let top = 0;
    for (let k = 0; k < 90; k++) {
      b = advance(b, { x: 1, z: 0, run: true, jump: false, punch: false, grab: false }, 1 / 60, { powerLevel: 0, carrying: false }).body;
      top = Math.max(top, speed(b));
    }
    expect(top).toBeGreaterThan(RUMBLE_BODY.walkSpeed + 0.5);
  });

  it('the server agrees: a carrier holding Shift walks at the carry speed, and runs again after the throw', () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    m.debugPlace('c', { x: -6, z: -2 });
    m.debugPlace('a', { x: 0, z: -2, yaw: 0 });
    m.debugPlace('b', { x: 0, z: -1.15, yaw: Math.PI });
    m.step(1 / 60);
    m.setInput('a', { grab: true });
    m.step(1 / 60);
    let top = 0;
    for (let k = 0; k < 90; k++) {
      m.setInput('a', { x: 1, z: 0, run: true });
      m.step(1 / 60);
      const a = m.snapshot().fighters[0];
      expect(a.holding).toBe('b');
      top = Math.max(top, Math.hypot(a.velocity.x, a.velocity.z));
    }
    expect(top).toBeLessThanOrEqual(CARRY_WALK + 0.15);
    m.setInput('a', { x: 1, z: 0, run: true, grab: true });
    m.step(1 / 60);
    top = 0;
    for (let k = 0; k < 90; k++) {
      m.setInput('a', { x: -1, z: 0, run: true });
      m.step(1 / 60);
      const a = m.snapshot().fighters[0];
      top = Math.max(top, Math.hypot(a.velocity.x, a.velocity.z));
    }
    expect(top).toBeGreaterThan(RUMBLE_BODY.walkSpeed + 0.5);
    m.dispose();
  });
});
