/**
 * M11.1: the grab, the carry, the struggle and the throw as a balanced
 * exchange: a carrier walks (never runs) and is slowed by a struggling
 * load, a hold ends by itself, a grabbed fighter escapes under normal
 * conditions before a walking carrier reaches the rim of the classic
 * centre, a thrown body cannot be grabbed again at once, and the inputs
 * that struggle register over the host's input path.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC } from '../arena/arenas';
import { RUMBLE_BODY } from '../profile';
import { RumbleHost } from '../net/host';
import { COMBAT, STRUGGLE } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
const DT = 1 / 60;
const four = () => createRumbleMatch({ havok, players: ['a', 'b', 'c', 'd'].map((id) => ({ id })), arena: CLASSIC });
const steps = (m: RumbleMatch, n: number) => {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...m.step(DT));
  return events;
};
const secs = (m: RumbleMatch, s: number) => steps(m, Math.ceil(s / DT));
const f = (m: RumbleMatch, id: string) => m.snapshot().fighters.find((x) => x.id === id)!;
/** 'a' at `at` facing +x grabs 'b' just ahead; 'c' and 'd' stand clear. */
const grab = (m: RumbleMatch, at = { x: 0, z: 0 }) => {
  for (const id of m.ids) m.setInput(id, { x: 0, z: 0 });
  m.debugPlace('c', { x: -3, z: -3 });
  m.debugPlace('d', { x: 3, z: -3 });
  m.debugPlace('a', { x: at.x, z: at.z, yaw: Math.PI / 2 });
  m.debugPlace('b', { x: at.x + 0.8, z: at.z, yaw: -Math.PI / 2 });
  steps(m, 5);
  m.setInput('a', { grab: true });
  steps(m, 3);
  expect(f(m, 'b').heldBy).toBe('a');
};
/** Struggle at `rate` strokes a second until free or `maxSeconds`; returns when, or -1. */
const struggle = (m: RumbleMatch, id: string, rate: number, maxSeconds: number, onStep?: () => void) => {
  let side = 1;
  let next = 0;
  for (let i = 0; i < Math.ceil(maxSeconds / DT); i++) {
    const t = i / 60;
    if (t >= next) {
      side = -side;
      next += 1 / rate;
      m.setInput(id, { x: side, z: 0 });
    }
    onStep?.();
    m.step(DT);
    if (!f(m, id).heldBy) return t;
  }
  return -1;
};

describe('the carry (M11.1)', () => {
  it('a carrier walks, never runs: with the run key held it moves no faster than its carrying walk', () => {
    const m = four();
    grab(m);
    m.setInput('a', { x: 1, z: 0, run: true });
    secs(m, 1);
    const v = f(m, 'a').velocity;
    expect(Math.hypot(v.x, v.z)).toBeLessThan(RUMBLE_BODY.walkSpeed * COMBAT.carrySpeed + 0.15);
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0.6);
    expect(f(m, 'b').heldBy).toBe('a');
    m.dispose();
  });

  it('a struggling load slows its carrier', () => {
    const quiet = four();
    grab(quiet);
    quiet.setInput('a', { x: 1, z: 0 });
    secs(quiet, 0.6);
    const vQuiet = Math.hypot(f(quiet, 'a').velocity.x, f(quiet, 'a').velocity.z);
    quiet.dispose();
    const loud = four();
    grab(loud);
    loud.setInput('a', { x: 1, z: 0 });
    // Four counted strokes: struggle 4/6, carried speed about a third down.
    struggle(loud, 'b', 5, 0.9);
    loud.setInput('b', { x: 0, z: 0 });
    secs(loud, 0.2);
    expect(f(loud, 'b').combat.struggle).toBeGreaterThan(0.5);
    const vLoud = Math.hypot(f(loud, 'a').velocity.x, f(loud, 'a').velocity.z);
    expect(vLoud).toBeLessThan(vQuiet * 0.8);
    loud.dispose();
  });

  it('a hold ends by itself after its longest time, and the dropped body may not be grabbed again at once', () => {
    const m = four();
    grab(m);
    const events = secs(m, COMBAT.grabMaxHold + 0.2);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'drop', who: 'a', on: 'b' }));
    expect(f(m, 'b').heldBy).toBeNull();
    expect(f(m, 'b').combat.grabImmune).toBeGreaterThan(0.5);
    m.dispose();
  });
});

