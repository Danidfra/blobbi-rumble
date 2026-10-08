/**
 * The struggle, as plain numbers: reversals build escape progress; holding
 * a direction, or repeating one, does not; input faster than the cap counts
 * at the cap; progress belongs to one hold.
 */
import { describe, expect, it } from 'vitest';
import { STRUGGLE } from '../tuning';
import { createCombatState, endGrab, grabbable, tickCombat } from './combat';
import { stepStruggle } from './struggle';

const DT = 1 / 60;
const LEFT = { x: -1, z: 0 };
const RIGHT = { x: 1, z: 0 };
const NONE = { x: 0, z: 0 };
const held = () => {
  const c = createCombatState();
  c.held = true;
  c.holder = 0;
  return c;
};
/** Feed a pattern: each entry is a direction held for `frames` steps. Returns the seconds at which it escaped (or -1) and the progress. */
function play(pattern: { d: { x: number; z: number }; frames: number }[], repeat = 1) {
  const c = held();
  let t = 0;
  for (let r = 0; r < repeat; r++)
    for (const { d, frames } of pattern)
      for (let k = 0; k < frames; k++) {
        t += DT;
        if (stepStruggle(c, d, DT).escaped) return { escapedAt: t, progress: c.struggle, c };
      }
  return { escapedAt: -1, progress: c.struggle, c };
}

describe('the struggle', () => {
  it('alternating left and right builds progress, and breaks free in about a second and a quarter at a good pace', () => {
    // A stroke each 0.2 s (5 a second), straight from one side to the other.
    const r = play([{ d: LEFT, frames: 12 }, { d: RIGHT, frames: 12 }], 10);
    expect(r.escapedAt).toBeGreaterThan(1.0);
    expect(r.escapedAt).toBeLessThan(1.7);
    // With a neutral between strokes it works the same.
    const n = play([{ d: LEFT, frames: 8 }, { d: NONE, frames: 4 }, { d: RIGHT, frames: 8 }, { d: NONE, frames: 4 }], 10);
    expect(n.escapedAt).toBeGreaterThan(1.0);
    expect(n.escapedAt).toBeLessThan(1.8);
  });

  it('holding one direction counts nothing', () => {
    const r = play([{ d: LEFT, frames: 600 }]);
    expect(r.progress).toBe(0);
  });

  it('the same direction again and again, with neutrals between, counts nothing', () => {
    const r = play([{ d: LEFT, frames: 6 }, { d: NONE, frames: 6 }], 40);
    expect(r.progress).toBe(0);
    const up = play([{ d: { x: 0, z: 1 }, frames: 5 }, { d: NONE, frames: 5 }], 40);
    expect(up.progress).toBe(0);
  });

  it('any opposite pair works (up and down, a stick wiggled), whatever the camera made of left and right', () => {
    const r = play([{ d: { x: 0.6, z: 0.8 }, frames: 12 }, { d: { x: -0.6, z: -0.8 }, frames: 12 }], 10);
    expect(r.escapedAt).toBeGreaterThan(0);
    // A quarter turn is not a reversal.
    const q = play([{ d: LEFT, frames: 12 }, { d: { x: 0, z: 1 }, frames: 12 }], 10);
    expect(q.progress).toBe(0);
    // A weak push is neutral.
    expect(play([{ d: { x: -0.3, z: 0 }, frames: 12 }, { d: { x: 0.3, z: 0 }, frames: 12 }], 10).progress).toBe(0);
  });

  it('spam is capped: alternating every frame, or at 15 a second, breaks free no faster than the cap allows', () => {
    const cap = (STRUGGLE.strokes - STRUGGLE.credit) * STRUGGLE.minInterval;
    const everyFrame = play([{ d: LEFT, frames: 1 }, { d: RIGHT, frames: 1 }], 200);
    const fifteen = play([{ d: LEFT, frames: 4 }, { d: RIGHT, frames: 4 }], 100);
    const good = play([{ d: LEFT, frames: 9 }, { d: RIGHT, frames: 9 }], 100); // ~6.7 strokes a second
    for (const r of [everyFrame, fifteen]) {
      expect(r.escapedAt).toBeGreaterThan(cap - 0.05);
      // Spam counts at the same rate as a good rhythm at the cap; it only gets its first reversal in sooner and spends the
      // small slack credit at once: a one-off head start of under a quarter second per hold, never a faster rate.
      expect(r.escapedAt).toBeGreaterThan(good.escapedAt - 0.25);
    }
    // And a little faster than the cap loses nothing against the cap itself (no cliff).
    const seven = play([{ d: LEFT, frames: 8 }, { d: RIGHT, frames: 8 }], 100);
    expect(seven.escapedAt).toBeLessThan(good.escapedAt + 0.2);
  });

  it('progress belongs to the hold: ending it clears every trace, so the next grab starts from nothing', () => {
    const r = play([{ d: LEFT, frames: 12 }, { d: RIGHT, frames: 12 }], 2);
    expect(r.progress).toBeGreaterThan(0);
    endGrab(createCombatState(), r.c);
    expect(r.c).toMatchObject({ held: false, holder: -1, struggle: 0, strokeX: 0, strokeZ: 0, moveX: 0, moveZ: 0, strokeCredit: STRUGGLE.credit });
  });

  it('a body just broken free cannot be grabbed until its immunity runs out; nothing else about it changes', () => {
    const c = createCombatState();
    c.grabImmune = STRUGGLE.regrabImmunity;
    expect(grabbable(c)).toBe(false);
    tickCombat(c, STRUGGLE.regrabImmunity / 2);
    expect(grabbable(c)).toBe(false);
    tickCombat(c, STRUGGLE.regrabImmunity / 2 + 0.01);
    expect(grabbable(c)).toBe(true);
  });
});
