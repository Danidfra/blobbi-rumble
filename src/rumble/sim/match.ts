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
import { CLASSIC, arenaSpawns, type ArenaDef } from '../arena/arenas';
import { inPlatform, platformUnder } from '../arena/geometry';
import { createPieces, drop as pieceDrop, pieceImpact, pieceSolid, resetPieces, tickPiece, type PieceState } from '../arena/pieces';
import { createSweeper, resetSweeper, sweeperHit, tickSweeper, type SweeperState } from '../arena/sweeper';
import { anchorVelocity, endGrab, holdBreaks, holdPull, isDown, isHolding, isTumbling, landPunch, punchActive, release, tickCombat, tryGrab, tryPunch, type Reaction } from '../combat/combat';
import { freeHolds, grabTarget, holdsConsistent, punchTarget, settleHolds, type Combatant, type Hold } from '../combat/melee';
import { createThrowers, judgeThrow, resetThrowers, slips, tickBananas, type Banana, type Thrower, type ThrowRefusal } from '../pickups/bananas';
import { collectOrbs, createOrbs, resetOrbs, tickOrbs } from '../pickups/orbs';
import { nearestContacts } from '../physics/contact';
import { RUMBLE_BODY } from '../profile';
import { aliveCount, createMatch, matchWinner, restartMatch, ringOut, tickMatch, type MatchState } from '../rounds';
import { stepStruggle } from '../combat/struggle';
import { BANANAS, COMBAT, INPUT_WINDOWS, ORBS, PUSH, ROUND, STRUGGLE } from '../tuning';
import { reactionKind } from '../combat/impact';
import { createArenaBody, type ArenaBody } from './arenaBody';
import { FighterSim, fighterSnapshot, type PlayerId, type StepResult } from './fighter';
import { IDLE_INTENT, sanitizeIntent, type PlayerIntent } from './intent';
import { canCatch, reachableLedge } from './ledge';
import { LEDGE } from '../tuning';
import { createPhysicsWorld, type HavokInstance, type PhysicsWorld } from './physics';
import type { MatchEvent, MatchSnapshot } from './snapshot';
import { SweeperBody } from './sweeperBody';

export interface RumbleMatchConfig {
  havok: HavokInstance;
  /** 2 to 4 players, in roster order (which decides the spawn). Ids must be unique. */
  players: readonly { id: PlayerId }[];
  /** M11A: which arena (the classic island by default). */
  arena?: ArenaDef;
  /** L2: the tick and clock to start from (a room's next match keeps counting, so states stay in order). */
  startTick?: number;
  startTime?: number;
}

/** M11D / M11E: how a belt and ice act on a body standing on them. */
export const SURFACES = Object.freeze({
  /** A belt closes the body's velocity on its own at this rate, 1/s (a drag, never a launch), capped per step. */
  conveyorGain: 6,
  conveyorMaxDv: 0.25,
  /** The steering grip on ice (of 1). */
  iceGrip: 0.3,
});

export class RumbleMatch {
  readonly ids: readonly PlayerId[];
  /** The physics world, for debug tooling and scripted checks only; clients draw from snapshots. */
  readonly world: PhysicsWorld;
  private readonly fighters: FighterSim[];
  private readonly index = new Map<PlayerId, number>();
  private readonly match: MatchState;
  private orbs;
  private sweeper: SweeperState | null = null;
  private sweeperBody: SweeperBody | null = null;
  private arenaBody: ArenaBody;
  /** M11A: the arena in play, and (M11B) its dynamic pieces' state. */
  private def: ArenaDef;
  private pieces: PieceState[];
  private roundTime = 0;
  /** M11F: the banana peels on the floor, and each fighter's throws (as an eliminated player). */
  private bananas: Banana[] = [];
  private throwers: Thrower[];
  /** Events decided between steps (a throw judged on arrival), reported by the next step. */
  private queued: MatchEvent[] = [];
  /** Each player's current movement intent, and the action requests waiting for the next step. */
  private readonly intents: PlayerIntent[];
  private readonly pending: { jump: boolean; punch: boolean; grab: boolean }[];
  private readonly wasTouching: boolean[];
  private lastIntents: PlayerIntent[];
  private contacts: number[];
  private events: MatchEvent[] = [];
  private tickCount = 0;
  private clock = 0;
  /** L2: fighters whose player left a match without bots: out of every round from now on. */
  private readonly forfeited: boolean[];

