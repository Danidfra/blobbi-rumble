/**
 * THE AUTHORITATIVE MATCH: one Rumble match, whole, with no renderer, no
 * DOM, no keyboard and no clock of its own. It owns the fighters' gameplay
 * bodies in a Havok world, their intents, combat, holds, power, the arena's
 * collision, the sweeper, the orbs, eliminations, rounds, scores and the
 * match's outcome.
 *
 *   producers (keys, bots, later the network) ──setInput(id, intent)──►
 *   RumbleMatch.step(dt) ──► events (what it decided) + snapshot() (plain data)
 *   ──► clients draw
 *
 * Input producers only REQUEST: a direction, a gait, a jump, a punch, a
 * grab. The match decides what happens: where bodies go, whom a punch or a
 * grab takes and whether it lands, throws, who collects an orb, whom the
 * sweeper strikes, tumbles, ring-outs, the round's winner, the score and
 * the match's winner.
 *
 * Time passes only through `step(dt)`, by exactly `dt`: the browser calls it
 * from its frame loop with the frame's (clamped) delta, as the game always
 * has; tests and a future server call it with a fixed dt. Fighters are
 * named by stable match-local ids; roster order is an internal detail.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { spawnPoints, type FighterCount } from '../arena/layout';
import { createSweeper, resetSweeper, sweeperHit, tickSweeper } from '../arena/sweeper';
import { endGrab, holdBreaks, holdPull, isHolding, isTumbling, landPunch, punchActive, release, tickCombat, tryGrab, type Reaction } from '../combat/combat';
import { freeHolds, grabTarget, holdsConsistent, punchTarget, settleHolds, type Combatant, type Hold } from '../combat/melee';
import { collectOrbs, createOrbs, resetOrbs, tickOrbs } from '../pickups/orbs';
import { nearestContacts } from '../physics/contact';
import { RUMBLE_BODY } from '../profile';
import { aliveCount, createMatch, matchWinner, restartMatch, ringOut, tickMatch, type MatchState } from '../rounds';
import { COMBAT, PUSH, ROUND, SWEEPER } from '../tuning';
import { createArenaBody } from './arenaBody';
import { FighterSim, type PlayerId, type StepResult } from './fighter';
import { IDLE_INTENT, sanitizeIntent, type PlayerIntent } from './intent';
import { createPhysicsWorld, type HavokInstance, type PhysicsWorld } from './physics';
import type { MatchEvent, MatchSnapshot } from './snapshot';
import { SweeperBody } from './sweeperBody';

export interface RumbleMatchConfig {
  havok: HavokInstance;
  /** 2 to 4 players, in roster order (which decides the spawn). Ids must be unique. */
  players: readonly { id: PlayerId }[];
}

export class RumbleMatch {
  readonly ids: readonly PlayerId[];
  /** The physics world, for debug tooling and scripted checks only; clients draw from snapshots. */
  readonly world: PhysicsWorld;
  private readonly fighters: FighterSim[];
  private readonly index = new Map<PlayerId, number>();
  private readonly match: MatchState;
  private readonly orbs = createOrbs();
  private readonly sweeper;
  private readonly sweeperBody: SweeperBody;
  private readonly arena: { dispose(): void };
  /** Each player's current movement intent, and the action requests waiting for the next step. */
  private readonly intents: PlayerIntent[];
  private readonly pending: { jump: boolean; punch: boolean; grab: boolean }[];
  private readonly wasTouching: boolean[];
  private lastIntents: PlayerIntent[];
  private contacts: number[];
  private events: MatchEvent[] = [];
  private tickCount = 0;
  private clock = 0;

  constructor(config: RumbleMatchConfig) {
    const n = config.players.length;
    if (n < 2 || n > 4) throw new Error(`a match has 2 to 4 players, not ${n}`);
    this.ids = config.players.map((p) => p.id);
    this.ids.forEach((id, i) => {
      if (this.index.has(id)) throw new Error(`duplicate player id ${id}`);
      this.index.set(id, i);
    });
    this.world = createPhysicsWorld(config.havok, RUMBLE_BODY.gravity);
    this.arena = createArenaBody(this.world.scene);
    const spawns = spawnPoints(n as FighterCount);
    this.fighters = this.ids.map((id, i) => new FighterSim(id, this.world.scene, new Vector3(spawns[i].x, 0, spawns[i].z), spawns[i].yaw));
    this.sweeper = createSweeper(n);
    this.sweeperBody = new SweeperBody(this.world.scene);
    this.match = createMatch(n);
    this.intents = this.ids.map(() => ({ ...IDLE_INTENT }));
    this.pending = this.ids.map(() => ({ jump: false, punch: false, grab: false }));
    this.wasTouching = Array(n).fill(false);
    this.lastIntents = this.ids.map(() => ({ ...IDLE_INTENT }));
    this.contacts = Array(n).fill(-1);
  }

