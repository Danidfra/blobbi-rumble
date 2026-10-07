/**
 * Everyone against everyone, as plain numbers: whom a punch or a grab takes
 * among several fighters, that a body has one holder at most, and that a
 * hold ends cleanly whatever ends it (a blow on the carrier, a blow on the
 * held, a tumble, a ring-out).
 */
import { describe, expect, it } from 'vitest';
import { nearestContacts } from '../physics/contact';
import { PUSH } from '../tuning';
import { createCombatState, endGrab, isHolding, landPunch, release, startTumble, tickCombat, tryGrab, tryPunch } from './combat';
import { freeHolds, grabTarget, holdsConsistent, pickTarget, punchTarget, settleHolds, type Combatant } from './melee';
import { COMBAT } from '../tuning';
import { RUMBLE_BODY } from '../profile';

const east = { x: 1, z: 0 };
const west = { x: -1, z: 0 };
const fighter = (x: number, z = 0, facing = east): Combatant => ({ combat: createCombatState(), at: { x, z }, facing, active: true });
/** A hold made the way the scene makes one: through tryGrab, with the roster indices. */
const grab = (list: Combatant[], i: number, j: number) => tryGrab(list[i].combat, list[i].at, list[i].facing, list[j].combat, list[j].at, COMBAT, { grabber: i, victim: j });

describe('targeting among several fighters', () => {
  it('a punch takes the nearest fighter in reach and arc, one only', () => {
    // P1 faces east; P2 0.9 m ahead, P3 1.1 m ahead, P4 behind.
    const list = [fighter(0), fighter(0.9), fighter(1.1), fighter(-0.9)];
    expect(punchTarget(list, 0)).toBe(1);
    // P2 steps aside out of the arc: the next nearest in reach.
    list[1].at = { x: 0, z: 0.95 };
    expect(punchTarget(list, 0)).toBe(2);
    // Nobody in reach.
    list[2].at = { x: COMBAT.punchRange + 0.1, z: 0 };
    expect(punchTarget(list, 0)).toBe(-1);
    // Behind is behind, however near.
    expect(pickTarget(list, 0, 5, COMBAT.punchArcCos)).toBe(2);
  });

  it('an exact tie goes to the lower roster index, and the answer depends only on where everyone stands', () => {
    const list = [fighter(0, 0, east), fighter(0.9, 0.3), fighter(0.9, -0.3), fighter(5)];
    expect(punchTarget(list, 0)).toBe(1);
    const swapped = [list[0], list[3], list[2], list[1]];
    expect(punchTarget(swapped, 0)).toBe(2);
  });

  it('a punch lands on exactly one body: the attack is marked landed on the first, so nobody else in reach is hit', () => {
    const list = [fighter(0), fighter(0.9), fighter(1.0, 0.1)];
    tryPunch(list[0].combat);
    const j = punchTarget(list, 0);
    expect(j).toBe(1);
    expect(landPunch(list[0].combat, list[0].at, east, 0, 1, list[j].combat, list[j].at, RUMBLE_BODY.walkSpeed)).not.toBeNull();
    expect(landPunch(list[0].combat, list[0].at, east, 0, 1, list[2].combat, list[2].at, RUMBLE_BODY.walkSpeed)).toBeNull();
  });

  it('a grab passes over a body it may not take (held, holding, down) for the next nearest one', () => {
    const list = [fighter(0), fighter(0.85), fighter(1.05, 0.2), fighter(3)];
    expect(grabTarget(list, 0)).toBe(1);
    startTumble(list[1].combat);
    expect(grabTarget(list, 0)).toBe(2);
    // But a punch still takes the downed body, the nearest.
    expect(punchTarget(list, 0)).toBe(1);
  });

  it('an eliminated fighter is never a target, and never attacks', () => {
    const list = [fighter(0), fighter(0.9), fighter(1.1)];
    list[1].active = false;
    expect(punchTarget(list, 0)).toBe(2);
    expect(grabTarget(list, 0)).toBe(2);
    list[0].active = false;
    list[1].active = true;
    list[1].facing = west;
    expect(punchTarget(list, 1)).toBe(-1);
    expect(punchTarget(list, 0)).toBe(-1);
    expect(grabTarget(list, 0)).toBe(-1);
  });
});

