/**
 * L4.4A: the action buttons' timing windows, on the server's match. A jump
 * pressed just before landing jumps on landing, one pressed just after
 * stepping off an edge still jumps (coyote time), and neither is ever a
 * second jump; a punch pressed just before its cooldown ends starts when
 * it ends, never sooner and never twice; a grab keeps trying for a moment,
 * so a target coming into reach is taken, and a grab pressed with a punch
 * is kept. Nothing waits out of play.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC } from '../arena/arenas';
import { freshJumpState, gateJump, type JumpState } from '../control/mover';
import { COMBAT, INPUT_WINDOWS } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, pressAge, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { MatchEvent } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
const DT = 1 / 60;
const W = INPUT_WINDOWS;
const four = () => createRumbleMatch({ havok, players: ['a', 'b', 'c', 'd'].map((id) => ({ id })), arena: CLASSIC });
const f = (m: RumbleMatch, id: string) => m.snapshot().fighters.find((x) => x.id === id)!;
const count = (events: MatchEvent[], kind: MatchEvent['kind'], who = 'a') => events.filter((e) => e.kind === kind && e.who === who).length;
/** 'a' alone at the centre facing +x, the others far away; settled. */
const alone = (m: RumbleMatch) => {
  for (const id of m.ids) m.setInput(id, { x: 0, z: 0 });
  m.debugPlace('b', { x: 3, z: 3 });
  m.debugPlace('c', { x: -3, z: -3 });
  m.debugPlace('d', { x: 3, z: -3 });
  m.debugPlace('a', { x: 0, z: 0, yaw: Math.PI / 2 });
  for (let i = 0; i < 20; i++) m.step(DT);
};
/** Steps until `pred`, at most `max`; returns how many were taken, or -1. */
const until = (m: RumbleMatch, pred: (ev: MatchEvent[]) => boolean, max = 200, events: MatchEvent[] = []) => {
  for (let k = 1; k <= max; k++) {
    const ev = m.step(DT);
    events.push(...ev);
    if (pred(ev)) return k;
  }
  return -1;
};

describe('the jump gate (pure, shared by the server and the prediction)', () => {
  const run = (frames: { pressed?: boolean; grounded: boolean; able?: boolean }[]) => {
    let s: JumpState = freshJumpState();
    return frames.map((x) => {
      const r = gateJump(s, !!x.pressed, x.grounded, x.able ?? true, DT, W);
      s = r.state;
      return r.jump;
    });
  };
  const air = (n: number) => Array.from({ length: n }, () => ({ grounded: false }));
  const ground = (n: number) => Array.from({ length: n }, () => ({ grounded: true }));

  it('on the ground a press jumps at once, and only once', () => {
    expect(run([...ground(3), { pressed: true, grounded: true }, ...ground(30)]).filter(Boolean).length).toBe(1);
  });

  it('a press up to the buffer before landing jumps on the landing step; earlier is refused', () => {
    const steps = Math.round(W.jumpBuffer / DT);
    for (const before of [1, 3, steps]) {
      const out = run([...ground(2), ...air(20), { pressed: true, grounded: false }, ...air(before - 1), ...ground(5)]);
      // Walking off then landing: the press is honoured exactly when the feet are down.
      expect(out.indexOf(true)).toBe(2 + 20 + before);
      expect(out.filter(Boolean).length).toBe(1);
    }
    const late = run([...ground(2), ...air(20), { pressed: true, grounded: false }, ...air(steps), ...ground(5)]);
    expect(late.some(Boolean)).toBe(false);
  });

  it('coyote time: off the edge without a jump, a press still jumps for a few steps, never after', () => {
    const steps = Math.round(W.coyote / DT);
    for (let k = 1; k <= steps; k++) {
      const out = run([...ground(5), ...air(k - 1), { pressed: true, grounded: false }, ...air(5)]);
      expect(out.indexOf(true)).toBe(5 + k - 1);
    }
    const tooLate = run([...ground(5), ...air(steps), { pressed: true, grounded: false }, ...air(5)]);
    expect(tooLate.some(Boolean)).toBe(false);
  });

  it('never a double jump: the floor still under the rising feet does not count, and a jump earns no coyote time', () => {
    // Pressed on the ground, then again on each of the next steps while the probe still sees the floor.
    const out = run([{ pressed: true, grounded: true }, ...Array.from({ length: 8 }, () => ({ pressed: true, grounded: true }))]);
    expect(out.filter(Boolean).length).toBe(1);
    // Pressed in the air right after a jump (inside the coyote time of a walk-off): refused.
    const air2 = run([{ pressed: true, grounded: true }, ...air(2), { pressed: true, grounded: false }, ...air(20)]);
    expect(air2.filter(Boolean).length).toBe(1);
  });

  it('unable (stunned, carrying, settling): the press waits out its window and jumps only if able in time', () => {
    const waits = run([{ pressed: true, grounded: true, able: false }, { grounded: true, able: false }, { grounded: true, able: true }]);
    expect(waits).toEqual([false, false, true]);
    const expires = run([{ pressed: true, grounded: true, able: false }, ...Array.from({ length: Math.round(W.jumpBuffer / DT) }, () => ({ grounded: true, able: false })), { grounded: true }]);
    expect(expires.some(Boolean)).toBe(false);
  });

  it('a waiting press ages and expires on time (the shared press window)', () => {
    let a = pressAge(-1, true, DT, 0.1);
    expect(a).toBe(0);
    for (let k = 1; k <= 6; k++) {
      a = pressAge(a, false, DT, 0.1);
      expect(a).toBeGreaterThanOrEqual(0);
    }
    expect(pressAge(a, false, DT, 0.1)).toBe(-1);
    expect(pressAge(-1, false, DT, 0.1)).toBe(-1);
  });
});