  get tick() {
    return this.tickCount;
  }
  get time() {
    return this.clock;
  }

  /**
   * A player's latest intent. Movement holds until replaced; an action
   * request waits for the next step, which takes it once (two intents
   * before one step never lose a press). Requests are taken even while the
   * player may not act (between rounds, eliminated), and dropped: none
   * queue up.
   */
  setInput(id: PlayerId, intent: Partial<PlayerIntent>) {
    const i = this.indexOf(id);
    const clean = sanitizeIntent(intent);
    this.intents[i] = { ...clean, jump: false, punch: false, grab: false };
    const p = this.pending[i];
    p.jump ||= clean.jump;
    p.punch ||= clean.punch;
    p.grab ||= clean.grab;
  }

  /**
   * Forget a player's intent entirely: no movement held, no request waiting.
   * For whoever hands a fighter from one producer to another (a person
   * leaving, a bot taking over), so nothing of the last one carries on.
   */
  clearInput(id: PlayerId) {
    const i = this.indexOf(id);
    this.intents[i] = { ...IDLE_INTENT };
    this.pending[i] = { jump: false, punch: false, grab: false };
  }

  /** Start a new match: scores, rounds and everything on the arena back to the start. */
  restart(): MatchEvent[] {
    this.events = [];
    restartMatch(this.match);
    this.resetRound();
    this.emit({ kind: 'newMatch', who: null });
    return this.events;
  }

  /**
   * Scripted checks and tests only (never a client in play): put a fighter
   * somewhere, upright and at rest, facing `yaw`, optionally with a power
   * level.
   */
  debugPlace(id: PlayerId, at: { x: number; z: number; yaw?: number; powerLevel?: number }) {
    const f = this.fighters[this.indexOf(id)];
    f.body.teleport(new Vector3(at.x, 0, at.z));
    if (at.yaw !== undefined) f.yaw = at.yaw;
    if (at.powerLevel !== undefined) f.powerLevel = at.powerLevel;
  }

  /** Whether every hold is a true pair, nobody with two holders (for tests and the debug HUD). */
  holdsConsistent(): boolean {
    return holdsConsistent(this.combatants());
  }

