/**
 * READING A SNAPSHOT: small pure helpers for anyone outside the match (the
 * client's views, the test bots) that want a fighter's state in the shapes
 * the gameplay predicates take. Reading only; nothing goes back.
 */
import { createCombatState, type CombatState } from '../combat/combat';
import type { FighterSnapshot } from './snapshot';

/** The combat state a snapshot shows, as the combat predicates (isTumbling, canAct, grabbable…) read it. */
export function combatOf(f: FighterSnapshot): CombatState {
  const c = createCombatState();
  c.punchTime = f.combat.punchTime;
  c.punchCooldown = f.combat.punchCooldown;
  c.stun = f.combat.stun;
  c.tumble = f.combat.tumble;
  c.recovering = f.combat.recovering;
  c.holding = f.combat.holdTime;
  c.holdAngle = f.combat.holdAngle;
  c.held = f.heldBy !== null;
  c.struggle = f.combat.struggle ?? 0;
  c.grabImmune = f.combat.grabImmune ?? 0;
  return c;
}
