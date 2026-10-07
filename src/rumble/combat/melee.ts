/**
 * EVERYONE AGAINST EVERYONE: whom an attack is aimed at among several
 * fighters, and who holds whom. Pure, over plain lists of combatants indexed
 * as the roster is.
 *
 * TARGETING. A punch or a grab has one target: of the fighters in the round
 * that the attack may take, those within its reach and its arc, the nearest
 * one; on an exact tie, the lower roster index. So one blow never lands on
 * two bodies, and which body it lands on never depends on anything but
 * where everyone stands.
 *
 * OWNERSHIP. A hold is a pair: the holder's `victim` and the victim's
 * `holder` name each other. A body that is held or holding cannot be
 * grabbed, so a body has one holder at most. Anything that ends a hold (a
 * throw, a hit on either of the two, a tumble, a ring-out, a reset) ends it
 * here, both sides at once.
 */
import { COMBAT } from '../tuning';
import { endGrab, grabbable, inReach, isHolding, type CombatState, type Planar, type Tuning } from './combat';

export interface Combatant {
  combat: CombatState;
  /** Capsule centre and facing in the ground plane. */
  at: Planar;
  facing: Planar;
  /** Still in the round. An eliminated fighter is never a target and never acts. */
  active: boolean;
}

/**
 * The one fighter an attack from `self` takes: valid, within `range` and the
 * arc of cosine `arcCos` about the attacker's facing, nearest; the lower
 * index on an exact tie. -1 when there is none.
 */
export function pickTarget(list: readonly Combatant[], self: number, range: number, arcCos: number, valid: (c: Combatant, index: number) => boolean = (c) => c.active): number {
  const me = list[self];
  let best = -1;
  let bestD = Infinity;
  list.forEach((c, j) => {
    if (j === self || !c.active || !valid(c, j)) return;
    if (!inReach(me.at, me.facing, c.at, range, arcCos)) return;
    const d = Math.hypot(c.at.x - me.at.x, c.at.z - me.at.z);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  return best;
}

/** Whom a punch from `self` lands on: any fighter in the round, held or holding or down. */
export const punchTarget = (list: readonly Combatant[], self: number, t: Tuning = COMBAT) => (list[self].active ? pickTarget(list, self, t.punchRange, t.punchArcCos) : -1);

/** Whom a grab from `self` takes: the nearest GRABBABLE fighter in reach (a held, holding or downed one is passed over for the next). */
export const grabTarget = (list: readonly Combatant[], self: number, t: Tuning = COMBAT) => (list[self].active ? pickTarget(list, self, t.grabRange, t.grabArcCos, (c) => grabbable(c.combat)) : -1);

/** A hold that ended: the scene gives the victim its weight back. */
export interface Hold {
  holder: number;
  victim: number;
}

/** End every hold `index` is part of, as holder or as victim. Returns the holds that ended. */
export function freeHolds(list: readonly Combatant[], index: number): Hold[] {
  const ended: Hold[] = [];
  const me = list[index].combat;
  if (me.victim >= 0) {
    ended.push({ holder: index, victim: me.victim });
    endGrab(me, list[me.victim].combat);
  } else if (isHolding(me)) me.holding = -1;
  if (me.holder >= 0) {
    ended.push({ holder: me.holder, victim: index });
    endGrab(list[me.holder].combat, me);
  } else me.held = false;
  return ended;
}

/**
 * Keep every hold a true pair: a holder that stopped holding (it tumbled),
 * and a hold either side of which has left the round, ends here. Run once a
 * frame; returns the holds that ended.
 */
export function settleHolds(list: readonly Combatant[]): Hold[] {
  const ended: Hold[] = [];
  list.forEach((c, i) => {
    const v = c.combat.victim;
    if (v < 0) return;
    const victim = list[v];
    if (!isHolding(c.combat) || !c.active || !victim.active || victim.combat.holder !== i) {
      ended.push({ holder: i, victim: v });
      endGrab(c.combat, victim.combat);
    }
  });
  return ended;
}

/** Whether the holds are consistent: every pair names each other, and no body has two holders. For tests and the debug HUD. */
export function holdsConsistent(list: readonly Combatant[]): boolean {
  const owners = new Map<number, number>();
  for (let i = 0; i < list.length; i++) {
    const c = list[i].combat;
    if (c.victim >= 0) {
      if (owners.has(c.victim)) return false;
      owners.set(c.victim, i);
      const v = list[c.victim].combat;
      if (v.holder !== i || !v.held || !isHolding(c)) return false;
      if (c.victim === i) return false;
    }
    if (c.holder >= 0 && list[c.holder].combat.victim !== i) return false;
    if (c.held && c.holder < 0) return false;
    if (c.victim >= 0 && c.held) return false;
  }
  return true;
}
