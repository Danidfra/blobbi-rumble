/**
 * THE SOCIAL LOBBY'S SIMULATION (L4): Blobbis walking Blobbi Plaza
 * (`arena/lobbySpace.ts`) between matches, server-authoritative, with the
 * game's own movement: each avatar is a `FighterSim`, stepped as the match
 * steps its fighters' locomotion (`update`, `settle`, `turn`, the fall
 * line), so walking, running, turning and jumping feel exactly as they do
 * in a match. Everything else a match does is absent, not switched off:
 *
 *   no punch, grab or throw   requests are dropped on arrival (the intent
 *                             keeps only direction, run and jump)
 *   no pushing contest        bodies only bump, as capsules do; the fence
 *                             keeps everyone on the plaza
 *   no rounds, no scores, no elimination, no orbs, no hazards
 *   falling                   below the fall line (only by a bug: the fence
 *                             is higher than a jump) an avatar is put back on
 *                             its seat's spot after the usual short wait
 *
 * Avatars come and go without rebuilding anything (a person seated, a bot
 * switched on, someone leaving). Its own physics world, made with it and
 * disposed with it: a room has either this or its match, never both.
 *
 * Its snapshot is a match snapshot (`MatchSnapshot`), always "playing",
 * naming the plaza as its arena, so a client draws, predicts and
 * interpolates it with the code it already has. Time passes only through
 * `step(dt)`; its tick and clock may start where the room's last space
 * left off, so a room's states always count up.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LOBBY_SPACE, plazaSpot } from '../arena/lobbySpace';
import type { ArenaDef } from '../arena/arenas';
import { createArenaBody, type ArenaBody } from './arenaBody';
import { FighterSim, fighterSnapshot, type PlayerId } from './fighter';
import { IDLE_INTENT, sanitizeIntent, type PlayerIntent } from './intent';
import { createPhysicsWorld, type HavokInstance, type PhysicsWorld } from './physics';
import { RUMBLE_BODY } from '../profile';
import { ROUND } from '../tuning';
import type { MatchEvent, MatchSnapshot } from './snapshot';

export interface SocialConfig {
  havok: HavokInstance;
  /** The room's seats, in order (a seat's index picks its spot). */
  seats: readonly PlayerId[];
  /** The avatars to start with (seats). */
  players?: readonly PlayerId[];
  startTick?: number;
  startTime?: number;
}

/** What a room's live space offers its host, whichever it is: the social lobby, or the match. */
export interface Space {
  readonly ids: readonly PlayerId[];
  readonly tick: number;
  readonly time: number;
  setInput(id: PlayerId, intent: Partial<PlayerIntent>): void;
  clearInput(id: PlayerId): void;
  step(dt: number): MatchEvent[];
  snapshot(): MatchSnapshot;
  dispose(): void;
}

/** An avatar: its body, the movement it holds, and a jump waiting for the next step. */
interface Avatar {
  sim: FighterSim;
  intent: PlayerIntent;
  jump: boolean;
}

/** Only what moves a Blobbi on the plaza: direction, gait, a jump. Never a punch or a grab. */
export const socialIntent = (i: Partial<PlayerIntent>): PlayerIntent => {
  const clean = sanitizeIntent(i);
  return { ...clean, punch: false, grab: false };
};

export class SocialSpace implements Space {
  readonly space: ArenaDef = LOBBY_SPACE;
  readonly world: PhysicsWorld;
  private readonly arenaBody: ArenaBody;
  private readonly avatars = new Map<PlayerId, Avatar>();
  private order: PlayerId[] = [];
  private tickCount: number;
  private clock: number;

  constructor(private readonly config: SocialConfig) {
    this.world = createPhysicsWorld(config.havok, RUMBLE_BODY.gravity);
    this.arenaBody = createArenaBody(this.world.scene, this.space);
    this.tickCount = config.startTick ?? 0;
    this.clock = config.startTime ?? 0;
    for (const id of config.players ?? []) this.add(id);
  }

  get ids(): readonly PlayerId[] {
    return this.order;
  }
  get tick() {
    return this.tickCount;
  }
  get time() {
    return this.clock;
  }