  /** Advance the match by `dt` seconds. Returns what it decided during the step. */
  step(dt: number): MatchEvent[] {
    this.events = [];
    this.clock += dt;
    this.tickCount += 1;
    const fighters = this.fighters;
    const n = fighters.length;
    const playing = this.match.phase === 'playing';
    // This step's intents: the held movement plus the waiting requests, which are taken now whether or not they may act.
    const intents = fighters.map((f, i) => {
      const p = this.pending[i];
      const intent = { ...this.intents[i], ...p };
      p.jump = p.punch = p.grab = false;
      return playing && !f.eliminated ? intent : { ...IDLE_INTENT };
    });
    for (const f of fighters) if (!f.eliminated) tickCombat(f.combat, dt);

    // Body against body: each touching fighter's pushing contest is with the nearest body it touches.
    const centres = fighters.map((f) => (f.eliminated ? null : f.body.position()));
    const contacts = nearestContacts(centres, PUSH.contactMargin);
    this.contacts = contacts;
    fighters.forEach((f, i) => {
      const touching = contacts[i] >= 0;
      if (touching !== this.wasTouching[i]) {
        this.wasTouching[i] = touching;
        f.body.setFriction(touching ? PUSH.contactFriction : RUMBLE_BODY.friction);
      }
    });

    // Steering. A shoving match is two touching fighters pushing into each other (read from the last step's intents: one step late, never wrong by much).
    const results: StepResult[] = fighters.map((f, i) => {
      if (f.eliminated) return { grounded: false, jumped: false };
      const j = contacts[i];
      if (j < 0) return f.update(dt, intents[i]);
      const a = centres[i]!;
      const b = centres[j]!;
      const span = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const toward = { x: (b.x - a.x) / span, z: (b.z - a.z) / span };
      const mine = this.lastIntents[i];
      const theirs = this.lastIntents[j];
      const shoving = mine.x * toward.x + mine.z * toward.z > 0.3 && -(theirs.x * toward.x + theirs.z * toward.z) > 0.3;
      return f.update(dt, intents[i], { gain: PUSH.gain, brakeGain: PUSH.brakeGain, authority: f.pushAuthority, toward, shoving, headOnCos: PUSH.headOnCos });
    });
    this.lastIntents = intents;
    results.forEach((r, i) => {
      if (r.jumped) this.emit({ kind: 'jump', who: this.ids[i] });
    });

    if (playing) {
      // Attacks resolve one fighter at a time; the first to act turns round with the steps, so no seat always wins a simultaneous grab.
      const list = this.combatants();
      for (let k = 0; k < n; k++) {
        const i = (k + this.tickCount) % n;
        this.interact(list, i, intents[i], dt);
      }
    }
    // Every hold stays a true pair (a holder that tumbled lets go here).
    this.dropped(settleHolds(this.combatants()));

    // Orbs: taken by whoever reaches one (the nearest), back after a while where no one stands.
    const bodies = fighters.map((f) => (f.eliminated ? null : f.body.position()));
    if (playing) {
      collectOrbs(this.orbs, bodies).forEach((taker, i) => {
        if (taker < 0) return;
        fighters[taker].gainPower();
        this.emit({ kind: 'orb', who: this.ids[taker], orb: i, note: `level ${fighters[taker].powerLevel}` });
      });
    }
    tickOrbs(this.orbs, dt, bodies);

    // The sweeper turns; a fighter under its leading face takes its blow, through the same reaction as a punch (no player power in it).
    tickSweeper(this.sweeper, dt);
    this.sweeperBody.apply(this.sweeper);
    if (playing) {
      const list = this.combatants();
      fighters.forEach((f, i) => {
        if (f.eliminated) return;
        const hit = sweeperHit(this.sweeper, i, f.body.position(), RUMBLE_BODY.capsuleRadius, RUMBLE_BODY.capsuleCenterY);
        if (!hit) return;
        this.strike(list, i, hit.reaction, -1);
        this.emit({ kind: 'sweeper', who: this.ids[i], reaction: hit.reaction.kind, impact: hit.reaction.impact, note: `at ${hit.along.toFixed(2)} m (${hit.speed.toFixed(2)} m/s)` });
      });
    }
    for (const f of fighters) if (!f.eliminated) f.settle();
    // The facing follows the velocity (a carrier's only by its own steering).
    fighters.forEach((f, i) => {
      if (!f.eliminated) f.turn(dt, intents[i].x !== 0 || intents[i].z !== 0);
    });

    // Ring-outs: who crossed the fall line this step. Each is out of the round: its holds end, its body leaves play.
    const fell = fighters.map((f) => !f.eliminated && f.checkFall(dt));
    if (fell.some(Boolean)) {
      const list = this.combatants();
      fell.forEach((out, i) => {
        if (!out) return;
        this.dropped(freeHolds(list, i));
        if (this.match.phase === 'playing') {
          fighters[i].eliminate(new Vector3(i * 3, -40, 0));
          this.emit({ kind: 'out', who: this.ids[i], note: `${aliveCount(this.match) - 1} left` });
        }
      });
      if (ringOut(this.match, fell)) {
        const w = this.match.lastWinner;
        this.emit({ kind: 'round', who: w === null ? null : this.ids[w], note: w === null ? 'draw' : 'win' });
      }
    }
    const ended = tickMatch(this.match, dt);
    if (ended === 'round') {
      this.resetRound();
      this.emit({ kind: 'newRound', who: null });
    } else if (ended === 'over') {
      // The arena settles: everyone back at their spawns, at rest, until a restart.
      this.resetRound();
      const w = matchWinner(this.match);
      this.emit({ kind: 'match', who: w === null ? null : this.ids[w] });
    }

    this.world.step(dt);
    return this.events;
  }

  /** The match as plain data. */
  snapshot(): MatchSnapshot {
    const m = this.match;
    const idOf = (i: number) => (i >= 0 ? this.ids[i] : null);
    const winner = matchWinner(m);
    return {
      tick: this.tickCount,
      time: this.clock,
      players: [...this.ids],
      fighters: this.fighters.map((f, i) => {
        const p = f.body.position();
        const q = f.body.rotation();
        const v = f.body.velocity();
        const c = f.combat;
        return {
          id: f.id,
          position: { x: p.x, y: p.y, z: p.z },
          rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
          upright: f.body.isUpright(),
          yaw: f.yaw,
          velocity: { x: v.x, y: v.y, z: v.z },
          grounded: f.grounded,
          alive: m.alive[i],
          eliminated: f.eliminated,
          score: m.score[i],
          powerLevel: f.powerLevel,
          combat: { punchTime: c.punchTime, punchCooldown: c.punchCooldown, stun: c.stun, tumble: c.tumble, recovering: c.recovering, holdTime: c.holding, holdAngle: c.holdAngle },
          holding: idOf(c.victim),
          heldBy: idOf(c.holder),
          touching: idOf(this.contacts[i]),
          tilt: f.tilt,
          lastImpact: f.lastImpact,
          hits: f.hits,
          jumps: f.jumps,
        };
      }),
      phase: m.phase,
      round: m.round,
      roundTimer: m.timer,
      target: ROUND.target,
      lastRoundWinner: idOf(m.lastWinner ?? -1),
      matchWinner: winner === null ? null : this.ids[winner],
      orbs: this.orbs.map((o) => ({ x: o.x, y: o.y, z: o.z, active: o.active, timer: o.timer })),
      sweeper: { angle: this.sweeper.angle, angularSpeed: SWEEPER.angularSpeed },
    };
  }

