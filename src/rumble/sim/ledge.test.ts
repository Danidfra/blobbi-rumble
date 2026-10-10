/**
 * M11C as pure logic: when a body may catch a ledge, where it hangs and
 * climbs to, and what a step of hanging decides: the drain of endurance,
 * the climb, letting go, giving out, and the rest that brings grip back.
 */
import { describe, expect, it } from 'vitest';
import { SKYFALL } from '../arena/arenas';
import { createCombatState, startTumble } from '../combat/combat';
import { RUMBLE_BODY } from '../profile';
import { LEDGE } from '../tuning';
import { IDLE_INTENT } from './intent';
import { canCatch, catchLedge, climbTarget, createLedgeState, dropLedge, hangAnchor, onLedge, reachableLedge, resetLedgeState, restLedge, tickLedge } from './ledge';

const DT = 1 / 60;
const free = () => createCombatState();

describe('catching a ledge', () => {
  it('needs a free, upright body in the air and falling, rested enough, and not just off a ledge', () => {
    const s = createLedgeState();
    expect(canCatch(s, free(), false, -2)).toBe(true);
    expect(canCatch(s, free(), true, -2)).toBe(false);
    expect(canCatch(s, free(), false, -0.2)).toBe(false);
    expect(canCatch(s, free(), false, 1)).toBe(false);
    const down = free();
    startTumble(down);
    expect(canCatch(s, down, false, -2)).toBe(false);
    const held = free();
    held.held = true;
    expect(canCatch(s, held, false, -2)).toBe(false);
    const holding = free();
    holding.holding = 0.2;
    expect(canCatch(s, holding, false, -2)).toBe(false);
    s.endurance = LEDGE.minToCatch - 0.01;
    expect(canCatch(s, free(), false, -2)).toBe(false);
    resetLedgeState(s);
    dropLedge(s);
    expect(canCatch(s, free(), false, -2)).toBe(false);
    restLedge(s, LEDGE.regrab + 0.01, false);
    expect(canCatch(s, free(), false, -2)).toBe(true);
  });

  it('finds the edge within the hands’ reach, above the feet up to arm’s length, never a platform under the body, and skips what is told', () => {
    const ps = SKYFALL.platforms;
    const centre = 0;
    // Just south of the centre's south edge (z -4), feet 0.5 below its top.
    const l = reachableLedge(ps, { x: 2, y: -0.5 + RUMBLE_BODY.capsuleCenterY, z: -4.5 }, -0.5);
    expect(l).not.toBeNull();
    expect(l!.platform).toBe(centre);
    expect(l!.z).toBe(-4);
    expect(l!.inZ).toBe(1);
    expect(l!.inX).toBe(0);
    // Too far out, too far below, above the top: nothing.
    expect(reachableLedge(ps, { x: 2, y: 0, z: -4.9 }, -0.5)).toBeNull();
    expect(reachableLedge(ps, { x: 2, y: -1.2, z: -4.5 }, -1.6)).toBeNull();
    expect(reachableLedge(ps, { x: 2, y: 1, z: -4.5 }, 0.5)).toBeNull();
    // Skipped (a piece that is gone).
    expect(reachableLedge(ps, { x: 2, y: 0, z: -4.5 }, -0.5, (i) => i === centre)).toBeNull();
  });

  it('hangs just clear of the wall with the feet below the top, and climbs to a little in from the edge on top', () => {
    const l = { platform: 0, x: 2, y: 0, z: -4, inX: 0, inZ: 1 };
    const a = hangAnchor(l);
    expect(a.z).toBeCloseTo(-4 - RUMBLE_BODY.capsuleRadius - LEDGE.hangOut, 6);
    expect(a.y - RUMBLE_BODY.capsuleCenterY).toBeCloseTo(-LEDGE.hangDrop, 6);
    const c = climbTarget(l);
    expect(c.z).toBeCloseTo(-4 + RUMBLE_BODY.capsuleRadius + LEDGE.climbIn, 6);
    expect(c.y - RUMBLE_BODY.capsuleCenterY).toBeCloseTo(LEDGE.climbOver, 6);
  });
});

describe('hanging', () => {
  const ledge = { platform: 0, x: 2, y: 0, z: -4, inX: 0, inZ: 1 };
  const hang = () => {
    const s = createLedgeState();
    catchLedge(s, ledge);
    return s;
  };
  const run = (s: ReturnType<typeof hang>, seconds: number, intent = IDLE_INTENT) => {
    let out = 'hanging';
    for (let i = 0; i < Math.round(seconds / DT); i++) out = tickLedge(s, DT, intent);
    return out;
  };

  it('drains endurance while hanging, and gives out when it is gone', () => {
    const s = hang();
    expect(onLedge(s)).toBe(true);
    expect(run(s, 1)).toBe('hanging');
    expect(s.endurance).toBeCloseTo(1 - 1 / LEDGE.endurance, 1);
    expect(run(s, LEDGE.endurance)).toBe('tired');
    expect(s.endurance).toBe(0);
  });

  it('a jump starts the climb, which takes its time and then is done; nothing else interrupts a climb', () => {
    const s = hang();
    expect(tickLedge(s, DT, { ...IDLE_INTENT, jump: true })).toBe('climbing');
    expect(s.hold!.phase).toBe('climb');
    expect(run(s, LEDGE.climbTime / 2, { ...IDLE_INTENT, grab: true, z: -1 })).toBe('climbing');
    expect(run(s, LEDGE.climbTime / 2 + 0.05)).toBe('climbed');
  });

  it('a grab lets go at once; pushing away lets go only when held a moment; a shorter push, or one in or along, does not', () => {
    expect(tickLedge(hang(), DT, { ...IDLE_INTENT, grab: true })).toBe('let go');
    const s = hang();
    expect(run(s, LEDGE.awayHold - 0.1, { ...IDLE_INTENT, z: -1 })).toBe('hanging');
    expect(run(s, 0.2)).toBe('hanging');
    expect(run(s, LEDGE.awayHold - 0.1, { ...IDLE_INTENT, z: -1 })).toBe('hanging');
    expect(run(s, 0.15, { ...IDLE_INTENT, z: -1 })).toBe('let go');
    const t = hang();
    expect(run(t, 1, { ...IDLE_INTENT, z: 1 })).toBe('hanging');
    expect(run(t, 1, { ...IDLE_INTENT, x: 1 })).toBe('hanging');
  });

  it('endurance comes back standing on the floor, not in the air nor while holding; a drop forbids a new catch for a moment', () => {
    const s = hang();
    run(s, 2);
    const drained = s.endurance;
    restLedge(s, 1, true);
    expect(s.endurance).toBe(drained);
    dropLedge(s);
    expect(s.hold).toBeNull();
    expect(s.regrab).toBe(LEDGE.regrab);
    restLedge(s, 1, false);
    expect(s.endurance).toBe(drained);
    restLedge(s, 1, true);
    expect(s.endurance).toBeCloseTo(Math.min(1, drained + LEDGE.regain), 6);
    restLedge(s, 10, true);
    expect(s.endurance).toBe(1);
    expect(s.regrab).toBe(0);
  });
});