  /** An avatar for this seat, on its spot (nothing if it is there already). */
  add(id: PlayerId) {
    if (this.avatars.has(id)) return;
    const spot = plazaSpot(this.seatIndex(id));
    const sim = new FighterSim(id, this.world.scene, new Vector3(spot.x, spot.y, spot.z), spot.yaw);
    sim.fallRules = { floorY: this.space.fallY, respawnDelay: 0.8 };
    this.avatars.set(id, { sim, intent: { ...IDLE_INTENT }, jump: false });
    // Seat order, so every client lists the avatars alike.
    this.order = this.config.seats.filter((s) => this.avatars.has(s)).concat([...this.avatars.keys()].filter((k) => !this.config.seats.includes(k)));
  }

  /** This seat's avatar goes (its body with it). */
  remove(id: PlayerId) {
    const a = this.avatars.get(id);
    if (!a) return;
    a.sim.dispose();
    this.avatars.delete(id);
    this.order = this.order.filter((k) => k !== id);
  }

  /** Make the avatars exactly these (added at their spots, the others removed). */
  setLineup(ids: readonly PlayerId[]) {
    for (const id of [...this.order]) if (!ids.includes(id)) this.remove(id);
    for (const id of ids) this.add(id);
  }

  /** A seat's latest movement; a jump waits for the next step (two before one step never lose it). Punch and grab are dropped. */
  setInput(id: PlayerId, intent: Partial<PlayerIntent>) {
    const a = this.avatars.get(id);
    if (!a) return;
    const clean = socialIntent(intent);
    a.intent = { ...clean, jump: false };
    a.jump ||= clean.jump;
  }

  clearInput(id: PlayerId) {
    const a = this.avatars.get(id);
    if (!a) return;
    a.intent = { ...IDLE_INTENT };
    a.jump = false;
  }

  /** One step: every avatar moves by its intent as a match fighter would; one below the fall line is put back on its spot. */
  step(dt: number): MatchEvent[] {
    this.clock += dt;
    this.tickCount += 1;
    const list = this.order.map((id) => this.avatars.get(id)!);
    const intents = list.map((a) => {
      const i = { ...a.intent, jump: a.jump };
      a.jump = false;
      return i;
    });
    list.forEach((a, k) => a.sim.update(dt, intents[k]));
    for (const a of list) a.sim.settle();
    list.forEach((a, k) => a.sim.turn(dt, intents[k].x !== 0 || intents[k].z !== 0));
    for (const a of list) {
      const was = a.sim.fall.fallen;
      a.sim.checkFall(dt);
      // The wait is over: back on its spot, at rest.
      if (was && !a.sim.fall.fallen) a.sim.reset();
    }
    this.world.step(dt);
    return [];
  }

  /** The plaza as a match snapshot: every avatar in play, nothing scored, nothing else in it. */
  snapshot(): MatchSnapshot {
    return {
      tick: this.tickCount,
      time: this.clock,
      players: [...this.order],
      fighters: this.order.map((id) => fighterSnapshot(this.avatars.get(id)!.sim, { alive: true, score: 0, holding: null, heldBy: null, touching: null, bananas: { left: 0, cooldown: 0 } })),
      phase: 'playing',
      round: 1,
      roundTimer: 0,
      target: ROUND.target,
      lastRoundWinner: null,
      matchWinner: null,
      orbs: [],
      sweeper: null,
      arena: LOBBY_SPACE.id,
      pieces: [],
      roundTime: 0,
      bananas: [],
    };
  }

  /** For tests and scripted checks only: put an avatar somewhere, at rest. */
  debugPlace(id: PlayerId, at: { x: number; y?: number; z: number }) {
    this.avatars.get(id)?.sim.body.teleport(new Vector3(at.x, at.y ?? 0, at.z));
  }

  dispose() {
    for (const a of this.avatars.values()) a.sim.dispose();
    this.avatars.clear();
    this.order = [];
    this.arenaBody.dispose();
    this.world.dispose();
  }

  private seatIndex(id: PlayerId) {
    const i = this.config.seats.indexOf(id);
    return i >= 0 ? i : this.avatars.size;
  }
}
