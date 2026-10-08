/**
 * A LOCAL TEST BOT: the smallest opponent that keeps a four-Blobbi arena
 * busy while two people play. It reads the arena as plain numbers and
 * answers with the same `MoveIntent` a keyboard gives, so its fighter has
 * exactly the body, combat and power of a person's: no bonus, no cheat, no
 * knowledge a player could not have from looking at the screen.
 *
 * A few states, chosen by distances and kept for a moment:
 *
 *   SEEK_ORB      an orb is cheaper to reach than the target is near
 *   SEEK_FIGHTER  walk (or run) to the chosen target
 *   ATTACK        in range: punch, or now and then grab
 *   CARRY         holding someone: walk them to the nearest void and throw
 *                 (hurried, if they are wriggling free)
 *   STRUGGLE      held: reverse its movement in a person's rhythm to break free
 *   RECOVER       down, stunned or near the rim: head for the middle
 *
 * Over every state: a look-ahead that turns away from the void, and a jump
 * when the sweeper's leading face is about to arrive. Its only "chance" is
 * a seeded sequence, so a bot given the same world does the same thing.
 * Pure: the scene builds the world view each frame and applies the intent.
 */
import { onFloor, rimDistance } from '../arena/layout';
import { canAct, grabbable, isDown, isHolding, isStunned, type CombatState, type Planar } from '../combat/combat';
import { powerCap } from '../pickups/power';
import { RUMBLE_BODY } from '../profile';
import { COMBAT, BOT, SWEEPER } from '../tuning';
import type { IntentSource } from './input';
import type { PlayerIntent as MoveIntent } from '../sim/intent';
import type { MatchSnapshot } from '../sim/snapshot';
import { combatOf } from '../sim/read';

export type BotState = 'SEEK_ORB' | 'SEEK_FIGHTER' | 'ATTACK' | 'CARRY' | 'RECOVER' | 'STRUGGLE';

export interface BotFighter {
  at: Planar;
  facing: Planar;
  /** Still in the round. */
  active: boolean;
  combat: CombatState;
  powerLevel: number;
  /** Who holds it (a fighter index), or -1. */
  holder: number;
}

export interface BotWorld {
  self: number;
  fighters: readonly BotFighter[];
  orbs: readonly { x: number; z: number; active: boolean }[];
  sweeperAngle: number;
  grounded: boolean;
}

/**
 * The world as a bot sees it, from a match snapshot: what anyone watching
 * the screen could know. `self` is the bot's own player id.
 */
export function botWorldFrom(s: MatchSnapshot, self: string): BotWorld {
  const fighters = s.fighters.map((f) => ({
    at: { x: f.position.x, z: f.position.z },
    facing: { x: Math.sin(f.yaw), z: Math.cos(f.yaw) },
    active: !f.eliminated,
    combat: combatOf(f),
    powerLevel: f.powerLevel,
    holder: f.heldBy === null ? -1 : s.players.indexOf(f.heldBy),
  }));
  const i = s.players.indexOf(self);
  return { self: i, fighters, orbs: s.orbs, sweeperAngle: s.sweeper.angle, grounded: s.fighters[i].grounded };
}

export interface BotMemory {
  state: BotState;
  /** Seconds in the current state. */
  stateTime: number;
  /** The fighter it is after, and how long until it looks again. */
  target: number;
  retarget: number;
  /** The orb it is after, or -1. */
  orb: number;
  /** Seconds before it may attack again. */
  wait: number;
  /** Seconds it has been carrying. */
  carry: number;
  /** The seeded sequence. */
  rng: number;
  /** Held: seconds held so far, the side of the current stroke (±1), and seconds until the next one. */
  heldFor: number;
  strokeSide: number;
  nextStroke: number;
  /** The side last pushed (0: none). */
  lastStroke: number;
}

export const createBotMemory = (seed: number): BotMemory => ({ state: 'SEEK_FIGHTER', stateTime: Infinity, target: -1, retarget: 0, orb: -1, wait: 0, carry: 0, rng: (seed * 2654435761) >>> 0 || 1, heldFor: 0, strokeSide: 1, nextStroke: 0, lastStroke: 0 });

/** The next number of the sequence, in [0, 1). */
export function nextRandom(m: BotMemory): number {
  // xorshift32: small, fast, and the same everywhere.
  let x = m.rng;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  m.rng = x || 1;
  return m.rng / 4294967296;
}

const NONE: MoveIntent = { x: 0, z: 0, run: false, jump: false, punch: false, grab: false };
const len = (x: number, z: number) => Math.hypot(x, z);
const unit = (x: number, z: number): Planar => {
  const l = len(x, z);
  return l > 1e-6 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
};