  constructor(config: RumbleMatchConfig) {
    const n = config.players.length;
    if (n < 2 || n > 4) throw new Error(`a match has 2 to 4 players, not ${n}`);
    this.ids = config.players.map((p) => p.id);
    this.ids.forEach((id, i) => {
      if (this.index.has(id)) throw new Error(`duplicate player id ${id}`);
      this.index.set(id, i);
    });
    this.world = createPhysicsWorld(config.havok, RUMBLE_BODY.gravity);
    this.def = config.arena ?? CLASSIC;
    this.arenaBody = createArenaBody(this.world.scene, this.def);
    const spawns = arenaSpawns(this.def, n as 2 | 3 | 4);
    this.fighters = this.ids.map((id, i) => new FighterSim(id, this.world.scene, new Vector3(spawns[i].x, spawns[i].y, spawns[i].z), spawns[i].yaw));
    for (const f of this.fighters) f.fallRules = { floorY: this.def.fallY, respawnDelay: 0.8 };
    this.orbs = createOrbs({ ...ORBS, points: this.def.orbs });
    this.pieces = createPieces(this.def.dynamics);
    if (this.def.sweeper) {
      this.sweeper = createSweeper(n);
      this.sweeperBody = new SweeperBody(this.world.scene, this.def.sweeper);
    }
    this.match = createMatch(n);
    this.intents = this.ids.map(() => ({ ...IDLE_INTENT }));
    this.pending = this.ids.map(() => ({ jump: false, punch: false, grab: false }));
    this.wasTouching = Array(n).fill(false);
    this.lastIntents = this.ids.map(() => ({ ...IDLE_INTENT }));
    this.contacts = Array(n).fill(-1);
    this.throwers = createThrowers(n);
    this.forfeited = Array(n).fill(false);
    this.tickCount = config.startTick ?? 0;
    this.clock = config.startTime ?? 0;
  }

  /**
   * L2: this fighter's player left a match nobody else may drive (a room
   * without bots). It is out of the round at the next step of play, and of
   * every round after, like a ring-out (its holds end, it scores nothing
   * more); its score so far stays its own.
   */
  forfeit(id: PlayerId) {
    const i = this.indexOf(id);
    this.forfeited[i] = true;
    this.clearInput(id);
  }

  /** L2: this fighter's score back to nothing (a new player took it over: they do not inherit what another earned). */
  resetScore(id: PlayerId) {
    this.match.score[this.indexOf(id)] = 0;
  }

  /**
   * M11F: a player out of the round throws a banana peel at a point on the
   * floor. The match judges it (the round on, the thrower out, enough still
   * in, a budget, a cooldown, a cap on peels, solid floor) and says why not.
   */
  throwBanana(id: PlayerId, x: unknown, z: unknown): { ok: true } | { ok: false; reason: ThrowRefusal } {
    const i = this.indexOf(id);
    const f = this.fighters[i];
    const unusable = (index: number) => {
      const k = this.def.dynamics.findIndex((d) => d.platform === index);
      return k >= 0 && !pieceSolid(this.pieces[k]);
    };
    const judged = judgeThrow(this.throwers[i], this.bananas.length, x, z, { playing: this.match.phase === 'playing', eliminated: f.eliminated, alive: aliveCount(this.match), platforms: this.def.platforms, unusable });
    if (!judged.ok) return judged;
    this.throwers[i].thrown += 1;
    this.throwers[i].since = 0;
    this.bananas.push({ ...judged.banana, owner: i });
    this.queued.push({ tick: this.tickCount, t: +this.clock.toFixed(3), round: this.match.round, kind: 'banana', who: id, note: `thrown at ${judged.banana.x.toFixed(1)}, ${judged.banana.z.toFixed(1)}` });
    return { ok: true };
  }

  get tick() {
    return this.tickCount;
  }
  get time() {
    return this.clock;
  }
  /** M11A: the arena in play. */
  get arena(): ArenaDef {
    return this.def;
  }