describe('jumping on the server (buffer, coyote, no double jump)', () => {
  it('a jump pressed just before landing jumps on landing', () => {
    const m = four();
    alone(m);
    m.setInput('a', { jump: true });
    expect(count(m.step(DT), 'jump')).toBe(1);
    m.setInput('a', {});
    // Fall until a few steps before the feet are down (found by a dry run of the same jump).
    const dry = four();
    alone(dry);
    dry.setInput('a', { jump: true });
    dry.step(DT);
    dry.setInput('a', {});
    let landing = 0;
    for (let k = 1; k < 120 && !landing; k++) {
      dry.step(DT);
      if (k > 10 && f(dry, 'a').grounded) landing = k;
    }
    expect(landing).toBeGreaterThan(20);
    dry.dispose();
    const early = Math.round(W.jumpBuffer / DT) - 1;
    for (let k = 1; k < landing - early; k++) m.step(DT);
    expect(f(m, 'a').grounded).toBe(false);
    m.setInput('a', { jump: true });
    const events: MatchEvent[] = [];
    const k = until(m, (ev) => count(ev, 'jump') > 0, 30, events);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThanOrEqual(early + 2);
    expect(count(events, 'jump')).toBe(1);
    m.dispose();
  });

  it('a single press is never two jumps, however the presses fall around it', () => {
    const m = four();
    alone(m);
    const events: MatchEvent[] = [];
    // Mash: a press every step for half a second.
    for (let k = 0; k < 30; k++) {
      m.setInput('a', { jump: true });
      events.push(...m.step(DT));
    }
    m.setInput('a', {});
    expect(count(events, 'jump')).toBe(1);
    expect(f(m, 'a').position.y).toBeGreaterThan(0.6);
    m.dispose();
  });

  it('a press that is too early (well before landing) does nothing', () => {
    const m = four();
    alone(m);
    m.setInput('a', { jump: true });
    m.step(DT);
    m.setInput('a', {});
    for (let k = 0; k < 8; k++) m.step(DT);
    m.setInput('a', { jump: true });
    const events: MatchEvent[] = [];
    for (let k = 0; k < 90; k++) events.push(...m.step(DT));
    expect(count(events, 'jump')).toBe(0);
    m.dispose();
  });

  it('coyote time: walking off the island, a jump a few steps after the feet leave still jumps', () => {
    const run = (late: number) => {
      const m = four();
      alone(m);
      // The south edge of the classic centre is z = -4.5: walk off it.
      m.debugPlace('a', { x: 0, z: -4.2, yaw: Math.PI });
      for (let i = 0; i < 10; i++) m.step(DT);
      m.setInput('a', { x: 0, z: -1, run: false });
      let left = -1;
      for (let k = 0; k < 120 && left < 0; k++) {
        m.step(DT);
        if (!f(m, 'a').grounded) left = k;
      }
      expect(left).toBeGreaterThanOrEqual(0);
      for (let k = 1; k < late; k++) m.step(DT);
      m.setInput('a', { x: 0, z: -1, jump: true });
      const ev = m.step(DT);
      m.setInput('a', { x: 0, z: -1 });
      const jumped = count(ev, 'jump') === 1;
      m.dispose();
      return jumped;
    };
    // `late` steps after the first airborne step: the press lands on airborne step late + 1.
    const steps = Math.round(W.coyote / DT);
    expect(run(1)).toBe(true);
    expect(run(steps - 1)).toBe(true);
    expect(run(steps + 2)).toBe(false);
  });

  it('after a respawn or a new round, nothing of an old press is left', () => {
    const m = four();
    alone(m);
    m.setInput('a', { jump: true });
    m.step(DT);
    m.setInput('a', {});
    // A press in the air, then the round is reset before it can land.
    for (let k = 0; k < 20; k++) m.step(DT);
    m.setInput('a', { jump: true });
    m.step(DT);
    m.setInput('a', {});
    m.restart();
    const events: MatchEvent[] = [];
    for (let k = 0; k < 60; k++) events.push(...m.step(DT));
    expect(count(events, 'jump')).toBe(0);
    m.dispose();
  });
});

