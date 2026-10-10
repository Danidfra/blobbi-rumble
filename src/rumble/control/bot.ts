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
import { CLASSIC, arenaById, type ArenaDef } from '../arena/arenas';
import { onAnyFloor, rimDistanceOf, platformUnder } from '../arena/geometry';
import type { SweeperTuning } from '../arena/sweeper';
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
  /** M11A: the feet's height (platforms differ in height). */
  y: number;
  /** M11C: hanging from a ledge. */
  hanging: boolean;
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
  /** The sweeper's angle, or null where the arena has none. */
  sweeperAngle: number | null;
  grounded: boolean;
  /** M11A: the arena in play (its floor, its sweeper). */
  arena: ArenaDef;
}

/**
 * The world as a bot sees it, from a match snapshot: what anyone watching
 * the screen could know. `self` is the bot's own player id. The arena is
 * the snapshot's (the registry's definition for its id).
 */
export function botWorldFrom(s: MatchSnapshot, self: string): BotWorld {
  const fighters = s.fighters.map((f) => ({
    at: { x: f.position.x, z: f.position.z },
    y: f.position.y - RUMBLE_BODY.capsuleCenterY,
    hanging: f.ledge !== null,
    facing: { x: Math.sin(f.yaw), z: Math.cos(f.yaw) },
    active: !f.eliminated,
    combat: combatOf(f),
    powerLevel: f.powerLevel,
    holder: f.heldBy === null ? -1 : s.players.indexOf(f.heldBy),
  }));
  const i = s.players.indexOf(self);
  return { self: i, fighters, orbs: s.orbs, sweeperAngle: s.sweeper ? s.sweeper.angle : null, grounded: s.fighters[i].grounded, arena: arenaById(s.arena) ?? CLASSIC };
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
  /** M11A: where it was when it last got somewhere, whether it meant to move, how long it has been going nowhere, and what it gave up on. */
  lastAt: Planar | null;
  moving: boolean;
  stalled: number;
  stallJumps: number;
  avoid: number;
  avoidOrb: number;
  /** M11C: a leap across a gap: seconds left in it, its direction, and whether it has left the ground. */
  leap: number;
  leapDir: Planar;
  leapAir: boolean;
}

export const createBotMemory = (seed: number): BotMemory => ({ state: 'SEEK_FIGHTER', stateTime: Infinity, target: -1, retarget: 0, orb: -1, wait: 0, carry: 0, rng: (seed * 2654435761) >>> 0 || 1, heldFor: 0, strokeSide: 1, nextStroke: 0, lastStroke: 0, lastAt: null, moving: false, stalled: 0, stallJumps: 0, avoid: -1, avoidOrb: -1, leap: 0, leapDir: { x: 0, z: 0 }, leapAir: false });

/**
 * M11C: whether a gap ahead along `dir` is worth a leap: no floor at the
 * look-ahead, but a platform within reach that is not too high to land on
 * nor too low to come back from (a ledge catch climbs up to `leapDown`).
 */
export function gapAhead(at: Planar, y: number, dir: Planar, arena: ArenaDef, t = BOT): boolean {
  if (dir.x === 0 && dir.z === 0) return false;
  if (onAnyFloor(arena.platforms, { x: at.x + dir.x * t.lookAhead, z: at.z + dir.z * t.lookAhead }, t.safeInset)) return false;
  for (let d = 1.4; d <= t.leapReach + 1e-6; d += 0.2) {
    const p = { x: at.x + dir.x * d, z: at.z + dir.z * d };
    if (!onAnyFloor(arena.platforms, p, 0.25)) continue;
    const under = platformUnder(arena.platforms, p);
    if (under && under.y - y <= t.leapUp && y - under.y <= t.leapDown) return true;
  }
  return false;
}

/** The middle of what a fighter stands on (M11A: a platform's own centre, not the arena's, which may be a wall or a void away), or the arena's. */
export function homeOf(at: Planar, arena: ArenaDef): Planar {
  const under = platformUnder(arena.platforms, at);
  return under ? { x: under.x, z: under.z } : { x: 0, z: 0 };
}