describe('who holds whom', () => {
  it('a hold names both sides; a held body cannot be grabbed by anyone else', () => {
    // P1 holds P2; P3 stands on P2's other side, facing it.
    const list = [fighter(0), fighter(0.9), fighter(1.8, 0, west)];
    expect(grab(list, 0, 1)).toBe(true);
    expect(list[0].combat.victim).toBe(1);
    expect(list[1].combat.holder).toBe(0);
    expect(holdsConsistent(list)).toBe(true);
    expect(grabTarget(list, 2)).toBe(-1);
    expect(grab(list, 2, 1)).toBe(false);
    expect(list[1].combat.holder).toBe(0);
    // Nor can the carrier be grabbed while it holds.
    expect(grab(list, 2, 0)).toBe(false);
    expect(holdsConsistent(list)).toBe(true);
  });

  it('a punch on the carrier drops the held body: both sides end, and the third fighter is free to grab it', () => {
    const list = [fighter(0), fighter(0.9), fighter(-0.9, 0, east)];
    grab(list, 0, 1);
    tryPunch(list[2].combat);
    expect(punchTarget(list, 2)).toBe(0);
    const ended = freeHolds(list, 0);
    expect(ended).toEqual([{ holder: 0, victim: 1 }]);
    expect(isHolding(list[0].combat)).toBe(false);
    expect(list[1].combat.held).toBe(false);
    expect(list[1].combat.holder).toBe(-1);
    expect(list[0].combat.victim).toBe(-1);
    expect(holdsConsistent(list)).toBe(true);
  });

  it('a punch on the held body frees it from its holder too', () => {
    const list = [fighter(0), fighter(0.9), fighter(1.8, 0, west)];
    grab(list, 0, 1);
    expect(freeHolds(list, 1)).toEqual([{ holder: 0, victim: 1 }]);
    expect(isHolding(list[0].combat)).toBe(false);
    expect(holdsConsistent(list)).toBe(true);
    // Nothing left to free.
    expect(freeHolds(list, 1)).toEqual([]);
  });

  it('a carrier that tumbles lets go: the frame\'s settle ends the pair', () => {
    const list = [fighter(0), fighter(0.9), fighter(3)];
    grab(list, 0, 1);
    startTumble(list[0].combat);
    expect(settleHolds(list)).toEqual([{ holder: 0, victim: 1 }]);
    expect(list[1].combat.held).toBe(false);
    expect(holdsConsistent(list)).toBe(true);
  });

  it('a hold either side of which is rung out ends', () => {
    const list = [fighter(0), fighter(0.9), fighter(3)];
    grab(list, 0, 1);
    list[1].active = false;
    expect(settleHolds(list)).toEqual([{ holder: 0, victim: 1 }]);
    expect(holdsConsistent(list)).toBe(true);
    list[1].active = true;
    for (const c of list) Object.assign(c.combat, createCombatState());
    grab(list, 0, 1);
    list[0].active = false;
    expect(settleHolds(list)).toEqual([{ holder: 0, victim: 1 }]);
    expect(list[1].combat.held).toBe(false);
  });

  it('a throw ends the pair; the thrown body may then be grabbed by another', () => {
    const list = [fighter(0), fighter(0.9), fighter(1.8, 0, west)];
    grab(list, 0, 1);
    release(list[0].combat, list[1].combat, east, { x: 0, z: 0 });
    expect(list[1].combat.holder).toBe(-1);
    expect(list[0].combat.victim).toBe(-1);
    expect(holdsConsistent(list)).toBe(true);
    // It tumbles from the throw; once it is up again, P3 may take it.
    startTumble(list[1].combat);
    expect(grabTarget(list, 2)).toBe(-1);
    for (let i = 0; i < 120; i++) tickCombat(list[1].combat, 1 / 60);
    expect(grabTarget(list, 2)).toBe(1);
    expect(grab(list, 2, 1)).toBe(true);
    expect(holdsConsistent(list)).toBe(true);
  });

  it('two grabbing the same body on the same frame: the first resolved wins, the second is refused', () => {
    const list = [fighter(-0.9, 0, east), fighter(0), fighter(0.9, 0, west)];
    expect(grabTarget(list, 0)).toBe(1);
    expect(grabTarget(list, 2)).toBe(1);
    expect(grab(list, 2, 1)).toBe(true);
    expect(grabTarget(list, 0)).toBe(-1);
    expect(grab(list, 0, 1)).toBe(false);
    expect(list[1].combat.holder).toBe(2);
    expect(holdsConsistent(list)).toBe(true);
  });

  it('the consistency check catches a body with two holders and a one-sided pair', () => {
    const list = [fighter(0), fighter(1), fighter(2)];
    list[0].combat.holding = 0;
    list[0].combat.victim = 1;
    list[1].combat.held = true;
    list[1].combat.holder = 0;
    expect(holdsConsistent(list)).toBe(true);
    list[2].combat.holding = 0;
    list[2].combat.victim = 1;
    expect(holdsConsistent(list)).toBe(false);
    endGrab(list[2].combat, createCombatState());
    list[1].combat.holder = 2;
    expect(holdsConsistent(list)).toBe(false);
  });
});

describe('contacts among several bodies', () => {
  const at = (x: number, z = 0) => ({ x, y: RUMBLE_BODY.capsuleCenterY, z });
  it('each body contests the nearest body it touches; a body out of the round touches nothing', () => {
    // A line of three touching: the middle one touches both, and contests the nearer.
    const line = [at(0), at(0.78), at(1.6), at(5)];
    expect(nearestContacts(line, PUSH.contactMargin)).toEqual([1, 0, 1, -1]);
    // Four in a tight square: everyone touches two, each contests its nearest.
    const square = [at(0, 0), at(0.82, 0), at(0, 0.8), at(0.82, 0.8)];
    expect(nearestContacts(square, PUSH.contactMargin)).toEqual([2, 3, 0, 1]);
    expect(nearestContacts([at(0), null, at(0.8)], PUSH.contactMargin)).toEqual([2, -1, 0]);
    expect(nearestContacts([at(0), at(0.8)].map((c, i) => (i === 1 ? null : c)), PUSH.contactMargin)).toEqual([-1, -1]);
  });
});