  dispose() {
    for (const f of this.fighters) f.dispose();
    this.sweeperBody.dispose();
    this.arena.dispose();
    this.world.dispose();
  }

  private indexOf(id: PlayerId): number {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`no player ${id} in this match`);
    return i;
  }

  private emit(e: Omit<MatchEvent, 'tick' | 't' | 'round'>) {
    this.events.push({ tick: this.tickCount, t: +this.clock.toFixed(3), round: this.match.round, ...e });
  }

  private resetRound() {
    for (const f of this.fighters) f.reset();
    for (const f of this.fighters) f.body.setGravityFactor(1);
    resetOrbs(this.orbs);
    resetSweeper(this.sweeper);
    this.sweeperBody.apply(this.sweeper);
  }

  private combatants(): Combatant[] {
    return this.fighters.map((f) => ({ combat: f.combat, at: f.at(), facing: f.facing(), active: !f.eliminated }));
  }

  /** Holds that ended: each victim has its weight back. */
  private dropped(holds: Hold[]) {
    for (const h of holds) this.fighters[h.holder].letGo(this.fighters[h.victim]);
  }

  /** A blow lands on `j` (a punch, or the sweeper when `by` is -1): any hold it is part of ends first, as holder or as held, then the reaction. */
  private strike(list: Combatant[], j: number, reaction: Reaction, by: number) {
    const ended = freeHolds(list, j);
    this.dropped(ended);
    for (const h of ended) if (by !== h.holder && by !== h.victim) this.emit({ kind: 'interrupt', who: by >= 0 ? this.ids[by] : null, on: this.ids[j], note: `${this.ids[h.holder]} lost ${this.ids[h.victim]}` });
    this.fighters[j].react(reaction, (COMBAT.hitSpin * reaction.impact) / COMBAT.tumbleThreshold);
  }

  /** One fighter's attack and hold this step, against whichever fighter the match decides it takes. */
  private interact(list: Combatant[], i: number, intent: PlayerIntent, dt: number) {
    const me = this.fighters[i];
    if (me.eliminated) return;
    // A punch in its active window lands on one fighter: the nearest in reach and arc.
    if (punchActive(me.combat)) {
      const j = punchTarget(list, i);
      if (j >= 0) {
        const other = this.fighters[j];
        const reaction = landPunch(me.combat, me.at(), me.facing(), me.speedAlongFacing(), me.power, other.combat, other.at(), RUMBLE_BODY.walkSpeed);
        if (reaction) {
          this.emit({ kind: 'punch', who: me.id, on: other.id, reaction: reaction.kind, impact: reaction.impact, note: other.combat.held ? 'on a held body' : isHolding(other.combat) ? 'on a carrier' : undefined });
          this.strike(list, j, reaction, i);
        }
      }
    }
    if (intent.grab) {
      const v = me.combat.victim;
      if (isHolding(me.combat) && v >= 0) {
        const victim = this.fighters[v];
        const thrown = release(me.combat, victim.combat, me.holdDir(), me.velocity(), me.power);
        me.letGo(victim);
        victim.react(thrown, COMBAT.throwSpin);
        this.emit({ kind: 'throw', who: me.id, on: victim.id, reaction: thrown.kind, impact: thrown.impact });
      } else {
        const j = grabTarget(list, i);
        if (j >= 0 && tryGrab(me.combat, me.at(), me.facing(), this.fighters[j].combat, this.fighters[j].at(), COMBAT, { grabber: i, victim: j })) {
          me.hold(this.fighters[j]);
          this.emit({ kind: 'grab', who: me.id, on: this.ids[j] });
        }
      }
    }
    const v = me.combat.victim;
    if (isHolding(me.combat) && v >= 0) {
      const victim = this.fighters[v];
      const anchor = me.holdStep(dt);
      if (holdBreaks(me.combat, anchor, victim.feet()) || isTumbling(me.combat)) {
        endGrab(me.combat, victim.combat);
        me.letGo(victim);
        this.emit({ kind: 'drop', who: me.id, on: victim.id, note: 'hold broke' });
      } else {
        const pull = holdPull(anchor, me.velocity(), victim.feet(), victim.velocity3(), dt);
        victim.push(pull.victim.x, pull.victim.y, pull.victim.z);
        me.push(pull.grabber.x, 0, pull.grabber.z);
      }
    }
  }
}

/** Create a match. The Havok instance comes from `physics/world.ts` in a browser, `sim/havokNode.ts` in Node. */
export const createRumbleMatch = (config: RumbleMatchConfig) => new RumbleMatch(config);