/**
 * Seconds until the sweeper's leading face reaches a capsule at `p`
 * (negative while the bar is on it), or Infinity when the bar cannot reach
 * it. The bar turns at a constant rate, so this is an angle over a speed.
 */
export function sweeperArrival(angle: number, p: Planar, capsuleRadius = 0.4, t = SWEEPER): number {
  const rx = p.x - t.pivot.x;
  const rz = p.z - t.pivot.z;
  const r = len(rx, rz);
  if (r > t.reach + capsuleRadius || r < 1e-6) return Infinity;
  // In the plane's own angles (atan2(z, x)) the bar's arms lie at -angle and -angle + π, and turn the negative way.
  const psi = Math.atan2(rz, rx);
  let remaining = (-angle - psi) % Math.PI;
  if (remaining < 0) remaining += Math.PI;
  const face = (t.halfWidth + capsuleRadius + t.hitMargin) / r;
  return (remaining - face) / t.angularSpeed;
}

/** The direction from `p` to the nearest void, by marching a few directions until the floor ends. */
export function voidDirection(p: Planar): Planar {
  let best = { x: 1, z: 0 };
  let bestD = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const d = { x: Math.cos(a), z: Math.sin(a) };
    let s = 0;
    while (s < 8 && onFloor({ x: p.x + d.x * s, z: p.z + d.z * s })) s += 0.2;
    if (s < bestD) {
      bestD = s;
      best = d;
    }
  }
  return best;
}

/**
 * The nearest other fighter in the round, or -1. Near-ties (within a few
 * centimetres, as from the symmetric spawns) go to the first in a seat
 * order that starts `offset` seats after its own; the bot draws that offset
 * from its seeded sequence, so from the symmetric start the bots spread over
 * different targets round to round instead of every one of them starting
 * on P1 and P2, as a plain lowest-index rule would have them.
 */
export function nearestFighter(w: BotWorld, offset = 0, tie = 0.05): number {
  const me = w.fighters[w.self];
  const n = w.fighters.length;
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < n; k++) {
    const j = (w.self + 1 + offset + k) % n;
    const f = w.fighters[j];
    if (j === w.self || !f.active) continue;
    const d = len(f.at.x - me.at.x, f.at.z - me.at.z);
    if (d < bestD - tie) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

/** The orb worth going for, and what it costs (its distance, more inside the sweeper or near a rim); -1 when none, or when more power would change nothing. */
export function bestOrb(w: BotWorld, t = BOT): { orb: number; cost: number } {
  const me = w.fighters[w.self];
  if (me.powerLevel >= powerCap()) return { orb: -1, cost: Infinity };
  let orb = -1;
  let cost = Infinity;
  w.orbs.forEach((o, i) => {
    if (!o.active) return;
    let c = len(o.x - me.at.x, o.z - me.at.z);
    if (len(o.x - SWEEPER.pivot.x, o.z - SWEEPER.pivot.z) < SWEEPER.reach + 0.4) c += t.orbSweeperCost;
    if (rimDistance(o) < 1) c += t.orbRimCost;
    if (c < cost) {
      cost = c;
      orb = i;
    }
  });
  return { orb, cost };
}

/** Whether the way from `at` along `d` for `ahead` metres passes the sweeper's post with room for a capsule: the post is solid and stands on the right wing's main corridor. */
export function clearOfPost(at: Planar, d: Planar, ahead: number, t = SWEEPER): boolean {
  const px = t.pivot.x - at.x;
  const pz = t.pivot.z - at.z;
  const along = Math.max(0, Math.min(ahead, px * d.x + pz * d.z));
  return Math.hypot(px - d.x * along, pz - d.z * along) >= t.postRadius + RUMBLE_BODY.capsuleRadius + 0.1;
}

/**
 * Beside the post (within a step of touching it) and heading into it: the
 * tangent round it on the side nearer `dir`, a little outward; null when
 * the post is not in the way.
 */
export function aroundPost(at: Planar, dir: Planar, t = SWEEPER): Planar | null {
  const px = t.pivot.x - at.x;
  const pz = t.pivot.z - at.z;
  const d = Math.hypot(px, pz);
  const touching = t.postRadius + RUMBLE_BODY.capsuleRadius;
  if (d > touching + 0.45 || d < 1e-6) return null;
  if ((px * dir.x + pz * dir.z) / d <= 0.2) return null;
  const a = { x: -pz / d, z: px / d };
  const b = { x: pz / d, z: -px / d };
  const side = a.x * dir.x + a.z * dir.z >= b.x * dir.x + b.z * dir.z ? a : b;
  return unit(side.x - (px / d) * 0.3, side.z - (pz / d) * 0.3);
}

/**
 * Turn a wanted direction away from the void and the post: if the floor is
 * not there a little ahead (with `safeInset` to spare from the outer rim;
 * the seams between the centre and the wings are floor), or the way runs
 * into the sweeper's post, the nearest turn of it (30°, then 60°, either
 * way) that is clear, so it edges along a rim or round the post toward its
 * goal instead of flipping between the goal and the middle; and only if
 * none is, the middle.
 */
export function safeDirection(at: Planar, dir: Planar, ahead: number, t = BOT): Planar {
  if (dir.x === 0 && dir.z === 0) return dir;
  const floor = (d: Planar) => onFloor({ x: at.x + d.x * ahead, z: at.z + d.z * ahead }, t.safeInset);
  const safe = (d: Planar) => floor(d) && clearOfPost(at, d, ahead);
  // Up against the post and heading into it: slide round its side, the side nearer the goal.
  const around = aroundPost(at, dir);
  if (around && floor(around)) return around;
  if (safe(dir)) return dir;
  for (const a of [0.52, -0.52, 1.05, -1.05]) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const turned = { x: dir.x * c - dir.z * s, z: dir.x * s + dir.z * c };
    if (safe(turned)) return turned;
  }
  return unit(-at.x, -at.z);
}