  /**
   * M11A: play on another arena. The old colliders, sweeper and pieces go;
   * the new ones are built; the fighters are moved to the new spawns and
   * the round restarts (scores stay: this is for a rotation between
   * matches, or a host's choice before play). Nothing of any fighter's body
   * is leaked: the same Havok world and capsules go on.
   */
  switchArena(def: ArenaDef): MatchEvent[] {
    this.events = [];
    if (def.id === this.def.id) return this.events;
    this.sweeperBody?.dispose();
    this.sweeperBody = null;
    this.sweeper = null;
    this.arenaBody.dispose();
    this.def = def;
    this.arenaBody = createArenaBody(this.world.scene, def);
    const spawns = arenaSpawns(def, this.fighters.length as 2 | 3 | 4);
    this.fighters.forEach((f, i) => f.relocate(new Vector3(spawns[i].x, spawns[i].y, spawns[i].z), spawns[i].yaw, { floorY: def.fallY, respawnDelay: 0.8 }));
    this.orbs = createOrbs({ ...ORBS, points: def.orbs });
    this.pieces = createPieces(def.dynamics);
    if (def.sweeper) {
      this.sweeper = createSweeper(this.fighters.length);
      this.sweeperBody = new SweeperBody(this.world.scene, def.sweeper);
    }
    this.resetRound();
    this.emit({ kind: 'arena', who: null, note: def.id });
    return this.events;
  }

  /**
   * A player's latest intent. Movement holds until replaced; an action
   * request waits for the next step, which takes it once (two intents
   * before one step never lose a press). Requests are taken even while the
   * player may not act (between rounds, eliminated), and dropped: none
   * queue up. L4.4A: a press the fighter cannot act on at that step may
   * wait a short window in the fighter (`INPUT_WINDOWS`), at most one of
   * each kind, and never out of play.
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
  /** M12.1, for checks: each dynamic piece's velocity as Havok has it. */
  debugPieceVelocities(): { x: number; y: number; z: number }[] {
    return this.def.dynamics.map((_, k) => this.arenaBody.pieceVelocity(k) ?? { x: 0, y: 0, z: 0 });
  }

  /** M12.1, for checks: the dynamic pieces' phases. */
  debugPieces(): string[] {
    return this.pieces.map((p) => p.phase);
  }

  debugPlace(id: PlayerId, at: { x: number; y?: number; z: number; yaw?: number; powerLevel?: number }) {
    const f = this.fighters[this.indexOf(id)];
    f.body.teleport(new Vector3(at.x, at.y ?? 0, at.z));
    if (at.yaw !== undefined) f.yaw = at.yaw;
    if (at.powerLevel !== undefined) f.powerLevel = at.powerLevel;
  }

  /** Whether every hold is a true pair, nobody with two holders (for tests and the debug HUD). */
  holdsConsistent(): boolean {
    return holdsConsistent(this.combatants());
  }

  /**
   * L1: time passes and nothing moves: a private room between matches (its
   * lobby, its countdown). The tick and the clock advance, so states keep
   * coming in order; no body, piece, hazard or rule is stepped and no input
   * is taken. Returns what was queued (nothing can be, outside play).
   */
  idle(dt: number): MatchEvent[] {
    this.events = this.queued;
    this.queued = [];
    this.clock += dt;
    this.tickCount += 1;
    for (const p of this.pending) p.jump = p.punch = p.grab = false;
    return this.events;
  }