describe('the escape (M11.1)', () => {
  it('grabbed in the middle of the classic centre by a carrier walking for the rim, a fighter struggling at a fair pace is free before the rim and lands on the floor', () => {
    const m = four();
    grab(m, { x: 0, z: 0 });
    m.setInput('a', { x: 0, z: 1, run: true });
    const when = struggle(m, 'b', 5, 3);
    expect(when).toBeGreaterThan(0);
    expect(when).toBeLessThan(1.5);
    m.setInput('b', { x: 0, z: 0 });
    m.setInput('a', { x: 0, z: 0 });
    secs(m, 1.5);
    const b = f(m, 'b');
    expect(b.alive).toBe(true);
    expect(b.position.z).toBeLessThan(3.5);
    expect(f(m, 'a').position.z).toBeLessThan(2.6);
    m.dispose();
  });

  it('a slower struggler (three strokes a second) is still free inside the hold’s longest time', () => {
    const m = four();
    grab(m);
    const when = struggle(m, 'b', 3, 3);
    expect(when).toBeGreaterThan(0);
    expect(when).toBeLessThanOrEqual(COMBAT.grabMaxHold + 0.05);
    m.dispose();
  });

  it('after breaking free nobody may grab the fighter for the immunity; after a throw, not until it has landed and righted itself', () => {
    const m = four();
    grab(m);
    const when = struggle(m, 'b', 6, 3);
    expect(when).toBeGreaterThan(0);
    expect(f(m, 'b').combat.grabImmune).toBeCloseTo(STRUGGLE.regrabImmunity, 1);
    expect(STRUGGLE.regrabImmunity).toBeGreaterThanOrEqual(1);
    // A throw.
    const t = four();
    grab(t);
    t.setInput('a', { grab: true });
    const ev = steps(t, 2);
    expect(ev).toContainEqual(expect.objectContaining({ kind: 'throw', who: 'a', on: 'b' }));
    expect(f(t, 'b').combat.grabImmune).toBeCloseTo(COMBAT.throwImmunity, 1);
    expect(COMBAT.throwImmunity).toBeGreaterThan(COMBAT.tumbleDuration + COMBAT.recoveryDuration + 0.4);
    // 'a' walks up and tries again at once: refused until the immunity is over.
    secs(t, COMBAT.tumbleDuration + COMBAT.recoveryDuration + 0.1);
    const b = f(t, 'b');
    t.debugPlace('a', { x: b.position.x - 0.8, z: b.position.z, yaw: Math.PI / 2 });
    t.setInput('a', { grab: true });
    steps(t, 3);
    expect(f(t, 'b').heldBy).toBeNull();
    t.dispose();
    m.dispose();
  });

  it('struggle inputs register over the host’s input path: numbered input messages alternating left and right break the hold', () => {
    const h = new RumbleHost({ havok, players: ['a', 'b', 'c', 'd'], arena: CLASSIC });
    h.connect(1);
    h.connect(2);
    expect(h.slot(2)).toBe('b');
    const m = h.match;
    for (const id of ['a', 'c', 'd']) m.setInput(id, { x: 0, z: 0 });
    m.debugPlace('c', { x: -3, z: -3 });
    m.debugPlace('d', { x: 3, z: -3 });
    m.debugPlace('a', { x: 0, z: 0, yaw: Math.PI / 2 });
    m.debugPlace('b', { x: 0.8, z: 0, yaw: -Math.PI / 2 });
    for (let i = 0; i < 5; i++) h.tick();
    m.setInput('a', { grab: true });
    for (let i = 0; i < 3; i++) h.tick();
    expect(h.state().snapshot.fighters[1].heldBy).toBe('a');
    let seq = 0;
    let side = 1;
    let freed = -1;
    for (let i = 0; i < 180; i++) {
      if (i % 12 === 0) {
        side = -side;
        h.receive(2, JSON.stringify({ t: 'input', seq: ++seq, intent: { x: side, z: 0, run: false, jump: false, punch: false, grab: false } }));
      }
      h.tick();
      if (!h.state().snapshot.fighters[1].heldBy) {
        freed = i / 60;
        break;
      }
    }
    expect(freed).toBeGreaterThan(0);
    expect(freed).toBeLessThan(1.6);
    h.dispose();
  });
});