describe('punching (a short buffer before the cooldown ends)', () => {
  /** 'a' punches the air once; returns the step count since. */
  const firstPunch = (m: RumbleMatch) => {
    alone(m);
    m.setInput('a', { punch: true });
    m.step(DT);
    m.setInput('a', {});
    expect(f(m, 'a').combat.punchTime).toBeGreaterThanOrEqual(0);
  };
  const cooldownSteps = Math.round(COMBAT.punchCooldown / DT);

  it('pressed within the buffer before the cooldown ends: it starts on the first step it may, exactly once', () => {
    for (const before of [1, 3, Math.round(W.punchBuffer / DT)]) {
      const m = four();
      firstPunch(m);
      // `before` steps before the cooldown is over.
      for (let k = 1; k < cooldownSteps - before; k++) m.step(DT);
      expect(f(m, 'a').combat.punchTime).toBe(-1);
      m.setInput('a', { punch: true });
      m.step(DT);
      m.setInput('a', {});
      let started = -1;
      let starts = 0;
      let wasPunching = false;
      for (let k = 1; k <= 60; k++) {
        m.step(DT);
        const punching = f(m, 'a').combat.punchTime >= 0;
        if (punching && !wasPunching) {
          starts += 1;
          if (started < 0) started = k;
        }
        wasPunching = punching;
      }
      expect(starts).toBe(1);
      // Never before the cooldown: it starts `before` steps later (give or take the rounding of the cooldown's last step).
      expect(started).toBeGreaterThanOrEqual(before - 1);
      expect(started).toBeLessThanOrEqual(before + 1);
      m.dispose();
    }
  });

  it('pressed earlier than the buffer: refused, nothing starts later', () => {
    const m = four();
    firstPunch(m);
    const early = Math.round(W.punchBuffer / DT) + 4;
    for (let k = 1; k < cooldownSteps - early; k++) m.step(DT);
    m.setInput('a', { punch: true });
    m.step(DT);
    m.setInput('a', {});
    let starts = 0;
    let was = f(m, 'a').combat.punchTime >= 0;
    for (let k = 0; k < 90; k++) {
      m.step(DT);
      const p = f(m, 'a').combat.punchTime >= 0;
      if (p && !was) starts += 1;
      was = p;
    }
    expect(starts).toBe(0);
    m.dispose();
  });

  it('spamming punch never punches faster than the cooldown allows, and nothing is queued after the spam stops', () => {
    const m = four();
    alone(m);
    let starts = 0;
    let was = false;
    const steps = 4 * 60;
    for (let k = 0; k < steps; k++) {
      m.setInput('a', { punch: true });
      m.step(DT);
      const p = f(m, 'a').combat.punchTime >= 0;
      if (p && !was) starts += 1;
      was = p;
    }
    expect(starts).toBeLessThanOrEqual(Math.floor(steps / cooldownSteps) + 1);
    m.setInput('a', {});
    let after = 0;
    for (let k = 0; k < 120; k++) {
      m.step(DT);
      const p = f(m, 'a').combat.punchTime >= 0;
      if (p && !was) after += 1;
      was = p;
    }
    expect(after).toBe(0);
    m.dispose();
  });

  it('a buffered punch dies with the round: none after elimination, a reset or the end of play', () => {
    const m = four();
    firstPunch(m);
    for (let k = 1; k < cooldownSteps - 3; k++) m.step(DT);
    m.setInput('a', { punch: true });
    m.step(DT);
    m.setInput('a', {});
    m.restart();
    let starts = 0;
    for (let k = 0; k < 30; k++) {
      m.step(DT);
      if (f(m, 'a').combat.punchTime >= 0) starts += 1;
    }
    expect(starts).toBe(0);
    m.dispose();
  });
});