  /** Advance the match by `dt` seconds. Returns what it decided during the step. */
  step(dt: number): MatchEvent[] {
    this.events = this.queued;
    this.queued = [];
    this.clock += dt;
    this.tickCount += 1;
    const fighters = this.fighters;
    const n = fighters.length;
    const playing = this.match.phase === 'playing';
    if (playing) this.roundTime += dt;
    // M11D / M11E: what each fighter stands on this step: a belt carries it, ice lets it slide (the floor's part is the collider's own friction).
    fighters.forEach((f, i) => {
      if (f.eliminated) return;
      const feet = f.body.feet();
      const under = f.grounded ? platformUnder(this.def.platforms, { x: feet.x, z: feet.z }) : null;
      const onIce = !!under && under.kind === 'ice' && Math.abs(feet.y - under.y) < 0.3;
      const grip = onIce ? SURFACES.iceGrip : 1;
      if (grip !== f.grip) {
        f.grip = grip;
        if (!this.wasTouching[i]) f.body.setFriction(onIce ? this.def.iceFriction : RUMBLE_BODY.friction);
      }
      const belt = under && under.kind === 'conveyor' && Math.abs(feet.y - under.y) < 0.3 ? this.def.conveyors.find((c) => this.def.platforms[c.platform] === under) : undefined;
      f.carry.x = belt?.vx ?? 0;
      f.carry.z = belt?.vz ?? 0;
      {
        if (belt) {
          const v = f.body.velocity();
          const k = Math.min(1, SURFACES.conveyorGain * dt);
          let dvx = (belt.vx - v.x) * k;
          let dvz = (belt.vz - v.z) * k;
          const len = Math.hypot(dvx, dvz);
          if (len > SURFACES.conveyorMaxDv) {
            dvx *= SURFACES.conveyorMaxDv / len;
            dvz *= SURFACES.conveyorMaxDv / len;
          }
          // Carried along, never launched: a bounded nudge toward the belt's speed, under the body's own steering.
          f.push(dvx, 0, dvz);
        }
      }
    });
    // This step's intents: the held movement plus the waiting requests, which are taken now whether or not they may act
    // (L4.4A: a press the fighter cannot act on yet waits a short window in the fighter, never longer, never out of play).
    const hanging = fighters.map((f) => f.onLedge);
    const intents = fighters.map((f, i) => {
      const p = this.pending[i];
      const intent = { ...this.intents[i], ...p };
      p.jump = p.punch = p.grab = false;
      if (!playing || f.eliminated) {
        f.punchWait = f.grabWait = -1;
        return { ...IDLE_INTENT };
      }
      // M11C: hanging, the hands are full: the keys steer the hold (jump climbs, grab lets go), never a punch or a grab.
      return f.onLedge ? { ...intent, punch: false } : intent;
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
        f.body.setFriction(touching ? PUSH.contactFriction : f.grip < 1 ? this.def.iceFriction : RUMBLE_BODY.friction);
      }
    });