function enter(m: BotMemory, s: BotState) {
  if (m.state !== s) {
    m.state = s;
    m.stateTime = 0;
  }
}

/** One frame of the bot: update its memory and say what it does. */
export function think(m: BotMemory, w: BotWorld, dt: number, t = BOT, c = COMBAT): MoveIntent {
  const me = w.fighters[w.self];
  if (!me.active) return NONE;
  m.stateTime += dt;
  m.retarget -= dt;
  m.wait = Math.max(0, m.wait - dt);
  const jump = w.grounded && !isHolding(me.combat) && canJumpSweeper(w, t);
  const toMiddle = unit(-me.at.x, -me.at.z);

  // Held: struggle. A moment to react, then strokes side to side in a person's rhythm, now and then fumbled.
  if (me.combat.held) {
    enter(m, 'STRUGGLE');
    m.carry = 0;
    if (m.heldFor === 0) m.nextStroke = t.struggleReaction + nextRandom(m) * t.struggleReactionJitter;
    m.heldFor += dt;
    m.nextStroke -= dt;
    if (m.heldFor < t.struggleReaction) return NONE;
    if (m.nextStroke <= 0) {
      if (nextRandom(m) >= t.fumble) m.strokeSide = -m.strokeSide;
      m.nextStroke = t.strokeTime + nextRandom(m) * t.strokeJitter;
      // A fumble repeats the side: lift off for a step so it is a stroke at all (and one that does not count).
      if (m.strokeSide === m.lastStroke) {
        m.lastStroke = 0;
        return NONE;
      }
    }
    m.lastStroke = m.strokeSide;
    return { ...NONE, x: m.strokeSide };
  }
  m.heldFor = 0;
  m.lastStroke = 0;

  // Down or stunned: whatever control is left goes toward the middle.
  if (isDown(me.combat) || isStunned(me.combat)) {
    enter(m, 'RECOVER');
    m.carry = 0;
    return { ...NONE, x: toMiddle.x, z: toMiddle.z };
  }

  // Carrying: to the nearest void, then the throw.
  if (isHolding(me.combat)) {
    enter(m, 'CARRY');
    m.carry += dt;
    const out = voidDirection(me.at);
    const facingOut = me.facing.x * out.x + me.facing.z * out.z;
    const nearRim = rimDistance(me.at) < t.throwRim;
    const victim = w.fighters.findIndex((f) => f.holder === w.self);
    const wriggling = victim >= 0 && w.fighters[victim].combat.struggle > t.throwOnStruggle;
    const lined = facingOut > (wriggling ? t.hurriedFacingCos : t.throwFacingCos);
    const throwIt = m.carry > t.carryMax || (m.carry > t.carryMin && nearRim && lined);
    if (throwIt) m.wait = t.hesitation;
    // Walk out only while the floor ahead allows; at the rim, turn to face out and let go.
    const step = rimDistance(me.at) > 1.2 ? out : { x: out.x * 0.3, z: out.z * 0.3 };
    return { ...NONE, x: step.x, z: step.z, grab: throwIt };
  }
  m.carry = 0;

  // Too close to the rim with nothing holding it there: back toward the middle.
  if (rimDistance(me.at) < t.rimPanic) {
    enter(m, 'RECOVER');
    return { ...NONE, x: toMiddle.x, z: toMiddle.z, jump };
  }

  // Choose: the target (kept a while), an orb if it is cheaper, else the fight.
  if (m.retarget <= 0 || m.target < 0 || !w.fighters[m.target]?.active || m.target === w.self) {
    m.target = nearestFighter(w, Math.floor(nextRandom(m) * w.fighters.length));
    m.retarget = t.retargetEvery;
  }
  const target = m.target >= 0 ? w.fighters[m.target] : null;
  const toTarget = target ? len(target.at.x - me.at.x, target.at.z - me.at.z) : Infinity;
  const orb = bestOrb(w, t);
  if (m.stateTime >= t.minStateTime || m.state === 'RECOVER' || m.state === 'CARRY' || (m.state === 'SEEK_ORB' && !w.orbs[m.orb]?.active)) {
    if (orb.orb >= 0 && orb.cost < toTarget + t.orbBias) {
      enter(m, 'SEEK_ORB');
      m.orb = orb.orb;
    } else if (target) enter(m, toTarget < t.engageRange ? 'ATTACK' : 'SEEK_FIGHTER');
    else enter(m, orb.orb >= 0 ? 'SEEK_ORB' : 'SEEK_FIGHTER');
    if (m.state === 'SEEK_ORB') m.orb = orb.orb;
  }
  // Close enough to fight now: no waiting out the state timer.
  if (m.state === 'SEEK_FIGHTER' && toTarget < t.engageRange) enter(m, 'ATTACK');

  if (m.state === 'SEEK_ORB' && m.orb >= 0 && w.orbs[m.orb]?.active) {
    const o = w.orbs[m.orb];
    const d = len(o.x - me.at.x, o.z - me.at.z);
    const dir = safeDirection(me.at, unit(o.x - me.at.x, o.z - me.at.z), t.lookAhead, t);
    return { ...NONE, x: dir.x, z: dir.z, run: d > t.runBeyond, jump };
  }
  if (!target) return { ...NONE, jump };
  const toward = unit(target.at.x - me.at.x, target.at.z - me.at.z);
  if (m.state !== 'ATTACK') {
    const dir = safeDirection(me.at, toward, t.lookAhead, t);
    return { ...NONE, x: dir.x, z: dir.z, run: toTarget > t.runBeyond, jump };
  }

  // ATTACK: lean in, and strike when facing the target in reach.
  const dir = safeDirection(me.at, toward, t.attackLookAhead, t);
  const facingIt = me.facing.x * toward.x + me.facing.z * toward.z;
  let punch = false;
  let grab = false;
  if (m.wait <= 0 && canAct(me.combat) && me.combat.punchCooldown <= 0 && facingIt >= t.punchArcCos) {
    if (toTarget <= c.grabRange && grabbable(target.combat) && nextRandom(m) < t.grabShare) grab = true;
    else if (toTarget <= c.punchRange * t.punchReach) punch = true;
    if (punch || grab) m.wait = t.hesitation + nextRandom(m) * t.hesitationJitter;
  }
  return { ...NONE, x: dir.x, z: dir.z, punch, grab, jump };
}