describe('grabbing (a short window; reach and arc unchanged)', () => {
  /** 'a' at the origin facing +x; 'b' at distance `d` straight ahead. */
  const facing = (m: RumbleMatch, d: number) => {
    alone(m);
    m.debugPlace('b', { x: d, z: 0, yaw: -Math.PI / 2 });
    for (let i = 0; i < 5; i++) m.step(DT);
  };

  it('in reach: taken at once, exactly one grab; out of reach and nobody coming: nothing, ever', () => {
    const m = four();
    facing(m, 0.9);
    m.setInput('a', { grab: true });
    const ev = m.step(DT);
    m.setInput('a', {});
    expect(count(ev, 'grab')).toBe(1);
    expect(f(m, 'b').heldBy).toBe('a');
    m.dispose();
    const far = four();
    facing(far, COMBAT.grabRange + 0.6);
    far.setInput('a', { grab: true });
    const events: MatchEvent[] = [];
    events.push(...far.step(DT));
    far.setInput('a', {});
    for (let k = 0; k < 30; k++) events.push(...far.step(DT));
    expect(count(events, 'grab')).toBe(0);
    expect(f(far, 'b').heldBy).toBeNull();
    far.dispose();
  });

  it('a target that comes into reach within the window is taken (the press was a few centimetres early)', () => {
    const m = four();
    facing(m, 2.4);
    // 'b' runs at 'a'; 'a' presses grab while 'b' is still a little out of reach.
    m.setInput('b', { x: -1, z: 0, run: true });
    const gap = () => Math.hypot(f(m, 'b').position.x - f(m, 'a').position.x, f(m, 'b').position.z - f(m, 'a').position.z);
    for (let k = 0; k < 120 && gap() > COMBAT.grabRange + 0.1; k++) m.step(DT);
    expect(gap()).toBeGreaterThan(COMBAT.grabRange);
    m.setInput('a', { grab: true });
    const events: MatchEvent[] = [...m.step(DT)];
    m.setInput('a', {});
    expect(count(events, 'grab')).toBe(0);
    for (let k = 0; k < Math.round(W.grabWindow / DT); k++) events.push(...m.step(DT));
    expect(count(events, 'grab')).toBe(1);
    expect(f(m, 'b').heldBy).toBe('a');
    m.dispose();
  });

  it('the window does not extend reach: a target that stays just out of reach is never taken', () => {
    const m = four();
    facing(m, COMBAT.grabRange + 0.1);
    m.setInput('a', { grab: true });
    const events: MatchEvent[] = [...m.step(DT)];
    m.setInput('a', {});
    for (let k = 0; k < 30; k++) events.push(...m.step(DT));
    expect(count(events, 'grab')).toBe(0);
    m.dispose();
  });

  it('a grab pressed with a punch in the same step is kept (the grab is judged first)', () => {
    const m = four();
    facing(m, 0.9);
    m.setInput('a', { grab: true, punch: true });
    const ev = m.step(DT);
    m.setInput('a', {});
    expect(count(ev, 'grab')).toBe(1);
    expect(f(m, 'b').heldBy).toBe('a');
    m.dispose();
  });

  it('a grab pressed late in a punch’s recovery is taken when the hands are free', () => {
    const m = four();
    facing(m, 0.9);
    // Facing away, so the punch misses; turned back to 'b' once the punch can no longer land.
    m.debugPlace('a', { x: 0, z: 0, yaw: -Math.PI / 2 });
    m.setInput('a', { punch: true });
    m.step(DT);
    m.setInput('a', {});
    const active = Math.ceil(COMBAT.punchActive / DT) + 1;
    for (let k = 0; k < active; k++) m.step(DT);
    m.debugPlace('a', { x: 0, z: 0, yaw: Math.PI / 2 });
    const busy = Math.round((COMBAT.punchActive + COMBAT.punchRecovery) / DT);
    for (let k = 1 + active; k < busy - 3; k++) m.step(DT);
    expect(f(m, 'b').hits).toBe(0);
    expect(f(m, 'a').combat.punchTime).toBeGreaterThanOrEqual(0);
    m.setInput('a', { grab: true });
    const events: MatchEvent[] = [...m.step(DT)];
    m.setInput('a', {});
    for (let k = 0; k < 10; k++) events.push(...m.step(DT));
    expect(count(events, 'grab')).toBe(1);
    m.dispose();
  });

  it('one press is one transition: a grab never turns into a throw by itself, and a throw needs a new press', () => {
    const m = four();
    facing(m, 0.9);
    m.setInput('a', { grab: true });
    const events: MatchEvent[] = [...m.step(DT)];
    m.setInput('a', {});
    for (let k = 0; k < 30; k++) events.push(...m.step(DT));
    expect(count(events, 'grab')).toBe(1);
    expect(count(events, 'throw')).toBe(0);
    expect(f(m, 'b').heldBy).toBe('a');
    m.setInput('a', { grab: true });
    events.push(...m.step(DT));
    m.setInput('a', {});
    for (let k = 0; k < 30; k++) events.push(...m.step(DT));
    expect(count(events, 'throw')).toBe(1);
    expect(count(events, 'grab')).toBe(1);
    expect(f(m, 'b').heldBy).toBeNull();
    expect(m.holdsConsistent()).toBe(true);
    // The thrown body is immune for a while: a grab pressed now, window and all, takes nobody.
    m.debugPlace('b', { x: 0.9, z: 0, yaw: -Math.PI / 2 });
    m.debugPlace('a', { x: 0, z: 0, yaw: Math.PI / 2 });
    m.setInput('a', { grab: true });
    const again: MatchEvent[] = [...m.step(DT)];
    m.setInput('a', {});
    for (let k = 0; k < 12; k++) again.push(...m.step(DT));
    expect(count(again, 'grab')).toBe(0);
    m.dispose();
  });

  it('mashing grab to break free is not a grab: the freed fighter does not take its holder back', () => {
    const m = four();
    facing(m, 0.9);
    m.setInput('a', { grab: true });
    m.step(DT);
    m.setInput('a', {});
    expect(f(m, 'b').heldBy).toBe('a');
    // 'b' struggles (side to side) with grab pressed every step until free.
    const events: MatchEvent[] = [];
    let side = 1;
    for (let k = 0; k < 240 && f(m, 'b').heldBy; k++) {
      if (k % 6 === 0) side = -side;
      m.setInput('b', { x: side, z: 0, grab: true });
      events.push(...m.step(DT));
    }
    m.setInput('b', { x: 0, z: 0 });
    for (let k = 0; k < 10; k++) events.push(...m.step(DT));
    expect(count(events, 'grab', 'b')).toBe(0);
    m.dispose();
  });
});