    // M11C: ledges. A falling body within reach of an edge it may hold catches it; a hold on a piece that has gone is lost.
    if (this.def.ledges) {
      const gone = (index: number) => {
        const k = this.def.dynamics.findIndex((d) => d.platform === index);
        return k >= 0 && !pieceSolid(this.pieces[k]);
      };
      fighters.forEach((f, i) => {
        if (f.eliminated) return;
        const h = f.ledge.hold;
        if (h) {
          if (gone(h.ledge.platform)) {
            f.dropLedge();
            this.emit({ kind: 'ledge', who: this.ids[i], note: 'ledge gone' });
          }
          return;
        }
        if (!playing || !canCatch(f.ledge, f.combat, f.grounded, f.body.velocity().y)) return;
        const v = f.body.velocity();
        const l = reachableLedge(this.def.platforms, f.body.position(), f.body.feet().y, gone, LEDGE, f.leapt ? { vx: v.x, vz: v.z } : undefined);
        if (!l) return;
        f.catchLedge(l);
        this.emit({ kind: 'ledge', who: this.ids[i], note: `caught ${this.def.platforms[l.platform].name ?? l.platform}` });
      });
    }
    // Steering. A shoving match is two touching fighters pushing into each other (read from the last step's intents: one step late, never wrong by much).
    const results: StepResult[] = fighters.map((f, i) => {
      if (f.eliminated) return { grounded: false, jumped: false };
      if (f.onLedge) {
        const out = f.ledgeStep(dt, intents[i]);
        if (out !== 'hanging' && out !== 'climbing') this.emit({ kind: 'ledge', who: this.ids[i], note: out });
        return { grounded: out === 'climbed', jumped: false };
      }
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
        this.interact(list, i, intents[i], dt, hanging[i]);
      }
    }
    // The held struggle, after every attack of the step: a throw (or a blow that frees the body) this step wins over an escape.
    if (playing) {
      fighters.forEach((f, i) => {
        const c = f.combat;
        if (!c.held || c.holder < 0 || f.eliminated) return;
        const r = stepStruggle(c, intents[i], dt);
        if (r.escaped) this.breakFree(i);
      });
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

    // M11F: the peels lie, age and go; a fighter running over one tumbles along its way.
    tickBananas(this.bananas, this.throwers, dt);
    if (playing && this.bananas.length) {
      const walkers = fighters.map((f) => {
        if (f.eliminated) return null;
        const feet = f.body.feet();
        const v = f.velocity();
        return { x: feet.x, y: feet.y, z: feet.z, speed: Math.hypot(v.x, v.z), canSlip: f.grounded && !f.onLedge && !f.combat.held && !isDown(f.combat) };
      });
      const slipped = slips(this.bananas, walkers);
      const list = this.combatants();
      // Remove from the highest index down, so each slip's peel is the one it stepped on.
      const order = slipped.map((b, i) => [b, i]).filter(([b]) => b >= 0).sort((p, q) => q[0] - p[0]);
      for (const [b, i] of order) {
        const peel = this.bananas[b];
        const v = fighters[i].velocity();
        const speed = Math.hypot(v.x, v.z) || 1;
        const dir = { x: v.x / speed, z: v.z / speed };
        const impact = BANANAS.impact;
        const reaction: Reaction = { kind: reactionKind(impact, true), impact, dvx: dir.x * BANANAS.push, dvy: BANANAS.lift, dvz: dir.z * BANANAS.push, dir };
        this.bananas.splice(b, 1);
        this.strike(list, i, reaction, -1);
        this.emit({ kind: 'banana', who: this.ids[i], on: this.ids[peel.owner], reaction: 'tumble', impact, note: 'slipped' });
      }
    }

    // The sweeper turns; a fighter under its leading face takes its blow, through the same reaction as a punch (no player power in it).
    if (this.sweeper && this.sweeperBody && this.def.sweeper) {
      const tuning = this.def.sweeper;
      tickSweeper(this.sweeper, dt, tuning);
      this.sweeperBody.apply(this.sweeper);
      if (playing) {
        const list = this.combatants();
        fighters.forEach((f, i) => {
          if (f.eliminated) return;
          const hit = sweeperHit(this.sweeper!, i, f.body.position(), RUMBLE_BODY.capsuleRadius, RUMBLE_BODY.capsuleCenterY, tuning);
          if (!hit) return;
          this.strike(list, i, hit.reaction, -1);
          this.emit({ kind: 'sweeper', who: this.ids[i], reaction: hit.reaction.kind, impact: hit.reaction.impact, note: `at ${hit.along.toFixed(2)} m (${hit.speed.toFixed(2)} m/s)` });
        });
      }
    }
    // M11B: the dynamic pieces: weight arms a falling pad, heavy impacts (counted in `strike`) and time arm a bridge; the collider follows.
    this.def.dynamics.forEach((d, k) => {
      const piece = this.pieces[k];
      const r = this.def.platforms[d.platform];
      const loaded = playing && fighters.some((f) => !f.eliminated && f.grounded && inPlatform(r, f.at(), 0) && Math.abs(f.body.feet().y - r.y) < 0.3);
      const entered = tickPiece(piece, d.rule, playing ? dt : 0, loaded, this.roundTime);
      this.arenaBody.setPiece(k, pieceDrop(piece, d.rule), pieceSolid(piece) || piece.phase === 'falling');
      if (entered) this.emit({ kind: 'piece', who: null, piece: k, note: entered });
    });
    for (const f of fighters) if (!f.eliminated) f.settle();
    // The facing follows the velocity (a carrier's only by its own steering).
    fighters.forEach((f, i) => {
      if (!f.eliminated && !f.onLedge) f.turn(dt, intents[i].x !== 0 || intents[i].z !== 0);
    });

    // Ring-outs: who crossed the fall line this step. Each is out of the round: its holds end, its body leaves play.
    // L2: a forfeited fighter goes out with the ring-outs, in play only (between rounds nobody leaves).
    const fell = fighters.map((f, i) => !f.eliminated && (f.checkFall(dt) || (playing && this.forfeited[i])));
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
      fighters: this.fighters.map((f, i) =>
        fighterSnapshot(f, { alive: m.alive[i], score: m.score[i], holding: idOf(f.combat.victim), heldBy: idOf(f.combat.holder), touching: idOf(this.contacts[i]), bananas: { left: Math.max(0, BANANAS.perRound - this.throwers[i].thrown), cooldown: +Math.max(0, BANANAS.cooldown - this.throwers[i].since).toFixed(2) } }),
      ),
      phase: m.phase,
      round: m.round,
      roundTimer: m.timer,
      target: ROUND.target,
      lastRoundWinner: idOf(m.lastWinner ?? -1),
      matchWinner: winner === null ? null : this.ids[winner],
      orbs: this.orbs.map((o) => ({ x: o.x, y: o.y, z: o.z, active: o.active, timer: o.timer })),
      sweeper: this.sweeper && this.def.sweeper ? { angle: this.sweeper.angle, angularSpeed: this.def.sweeper.angularSpeed } : null,
      arena: this.def.id,
      pieces: this.pieces.map((p, k) => ({ phase: p.phase, t: +p.t.toFixed(3), drop: +pieceDrop(p, this.def.dynamics[k].rule).toFixed(3) })),
      roundTime: +this.roundTime.toFixed(3),
      bananas: this.bananas.map((b) => ({ x: b.x, y: b.y, z: b.z, owner: this.ids[b.owner], age: +b.age.toFixed(2) })),
    };
  }

  dispose() {
    for (const f of this.fighters) f.dispose();
    this.sweeperBody?.dispose();
    this.arenaBody.dispose();
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
    this.wasTouching.fill(false);
    resetOrbs(this.orbs);
    if (this.sweeper && this.sweeperBody) {
      resetSweeper(this.sweeper);
      this.sweeperBody.apply(this.sweeper);
    }
    resetPieces(this.pieces);
    this.pieces.forEach((_, k) => this.arenaBody.setPiece(k, 0, true));
    this.roundTime = 0;
    this.bananas = [];
    resetThrowers(this.throwers);
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
    // M11B: a heavy blow on a body over a breakable piece weakens it.
    if (reaction.kind === 'tumble') {
      const at = this.fighters[j].at();
      this.def.dynamics.forEach((d, k) => {
        if (inPlatform(this.def.platforms[d.platform], at, 0)) pieceImpact(this.pieces[k], d.rule);
      });
    }
    for (const h of ended) if (by !== h.holder && by !== h.victim) this.emit({ kind: 'interrupt', who: by >= 0 ? this.ids[by] : null, on: this.ids[j], note: `${this.ids[h.holder]} lost ${this.ids[h.victim]}` });
    // M11C: a blow on a hanging body breaks its grip.
    if (this.fighters[j].onLedge) {
      this.fighters[j].dropLedge();
      this.emit({ kind: 'ledge', who: this.ids[j], note: 'knocked off' });
    }
    this.fighters[j].react(reaction, (COMBAT.hitSpin * reaction.impact) / COMBAT.tumbleThreshold);
  }

  /**
   * `i` struggled free: the hold ends on both sides, the freed body leaves
   * its holder with a small push (and the holder gives a little), and for a
   * moment nobody may grab it again, so the escape is one.
   */
  private breakFree(i: number) {
    const victim = this.fighters[i];
    const h = victim.combat.holder;
    const holder = this.fighters[h];
    endGrab(holder.combat, victim.combat);
    holder.letGo(victim);
    holder.carryDrag = 0;
    const a = holder.at();
    const b = victim.at();
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const away = d > 1e-6 ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : holder.facing();
    const t = STRUGGLE;
    victim.push(away.x * t.breakAway, t.breakAwayLift, away.z * t.breakAway);
    holder.push(-away.x * t.holderRecoil, 0, -away.z * t.holderRecoil);
    victim.combat.grabImmune = t.regrabImmunity;
    victim.escapes += 1;
    this.emit({ kind: 'escape', who: victim.id, on: holder.id });
  }

  /**
   * One fighter's attack and hold this step, against whichever fighter the
   * match decides it takes. L4.4A: the grab (or throw) is judged before a
   * punch is started, so both pressed together keep the grab; a grab with
   * nobody to take keeps trying for `grabWindow`, and a punch pressed at
   * most `punchBuffer` before its cooldown ends starts when it ends. A
   * press made while hanging was the ledge's (let go): it grabs nothing.
   */
  private interact(list: Combatant[], i: number, intent: PlayerIntent, dt: number, hanging: boolean) {
    const me = this.fighters[i];
    if (me.eliminated) return;
    const w = INPUT_WINDOWS;
    const v0 = me.combat.victim;
    if (intent.grab && isHolding(me.combat) && v0 >= 0) {
      const victim = this.fighters[v0];
      const thrown = release(me.combat, victim.combat, me.holdDir(), me.velocity(), me.power);
      me.letGo(victim);
      me.carryDrag = 0;
      victim.react(thrown, COMBAT.throwSpin);
      // M11.1: a thrown body lands, rights itself and has a moment before anyone may grab it again (no throw chains).
      victim.combat.grabImmune = Math.max(victim.combat.grabImmune, COMBAT.throwImmunity);
      this.emit({ kind: 'throw', who: me.id, on: victim.id, reaction: thrown.kind, impact: thrown.impact });
      me.grabWait = -1;
    } else {
      // A grab press starts a window (never while held or off its feet: mashing to break free is not a grab).
      const fresh = intent.grab && !hanging && !me.combat.held && !isDown(me.combat);
      me.grabWait = pressAge(me.grabWait, fresh, dt, w.grabWindow);
      if (me.grabWait >= 0 && !isHolding(me.combat)) {
        const j = grabTarget(list, i);
        if (j >= 0 && !this.fighters[j].onLedge && tryGrab(me.combat, me.at(), me.facing(), this.fighters[j].combat, this.fighters[j].at(), COMBAT, { grabber: i, victim: j })) {
          me.hold(this.fighters[j]);
          me.grabWait = -1;
          this.emit({ kind: 'grab', who: me.id, on: this.ids[j] });
        }
      }
    }
    if (hanging) me.punchWait = -1;
    else if (intent.punch && tryPunch(me.combat)) me.punchWait = -1;
    else if (intent.punch && me.punchWait < 0) {
      // Refused now: kept only when the cooldown is all that stands in the way and it ends within the buffer; earlier is refused.
      const cd = me.combat.punchCooldown;
      if (cd > 0 && cd <= w.punchBuffer + 1e-6) me.punchWait = 0;
    } else if (me.punchWait >= 0) {
      // One press waiting, never two: a press while one waits adds nothing. A step's slack: the cooldown's last step can round late.
      me.punchWait = pressAge(me.punchWait, false, dt, w.punchBuffer + dt);
      if (me.punchWait >= 0 && tryPunch(me.combat)) me.punchWait = -1;
    }
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
    const v = me.combat.victim;
    if (isHolding(me.combat) && v >= 0) {
      const victim = this.fighters[v];
      // M12.1: the hold's swing, fed forward: its turn rate smoothed over a few steps, so a real turn is followed and the
      // step-to-step jiggle of a carrier's facing (which the load's own reaction causes) averages out instead of shaking it.
      const angleBefore = me.combat.holdAngle;
      const anchor = me.holdStep(dt);
      const rate = Math.atan2(Math.sin(me.combat.holdAngle - angleBefore), Math.cos(me.combat.holdAngle - angleBefore)) / dt;
      me.holdSpin += (rate - me.holdSpin) * COMBAT.holdSpinSmoothing;
      const turn = me.holdSpin;
      if (holdBreaks(me.combat, anchor, victim.feet()) || isTumbling(me.combat)) {
        endGrab(me.combat, victim.combat);
        me.letGo(victim);
        me.carryDrag = 0;
        victim.combat.grabImmune = Math.max(victim.combat.grabImmune, STRUGGLE.regrabImmunity);
        this.emit({ kind: 'drop', who: me.id, on: victim.id, note: 'hold broke' });
      } else {
        me.carryDrag = victim.combat.struggle;
        const pull = holdPull(anchor, anchorVelocity(me.body.velocity(), me.combat.holdAngle, turn), victim.feet(), victim.velocity3(), dt);
        victim.push(pull.victim.x, pull.victim.y, pull.victim.z);
        me.push(pull.grabber.x, 0, pull.grabber.z);
      }
    }
  }
}

/**
 * L4.4A: a waiting press's age this step, seconds: a fresh press is 0, a
 * waiting one a step older, and one past `limit` is gone (-1).
 */
export function pressAge(age: number, pressed: boolean, dt: number, limit: number): number {
  const a = pressed ? 0 : age >= 0 ? age + dt : -1;
  return a > limit + 1e-6 ? -1 : a;
}

/** Create a match. The Havok instance comes from `physics/world.ts` in a browser, `sim/havokNode.ts` in Node. */
export const createRumbleMatch = (config: RumbleMatchConfig) => new RumbleMatch(config);