/** The nearest other fighter in the round that is not `skip`, or -1. */
function nearestBut(w: BotWorld, skip: number): number {
  const me = w.fighters[w.self];
  let best = -1;
  let bestD = Infinity;
  w.fighters.forEach((f, j) => {
    if (j === w.self || j === skip || !f.active) return;
    const d = len(f.at.x - me.at.x, f.at.z - me.at.z);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  return best;
}

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
export function sweeperArrival(angle: number, p: Planar, capsuleRadius = 0.4, t: SweeperTuning = SWEEPER): number {
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
export function voidDirection(p: Planar, arena: ArenaDef = CLASSIC): Planar {
  let best = { x: 1, z: 0 };
  let bestD = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const d = { x: Math.cos(a), z: Math.sin(a) };
    let s = 0;
    while (s < 12 && onAnyFloor(arena.platforms, { x: p.x + d.x * s, z: p.z + d.z * s })) s += 0.2;
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
  const sw = w.arena.sweeper;
  w.orbs.forEach((o, i) => {
    if (!o.active) return;
    let c = len(o.x - me.at.x, o.z - me.at.z);
    if (sw && len(o.x - sw.pivot.x, o.z - sw.pivot.z) < sw.reach + 0.4) c += t.orbSweeperCost;
    if (rimDistanceOf(w.arena.platforms, o) < 1) c += t.orbRimCost;
    if (c < cost) {
      cost = c;
      orb = i;
    }
  });
  return { orb, cost };
}

/** Whether the way from `at` along `d` for `ahead` metres passes the sweeper's post with room for a capsule: the post is solid and stands on the right wing's main corridor. */
export function clearOfPost(at: Planar, d: Planar, ahead: number, t: SweeperTuning | null = SWEEPER): boolean {
  if (!t) return true;
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
export function aroundPost(at: Planar, dir: Planar, t: SweeperTuning | null = SWEEPER): Planar | null {
  if (!t) return null;
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
export function safeDirection(at: Planar, dir: Planar, ahead: number, t = BOT, arena: ArenaDef = CLASSIC, y?: number): Planar {
  if (dir.x === 0 && dir.z === 0) return dir;
  // Floor ahead: some platform, with room to the rim, and (M11A) not a drop it could not come back from.
  const floor = (d: Planar) => {
    const p = { x: at.x + d.x * ahead, z: at.z + d.z * ahead };
    if (!onAnyFloor(arena.platforms, p, t.safeInset)) return false;
    if (y === undefined) return true;
    const under = platformUnder(arena.platforms, p);
    return !!under && y - under.y <= t.maxDrop;
  };
  const safe = (d: Planar) => floor(d) && clearOfPost(at, d, ahead, arena.sweeper);
  // Up against the post and heading into it: slide round its side, the side nearer the goal.
  const around = aroundPost(at, dir, arena.sweeper);
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
  // M11C: on a ledge, climb at once (a bot never dangles).
  if (me.hanging) {
    m.stalled = 0;
    m.lastAt = null;
    return { ...NONE, jump: true };
  }
  // M11A: going nowhere while meaning to is a step, a crate or a wall in the way: a jump clears what can be cleared; what cannot is given up on.
  const moved = m.lastAt ? len(me.at.x - m.lastAt.x, me.at.z - m.lastAt.z) : Infinity;
  let stallJump = false;
  if (moved >= t.stallDistance || !m.moving || !w.grounded || me.combat.held) {
    m.lastAt = { x: me.at.x, z: me.at.z };
    m.stalled = 0;
  } else m.stalled += dt;
  if (m.stalled >= t.stallAfter) {
    m.stalled = 0;
    m.stallJumps += 1;
    // A jump is for a step up that is there to land on; at a rim or a gap it would be a jump into the void: give up at once instead.
    const up = platformUnder(w.arena.platforms, { x: me.at.x + me.facing.x * 0.8, z: me.at.z + me.facing.z * 0.8 });
    const stepUp = !!up && up.y > me.y + 0.1;
    if (!stepUp || m.stallJumps > t.stallGiveUp) {
      m.stallJumps = 0;
      if (m.state === 'SEEK_ORB') m.avoidOrb = m.orb;
      else m.avoid = m.target;
      m.retarget = 0;
      m.stateTime = Infinity;
    } else stallJump = true;
  }
  const r = decide(m, w, dt, t, c, stallJump);
  m.moving = r.x !== 0 || r.z !== 0;
  return r;
}

function decide(m: BotMemory, w: BotWorld, dt: number, t: typeof BOT, c: typeof COMBAT, stallJump: boolean): MoveIntent {
  const me = w.fighters[w.self];
  m.stateTime += dt;
  m.retarget -= dt;
  m.wait = Math.max(0, m.wait - dt);
  const jump = (w.grounded && !isHolding(me.combat) && canJumpSweeper(w, t)) || stallJump;
  const home = homeOf(me.at, w.arena);
  const toMiddle = unit(home.x - me.at.x, home.z - me.at.z);

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
    const out = voidDirection(me.at, w.arena);
    const facingOut = me.facing.x * out.x + me.facing.z * out.z;
    const nearRim = rimDistanceOf(w.arena.platforms, me.at) < t.throwRim;
    const victim = w.fighters.findIndex((f) => f.holder === w.self);
    const wriggling = victim >= 0 && w.fighters[victim].combat.struggle > t.throwOnStruggle;
    const lined = facingOut > (wriggling ? t.hurriedFacingCos : t.throwFacingCos);
    const throwIt = m.carry > t.carryMax || (m.carry > t.carryMin && nearRim && lined);
    if (throwIt) m.wait = t.hesitation;
    // Walk out only while the floor ahead allows; at the rim, turn to face out and let go.
    const step = rimDistanceOf(w.arena.platforms, me.at) > 1.2 ? out : { x: out.x * 0.3, z: out.z * 0.3 };
    return { ...NONE, x: step.x, z: step.z, grab: throwIt };
  }
  m.carry = 0;

  // M11C: mid-leap: keep running the way it was going, jump as the floor ends, and land before anything else matters.
  if (m.leap > 0) {
    m.leap -= dt;
    if (!w.grounded) m.leapAir = true;
    else if (m.leapAir) m.leap = 0;
    if (m.leap > 0) {
      const edge = !onAnyFloor(w.arena.platforms, { x: me.at.x + m.leapDir.x * 0.5, z: me.at.z + m.leapDir.z * 0.5 }, 0.05);
      return { ...NONE, x: m.leapDir.x, z: m.leapDir.z, run: true, jump: w.grounded && edge };
    }
  }
  // Too close to the rim with nothing holding it there: back toward the middle.
  if (rimDistanceOf(w.arena.platforms, me.at) < t.rimPanic) {
    enter(m, 'RECOVER');
    return { ...NONE, x: toMiddle.x, z: toMiddle.z, jump };
  }

  // Choose: the target (kept a while), an orb if it is cheaper, else the fight.
  if (m.retarget <= 0 || m.target < 0 || !w.fighters[m.target]?.active || m.target === w.self) {
    m.target = nearestFighter(w, Math.floor(nextRandom(m) * w.fighters.length));
    if (m.target === m.avoid) {
      const other = nearestBut(w, m.avoid);
      if (other >= 0) m.target = other;
    }
    m.avoid = -1;
    m.retarget = t.retargetEvery;
  }
  const target = m.target >= 0 ? w.fighters[m.target] : null;
  const toTarget = target ? len(target.at.x - me.at.x, target.at.z - me.at.z) : Infinity;
  let orb = bestOrb(w, t);
  if (orb.orb === m.avoidOrb) orb = { orb: -1, cost: Infinity };
  if (m.retarget <= 0) m.avoidOrb = -1;
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

  const leapToward = (want: Planar): MoveIntent | null => {
    if (!w.grounded || !gapAhead(me.at, me.y, want, w.arena, t)) return null;
    m.leap = t.leapTime;
    m.leapDir = want;
    m.leapAir = false;
    return { ...NONE, x: want.x, z: want.z, run: true };
  };
  if (m.state === 'SEEK_ORB' && m.orb >= 0 && w.orbs[m.orb]?.active) {
    const o = w.orbs[m.orb];
    const d = len(o.x - me.at.x, o.z - me.at.z);
    const want = unit(o.x - me.at.x, o.z - me.at.z);
    const leap = leapToward(want);
    if (leap) return leap;
    const dir = safeDirection(me.at, want, t.lookAhead, t, w.arena, me.y);
    return { ...NONE, x: dir.x, z: dir.z, run: d > t.runBeyond, jump };
  }
  if (!target) return { ...NONE, jump };
  const toward = unit(target.at.x - me.at.x, target.at.z - me.at.z);
  if (m.state !== 'ATTACK') {
    const leap = leapToward(toward);
    if (leap) return leap;
    const dir = safeDirection(me.at, toward, t.lookAhead, t, w.arena, me.y);
    return { ...NONE, x: dir.x, z: dir.z, run: toTarget > t.runBeyond, jump };
  }

  // ATTACK: lean in, and strike when facing the target in reach.
  const dir = safeDirection(me.at, toward, t.attackLookAhead, t, w.arena, me.y);
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
  if (w.sweeperAngle === null || !w.arena.sweeper) return false;
  const at = sweeperArrival(w.sweeperAngle, w.fighters[w.self].at, RUMBLE_BODY.capsuleRadius, w.arena.sweeper);
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