/** Whether to jump now: the sweeper's leading face is about to reach this capsule. */
function canJumpSweeper(w: BotWorld, t = BOT): boolean {
  const at = sweeperArrival(w.sweeperAngle, w.fighters[w.self].at);
  return at >= t.jumpWindow.from && at <= t.jumpWindow.to;
}

/**
 * A bot as an intent source: the scene lets it `plan` from the world each
 * frame, and the fighter `read`s the result like a keyboard's. Its actions
 * fire once, as a key press does. Its sequence restarts every round from a
 * seed of its own and the round's number: rounds differ from each other,
 * and the same round played the same way goes the same way.
 */
export class BotInput implements IntentSource {
  enabled = true;
  readonly memory: BotMemory;
  private intent: MoveIntent = NONE;

  constructor(private readonly seed: number) {
    this.memory = createBotMemory(seed);
  }

  plan(w: BotWorld, dt: number) {
    this.intent = this.enabled ? think(this.memory, w, dt) : NONE;
  }

  read(): MoveIntent {
    const out = this.enabled ? this.intent : NONE;
    this.intent = { ...this.intent, jump: false, punch: false, grab: false };
    return out;
  }

  reset(round = 1) {
    Object.assign(this.memory, createBotMemory(this.seed + round * 7919));
    this.intent = NONE;
  }
}
