/**
 * THE MATCH HOST: the one authoritative Rumble match a server runs, and who
 * drives each of its fighters. Transport-free (the WebSocket server is a
 * thin shell around it), so it is tested without sockets.
 *
 * Four player slots, P1..P4. A connection that arrives takes the first free
 * slot and drives that fighter from then on; every slot nobody holds is
 * driven by a local test bot, so four fighters always play. When the person
 * leaves, the bot takes the fighter back where it stands; nothing resets.
 * A fifth connection gets no slot: it watches.
 *
 * Everything a connection says goes through `receive`, as raw text: only a
 * well-formed input from the connection that holds a slot, with a sequence
 * number above the last one applied, reaches the match, and only as that
 * slot's intent. The host owns time: `tick()` advances the match by exactly
 * one fixed step whatever arrives when.
 *
 * Identity (M8A) belongs to the connection, not the slot: the server tells
 * the host "this connection proved pubkey X" (`setIdentity`), and the
 * roster reports, per slot, a bot, a guest, or the proven pubkey of the
 * connection holding it. When the connection goes, so does its identity;
 * whoever takes the slot next starts as a guest.
 *
 * LOBBY ROOMS (L1, L4): a host made with `lifecycle: 'lobby'` does not play
 * continuously. Its `Lifecycle` (`lifecycle.ts`) decides the stage, and the
 * stage decides the room's live SPACE (`sim/social.ts`'s `Space`):
 *
 *   lobby, countdown until its swap    the social lobby (`SocialSpace`):
 *                                      Blobbis walk Blobbi Plaza, no combat
 *   the countdown's swap tick          the plaza goes, the match is built on
 *                                      the room's arena with the lineup
 *   countdown after the swap           the match stands still (`idle`)
 *   playing, results                   the match as ever
 *   the results' swap tick             the match goes, the plaza comes back
 *                                      (a rotating room picks its next arena)
 *
 * One physics world at a time: each swap disposes the old space; the new
 * one carries the tick and clock on, so states always count up. A countdown
 * cancelled after its swap goes back to the plaza at once. Without a
 * lifecycle (the OPEN room, older clients' rooms) everything is as before:
 * one match, the next one starting by itself.
 *
 * THE PUBLIC PLAZA (L4.1): a host made with `lifecycle: 'plaza'` is only
 * ever the social plaza: no lifecycle, no match, no ready, no owner, no
 * bots in seats. Its seats (up to eight) are people's; an empty seat is
 * empty. While few people are there, up to two AMBIENT bots stroll about
 * (two for none or one person, one for two, none from three): they are
 * not seats, hold no connection, no identity and no place in the roster,
 * and their ids (`B1`, `B2`) cannot be a seat's. They come and go after a
 * short settle (no flicker as someone reloads), appear on the far corner
 * spots, and the one that goes is the one furthest from anyone.
 *
 * SEATS AND FIGHTERS (L2). `ids` are the room's seats (P1..P4); the live
 * space's fighters are its own `ids` (on the plaza: the seated people, and
 * the bots when they are on, strolling; `control/wander.ts`). In a continuous room, and in a lobby room with
 * bots, they are the same: bots drive every seat nobody holds. In a lobby
 * room without bots, the match is built at the countdown's swap with only
 * the seated people's seats (a new match on the same arena, its tick and
 * clock carried on), and a person who leaves it forfeits: their fighter is
 * out of every round, never handed to a bot. A lobby room seats people
 * only in its lobby: whoever arrives later watches until the next lobby,
 * where the free seats go to the watchers in the order they came. A person
 * taking over a fighter mid-match (the OPEN room's drop-in) starts it with
 * no score: nobody inherits what a bot or another person earned.
 */
import { BotInput, botWorldFrom } from '../control/bot';
import { WanderBot } from '../control/wander';
import { createRumbleMatch, type RumbleMatch } from '../sim/match';
import { SocialSpace, type Space } from '../sim/social';
import { LOBBY_SPACE } from '../arena/lobbySpace';
import type { HavokInstance } from '../sim/physics';
import type { MatchSnapshot } from '../sim/snapshot';
import { bindLook, sameForm, type LookDeclaration, type SlotForm } from './looks';
import { CLASSIC, arenaById, nextArena, type ArenaDef, type ArenaId } from '../arena/arenas';
import { parseClientMessage, PressCounter, type Control, type LobbyCommand, type LobbyMessage, type LookReason, type MatchResults, type PongMessage, type RoomSettings, type RosterMessage, type SlotIdentity, type StateMessage, type WelcomeMessage } from './protocol';
import { Lifecycle, minHumans, type LifecycleView, type LobbyRefusal } from './lifecycle';

export const NET = Object.freeze({
  /** The authoritative simulation rate, steps per second. */
  tickHz: 60,
  /** How often the state goes out, per second (a divisor of tickHz: every tickHz / snapshotHz steps). */
  snapshotHz: 20,
  /** A person whose inputs stop arriving for this long, seconds, is let go of: its movement no longer holds. */
  inputTimeout: 1,
  /** After a match is won, the next one starts after this long, seconds. */
  nextMatchDelay: 5,
});

export interface HostConfig {
  havok: HavokInstance;
  players?: string[];
  tickHz?: number;
  snapshotHz?: number;
  /** M11A: the arena to play (the classic island by default), and whether to rotate to another after each match. */
  arena?: ArenaDef;
  rotate?: boolean;
  /** For a rotation: 0..1 (tests make it deterministic). */
  random?: () => number;
  /** L1: 'lobby' for a room with the lobby lifecycle; L4.1: 'plaza' for the public plaza; continuous play otherwise (the default). */
  lifecycle?: 'continuous' | 'lobby' | 'plaza';
}

/** L4.1: the public plaza's ambient bots: their ids (never a seat's), how many for how many people, and how long a change settles. */
export const AMBIENT = Object.freeze({
  ids: Object.freeze(['B1', 'B2']),
  /** Ambient bots wanted for this many people on the plaza. */
  forPeople: (people: number) => (people <= 1 ? 2 : people === 2 ? 1 : 0),
  /** A change of how many waits this long before a bot comes or goes, seconds. */
  settleSeconds: 2,
});

export type ConnectionId = number;

export class RumbleHost {
  /** The arena match (always, in a continuous room; in a lobby room, from the countdown's swap to the results' end). */
  private current: RumbleMatch | null = null;
  /** L4: the social lobby (a lobby room, between matches). Exactly one of the two is live. */
  private social: SocialSpace | null = null;
  /** The room's seats (the fighters are `match.ids`; the same unless a lobby room plays without bots). */
  readonly ids: readonly string[];
  readonly tickHz: number;
  readonly snapshotHz: number;
  readonly dt: number;
  /** Which connection holds each slot (null: the bot drives it). */
  private readonly holder = new Map<string, ConnectionId | null>();
  private readonly slotOf = new Map<ConnectionId, string | null>();
  /** The pubkey each connection has proven, if any. */
  private readonly identity = new Map<ConnectionId, string>();
  /** M9C: the form each connection's fighter wears, bound to its proven pubkey; gone with the identity or the connection. */
  private readonly looks = new Map<ConnectionId, SlotForm>();
  private readonly bots: BotInput[];
  /** L4: the bots' strolls on the plaza, by seat. */
  private readonly wanderers: WanderBot[];
  /** L4.1: the public plaza (no lifecycle, no match; ambient bots). */
  readonly isPlaza: boolean;
  /** L4.1: the ambient bots strolling now, their strolls, and since when (tick) the wanted number has differed. */
  private ambient: string[] = [];
  private readonly ambientWalks = new Map<string, WanderBot>(AMBIENT.ids.map((id, i) => [id, new WanderBot(101 + i)]));
  private ambientPending: number | null = null;
  /** Per slot: the last input sequence applied, the tick it arrived on, and what the latest step had applied. */
  private readonly lastSeq = new Map<string, number>();
  /** L4.4A: per connection, the press counts it has sent (`PressCounter`). */
  private readonly presses = new Map<ConnectionId, PressCounter>();
  private readonly lastInputTick = new Map<string, number>();
  private readonly acked = new Map<string, number>();
  /** Per slot: the step on which the acknowledged input was first applied. */
  private readonly ackTick = new Map<string, number>();
  private snapshot: MatchSnapshot;
  private matches = 0;
  private matchOverFor = 0;
  /** M11A: rotate to another arena between matches. */
  readonly rotate: boolean;
  private readonly random: () => number;
  /** L1: the lobby lifecycle, or null (continuous play). */
  readonly lobby: Lifecycle | null;
  /** L1: a lobby room's settings (the arena of the next match; bots). */
  readonly settings: RoomSettings;
  /** Connections in the order they arrived (the lobby's seating and handoff order). */
  private readonly arrivals: ConnectionId[] = [];
  private readonly havok: HavokInstance;

  constructor(config: HostConfig) {
    const ids = config.players ?? ['P1', 'P2', 'P3', 'P4'];
    this.tickHz = config.tickHz ?? NET.tickHz;
    this.snapshotHz = config.snapshotHz ?? NET.snapshotHz;
    if (this.tickHz % this.snapshotHz !== 0) throw new Error('snapshotHz must divide tickHz');
    this.dt = 1 / this.tickHz;
    this.rotate = config.rotate === true;
    this.random = config.random ?? Math.random;
    this.havok = config.havok;
    this.isPlaza = config.lifecycle === 'plaza';
    const [least, most] = this.isPlaza ? [1, 8] : [2, 4];
    if (new Set(ids).size !== ids.length || ids.length < least || ids.length > most || ids.some((id) => AMBIENT.ids.includes(id))) throw new Error(`a room has ${least} to ${most} distinct seats`);
    this.ids = Object.freeze([...ids]);
    this.bots = this.ids.map((_, i) => new BotInput(i + 1));
    this.wanderers = this.ids.map((_, i) => new WanderBot(i + 1));
    for (const id of this.ids) this.holder.set(id, null);
    this.settings = { bots: true, arena: (config.arena ?? CLASSIC).id, rotate: this.rotate };
    if (this.isPlaza) {
      // L4.1: the plaza from the start, with its ambient bots for nobody there yet.
      this.social = new SocialSpace({ havok: config.havok, seats: [...this.ids, ...AMBIENT.ids], players: [] });
      this.ambient = AMBIENT.ids.slice(0, AMBIENT.forPeople(0));
      this.social.setLineup(this.ambient);
      this.lobby = null;
    } else if (config.lifecycle === 'lobby') {
      this.social = new SocialSpace({ havok: config.havok, seats: this.ids, players: this.nextLineup() });
      this.lobby = new Lifecycle(this.tickHz, this.social.tick);
    } else {
      this.current = createRumbleMatch({ havok: config.havok, players: ids.map((id) => ({ id })), arena: config.arena ?? CLASSIC });
      this.lobby = null;
    }
    this.snapshot = this.space.snapshot();
  }

  /** The room's live space: the social lobby, or the match. */
  private get space(): Space {
    const s = this.social ?? this.current;
    if (!s) throw new Error('the room is disposed');
    return s;
  }

  /** The live space, or null once the room is disposed (a socket may still close after that). */
  private get live(): Space | null {
    return this.social ?? this.current;
  }

  /** The arena match. A lobby room has one only from its countdown's swap to the end of its results. */
  get match(): RumbleMatch {
    if (!this.current) throw new Error('no match now: the room is in its social lobby');
    return this.current;
  }

  /** L4: the social lobby, while the room is in it (null otherwise, and always in a continuous room). */
  get plaza(): SocialSpace | null {
    return this.social;
  }

  /** M11A: the arena in play; L4: in the social lobby, the arena the next match is played on; L4.1: the public plaza's own space. */
  get arena(): ArenaDef {
    if (this.isPlaza) return LOBBY_SPACE;
    return this.current?.arena ?? arenaById(this.settings.arena) ?? CLASSIC;
  }

  /** Steps between two states sent. */
  get ticksPerSnapshot() {
    return this.tickHz / this.snapshotHz;
  }

  /** A new connection: the first free slot is its, or none (it watches; in a lobby room, also while a match is on). */
  connect(conn: ConnectionId): WelcomeMessage {
    this.arrivals.push(conn);
    this.slotOf.set(conn, null);
    const free = !this.lobby || this.lobby.phase === 'lobby' ? this.freeSeat() : null;
    if (free) this.seat(conn, free);
    this.lobby?.join(conn);
    return { t: 'welcome', you: free, players: [...this.space.ids], tickHz: this.tickHz, snapshotHz: this.snapshotHz, arena: { id: this.arena.id, rotate: this.settings.rotate } };
  }

  private freeSeat(): string | null {
    return this.ids.find((id) => this.holder.get(id) === null) ?? null;
  }

  /** `conn` takes the free seat `slot`: a fresh input sequence, nothing of the last driver's intent, and (L2) no score of theirs. */
  private seat(conn: ConnectionId, slot: string) {
    this.holder.set(slot, conn);
    this.slotOf.set(conn, slot);
    this.lastSeq.set(slot, -1);
    this.acked.set(slot, -1);
    this.ackTick.set(slot, this.space.tick);
    this.lastInputTick.set(slot, this.space.tick);
    if (!this.space.ids.includes(slot)) return;
    // From the bot to the person: nothing of the bot's last intent carries on, and (in a match) none of its score.
    this.space.clearInput(slot);
    if (this.current && !this.social) this.current.resetScore(slot);
  }

  /** L2: in a lobby room's lobby, the free seats go to the watchers, longest-present first. */
  private promote() {
    let changed = false;
    for (const conn of this.arrivals) {
      if (this.slotOf.get(conn)) continue;
      const free = this.freeSeat();
      if (!free) break;
      this.seat(conn, free);
      changed = true;
    }
    if (changed) this.lobby?.touch();
    return changed;
  }

  /** A connection left: its slot (if any) goes back to its bot at once, with no input of the person's left held. */
  disconnect(conn: ConnectionId) {
    const at = this.arrivals.indexOf(conn);
    if (at >= 0) this.arrivals.splice(at, 1);
    const slot = this.slotOf.get(conn) ?? null;
    this.slotOf.delete(conn);
    this.identity.delete(conn);
    this.looks.delete(conn);
    this.presses.delete(conn);
    if (slot && this.holder.get(slot) === conn) {
      this.holder.set(slot, null);
      this.lastSeq.delete(slot);
      this.acked.delete(slot);
      this.ackTick.delete(slot);
      const space = this.live;
      if (space?.ids.includes(slot)) {
        space.clearInput(slot);
        // L2: in a match without bots nobody takes the fighter over: it forfeits.
        if (this.current && !this.social && this.lobby && !this.settings.bots && this.lobby.phase === 'playing') this.current.forfeit(slot);
      }
      this.bots[this.ids.indexOf(slot)].reset(this.snapshot.round + 1000 * this.matches);
    }
    const life = this.lobby;
    // A room already disposed (its last sockets closing after it): nothing more to keep.
    if (!life || !this.live) return;
    life.leave(conn, this.view());
    if (life.phase === 'lobby') this.promote();
  }

  /** Whether a person holds this seat (an ambient bot's id, never a seat, is nobody's). */
  private held(id: string): boolean {
    return (this.holder.get(id) ?? null) !== null;
  }

  /** The slot a connection drives, or null. */
  slot(conn: ConnectionId): string | null {
    return this.slotOf.get(conn) ?? null;
  }

  /**
   * A message from a connection, as raw text. A valid input from the slot's
   * holder, newer than the last, becomes that slot's intent (its one-shot
   * requests wait in the match until a step takes them). A ping is answered.
   * Everything else is ignored. Returns the reply to send, if any.
   */
  receive(conn: ConnectionId, raw: unknown): PongMessage | null {
    const msg = parseClientMessage(raw);
    if (!msg) return null;
    const space = this.live;
    if (!space) return null;
    if (msg.t === 'ping') return { t: 'pong', id: msg.id, ct: msg.ct, tick: space.tick };
    if (msg.t !== 'input' && msg.t !== 'throw') return null;
    const slot = this.slotOf.get(conn);
    if (!slot || this.holder.get(slot) !== conn || !space.ids.includes(slot)) return null;
    if (msg.t === 'throw') {
      // M11F: the match judges the throw (out of the round, budget, cooldown, floor); a refusal is silent. L4: none on the plaza.
      if (this.current && !this.social) this.current.throwBanana(slot, msg.x, msg.z);
      return null;
    }
    // A repeated or older message is refused before its press counts are read (L4.4A): it makes no action and raises no count.
    if (msg.seq <= (this.lastSeq.get(slot) ?? -1)) return null;
    let counter = this.presses.get(conn);
    if (!counter) this.presses.set(conn, (counter = new PressCounter()));
    const up = counter.take(msg.presses);
    this.lastSeq.set(slot, msg.seq);
    this.lastInputTick.set(slot, space.tick);
    const i = msg.intent;
    space.setInput(slot, { ...i, jump: i.jump || up.jump, punch: i.punch || up.punch, grab: i.grab || up.grab });
    return null;
  }

  /**
   * This connection has proven it holds `pubkey` (null: it dropped its
   * identity). Returns whether the roster changed (a spectator's identity
   * shows nowhere yet).
   */
  setIdentity(conn: ConnectionId, pubkey: string | null): boolean {
    if (!this.slotOf.has(conn)) return false;
    const before = this.identity.get(conn) ?? null;
    if (pubkey) this.identity.set(conn, pubkey);
    else this.identity.delete(conn);
    // A look belongs to the identity that declared it: another pubkey, or none, starts with the default.
    if (before !== pubkey) this.looks.delete(conn);
    return before !== pubkey && this.slotOf.get(conn) !== null;
  }

  /**
   * M9C: this connection's fighter wears `form` (null: the default). Only a
   * connection with a proven identity, in a slot, for a Blobbi address that
   * identity owns; the seed is derived here. Returns whether the roster
   * changed, or why the look was refused. Nothing of the match is touched.
   */
  setLook(conn: ConnectionId, form: LookDeclaration | null): { ok: true; changed: boolean } | { ok: false; reason: LookReason } {
    if (!this.slotOf.has(conn)) return { ok: false, reason: 'spectator' };
    const pubkey = this.identity.get(conn);
    if (!pubkey) return { ok: false, reason: 'no-identity' };
    if (this.slotOf.get(conn) === null) return { ok: false, reason: 'spectator' };
    const bound = form ? bindLook(pubkey, form) : null;
    if (form && !bound) return { ok: false, reason: 'not-yours' };
    const before = this.looks.get(conn) ?? null;
    if (bound) this.looks.set(conn, bound);
    else this.looks.delete(conn);
    return { ok: true, changed: !sameForm(before, bound) };
  }

  /** The form a connection's fighter wears, or null. */
  lookOf(conn: ConnectionId): SlotForm | null {
    return this.looks.get(conn) ?? null;
  }

  /** The pubkey a connection has proven, or null. */
  identityOf(conn: ConnectionId): string | null {
    return this.identity.get(conn) ?? null;
  }

  /** Per slot: a bot, a guest, or the pubkey its connection proved. */
  roster(): RosterMessage {
    const slots: Record<string, SlotIdentity> = {};
    for (const id of this.ids) {
      const conn = this.holder.get(id) ?? null;
      const pubkey = conn === null ? null : this.identity.get(conn);
      const form = conn === null ? null : this.looks.get(conn);
      // L2: in a lobby room without bots, a seat nobody holds is empty, not a bot's; L4.1: on the public plaza always.
      const nobody: SlotIdentity = this.isPlaza || (this.lobby && !this.settings.bots) ? { who: 'empty' } : { who: 'bot' };
      slots[id] = conn === null ? nobody : pubkey ? { who: 'nostr', pubkey, ...(form ? { form } : {}) } : { who: 'guest' };
    }
    return { t: 'roster', slots };
  }

  /** One fixed step of the match: bots decide for their fighters, then the match advances by exactly dt. */
  tick() {
    if (this.isPlaza) return this.tickPlaza();
    if (this.lobby) return this.tickLobby(this.lobby);
    this.drive();
    const events = this.match.step(this.dt);
    this.snapshot = this.match.snapshot();
    for (const e of events) {
      if (e.kind === 'newRound') this.resetBots();
      if (e.kind === 'match') this.matchOverFor = 0;
    }
    // A won match: the arena settles, then the next match starts by itself.
    if (this.snapshot.phase === 'matchOver') {
      this.matchOverFor += this.dt;
      if (this.matchOverFor >= NET.nextMatchDelay) {
        this.matches += 1;
        // M11A: a rotating room moves to another arena with the new match.
        if (this.rotate) this.match.switchArena(nextArena(this.match.arena.id, this.random()));
        this.match.restart();
        this.snapshot = this.match.snapshot();
        this.resetBots();
      }
    }
  }

  /**
   * This step's intents in the live space: a person's latest (let go of
   * when it stalls), and for every seat nobody holds a bot's: the match's
   * test opponent in a match, a stroll on the plaza (L4).
   */
  private drive() {
    const space = this.space;
    const s = this.snapshot;
    const playing = s.phase === 'playing';
    const onPlaza = space === this.social;
    const timeout = Math.round(NET.inputTimeout * this.tickHz);
    const where = (id: string) => s.fighters.find((f) => f.id === id)?.position ?? null;
    const people = onPlaza ? space.ids.filter((id) => this.held(id)).flatMap((id) => where(id) ?? []) : [];
    space.ids.forEach((id) => {
      if (this.held(id)) {
        // A person whose inputs stopped arriving (a stalled tab) does not keep running.
        if (space.tick - (this.lastInputTick.get(id) ?? 0) > timeout) space.setInput(id, {});
        const seq = this.lastSeq.get(id) ?? -1;
        if (seq !== this.acked.get(id)) {
          this.acked.set(id, seq);
          // The step about to run is the first to apply it.
          this.ackTick.set(id, space.tick + 1);
        }
        return;
      }
      // L4.1: an ambient bot strolls the public plaza.
      const ambientWalk = this.ambientWalks.get(id);
      if (onPlaza && ambientWalk) {
        const at = where(id);
        space.setInput(id, at ? ambientWalk.plan({ x: at.x, z: at.z }, people, this.dt) : {});
        return;
      }
      // L2: a lobby room without bots: nobody drives a fighter whose person left.
      if (this.isPlaza || (this.lobby && !this.settings.bots)) return space.setInput(id, {});
      const seat = this.ids.indexOf(id);
      if (onPlaza) {
        const at = where(id);
        space.setInput(id, at ? this.wanderers[seat].plan({ x: at.x, z: at.z }, people, this.dt) : {});
        return;
      }
      const bot = this.bots[seat];
      const f = s.fighters.find((x) => x.id === id);
      bot.enabled = playing && !!f && !f.eliminated;
      bot.plan(botWorldFrom(s, id), this.dt);
      space.setInput(id, bot.read());
    });
  }

  /**
   * L1, L4: a lobby room's step. The live space steps (the plaza, or the
   * match in play and its results; the match stands still after the
   * countdown's swap), then the lifecycle moves on, and at its swap ticks
   * the space is swapped.
   */
  private tickLobby(life: Lifecycle) {
    let events: ReturnType<RumbleMatch['step']> = [];
    if (this.social) {
      // The plaza: watchers seated as seats free up, the avatars follow the lineup, everyone walks.
      if (life.phase === 'lobby') this.promote();
      this.social.setLineup(this.nextLineup());
      this.snapshot = this.social.snapshot();
      this.drive();
      this.social.step(this.dt);
    } else if (life.phase === 'playing' || life.phase === 'results') {
      this.drive();
      events = this.match.step(this.dt);
    } else this.match.idle(this.dt);
    this.snapshot = this.space.snapshot();
    for (const e of events) if (e.kind === 'newRound') this.resetBots();
    const now = this.space.tick;
    if (life.phase === 'playing') {
      const won = events.find((e) => e.kind === 'match');
      // L2: the people still in the match; without them it is over: nobody left (abandoned), or one left without bots (theirs by forfeit).
      const people = this.match.ids.filter((id) => this.held(id));
      if (won) life.finish(now, this.results(won.who ?? null, 'won'));
      else if (people.length === 0) life.finish(now, this.results(null, 'abandoned'));
      else if (!this.settings.bots && people.length === 1) life.finish(now, this.results(people[0], 'forfeit'));
    }
    for (const fx of life.advance(now, this.view())) {
      if (fx === 'swapIn') this.toArena();
      else if (fx === 'swapOut') {
        this.matches += 1;
        // M11A: a rotating room moves to another arena with the new match (named in the lobby, before it starts).
        if (this.settings.rotate) this.settings.arena = nextArena(this.settings.arena as ArenaId, this.random()).id;
        this.toPlaza();
      }
    }
    // A countdown cancelled after its swap: the room is in its lobby again, so on the plaza.
    if (life.phase === 'lobby' && !this.social) this.toPlaza();
  }

  /**
   * L4.1: the public plaza's step: the avatars are the people seated and the
   * ambient bots; everyone walks. The number of ambient bots follows how
   * many people are there, once the change has settled.
   */
  private tickPlaza() {
    const social = this.social!;
    const people = this.ids.filter((id) => this.held(id));
    this.settleAmbient(people.length, social.tick);
    social.setLineup([...people, ...this.ambient]);
    this.snapshot = social.snapshot();
    this.drive();
    social.step(this.dt);
    this.snapshot = social.snapshot();
  }

  /** L4.1: one ambient bot more or fewer, once the wanted number has differed for the settle time: added on a free far corner, removed furthest from anyone. */
  private settleAmbient(people: number, tick: number) {
    const want = AMBIENT.forPeople(people);
    if (want === this.ambient.length) {
      this.ambientPending = null;
      return;
    }
    this.ambientPending ??= tick;
    if (tick - this.ambientPending < Math.round(AMBIENT.settleSeconds * this.tickHz)) return;
    this.ambientPending = null;
    if (want > this.ambient.length) {
      const id = AMBIENT.ids.find((b) => !this.ambient.includes(b))!;
      this.ambientWalks.get(id)!.reset(tick);
      this.ambient = AMBIENT.ids.filter((b) => b === id || this.ambient.includes(b));
      return;
    }
    const at = (id: string) => this.snapshot.fighters.find((f) => f.id === id)?.position;
    const humans = this.ids.flatMap((id) => (this.held(id) ? (at(id) ?? []) : []));
    const distance = (id: string) => {
      const p = at(id);
      return p ? Math.min(Infinity, ...humans.map((h) => Math.hypot(h.x - p.x, h.z - p.z))) : Infinity;
    };
    const leaving = [...this.ambient].sort((a, b) => distance(b) - distance(a))[0];
    this.ambient = this.ambient.filter((b) => b !== leaving);
  }

  /** L2: the fighters of the next match: every seat with bots, only the seated people's without. */
  private nextLineup(): string[] {
    return this.settings.bots ? [...this.ids] : this.ids.filter((id) => this.held(id));
  }

  /** L4: the countdown's swap: the plaza goes; the match comes, on the room's arena, with the lineup, its tick and clock carried on. */
  private toArena() {
    const from = this.space;
    const ids = this.nextLineup();
    this.current = createRumbleMatch({ havok: this.havok, players: ids.map((id) => ({ id })), arena: arenaById(this.settings.arena) ?? CLASSIC, startTick: from.tick, startTime: from.time });
    this.social?.dispose();
    this.social = null;
    this.snapshot = this.current.snapshot();
    this.resetBots();
  }

  /** L4: back to the lobby: the match goes; the plaza comes, every avatar on its spot, its tick and clock carried on. */
  private toPlaza() {
    const from = this.space;
    this.social = new SocialSpace({ havok: this.havok, seats: this.ids, players: this.nextLineup(), startTick: from.tick, startTime: from.time });
    this.current?.dispose();
    this.current = null;
    this.wanderers.forEach((w) => w.reset(this.matches));
    this.snapshot = this.social.snapshot();
  }

  /** L1: what the lifecycle needs to know about the room now. */
  private view(): LifecycleView {
    const humans = this.arrivals.filter((c) => this.slotOf.get(c));
    return { humans, members: [...this.arrivals], bots: this.settings.bots };
  }

  /**
   * L2: a lobby request from a connection: ready (a seated person, in the
   * lobby or countdown), start (the owner, in the lobby, never below the
   * minimum), settings (the owner, in the lobby only: bots, the arena, which
   * is shown at once, rotation). Returns why it was refused, or null. The
   * server decides everything; nothing a client says about ownership or
   * readiness is taken but the request itself.
   */
  command(conn: ConnectionId, cmd: LobbyCommand): LobbyRefusal | null {
    const life = this.lobby;
    if (!life) return 'no-lobby';
    if (!this.slotOf.has(conn)) return 'spectator';
    const view = this.view();
    if (cmd.t === 'ready') return life.setReady(conn, cmd.ready, view);
    if (cmd.t === 'start') return life.ownerStart(conn, this.space.tick, view);
    const refused = life.maySet(conn);
    if (refused) return refused;
    const arena = cmd.arena === undefined ? undefined : arenaById(cmd.arena);
    if (arena === null) return 'malformed';
    if (cmd.bots !== undefined) this.settings.bots = cmd.bots;
    if (cmd.rotate !== undefined) this.settings.rotate = cmd.rotate;
    // L4: the next match's arena (named on the plaza's sign; played from the countdown's swap).
    if (arena) this.settings.arena = arena.id;
    life.touch();
    return null;
  }

  /** L1: how the match ended, per fighter: who drives it now and its score. */
  private results(winner: string | null, reason: MatchResults['reason']): MatchResults {
    const slots = this.roster().slots;
    return { winner, reason, arena: this.match.arena.id, fighters: this.snapshot.fighters.map((f) => ({ id: f.id, who: slots[f.id] ?? { who: 'bot' }, score: f.score })) };
  }

  /** L1: a lobby room's state, as one connection hears it (its own seat); null for a continuous room. */
  lobbyFor(conn: ConnectionId): LobbyMessage | null {
    const life = this.lobby;
    if (!life) return null;
    const view = this.view();
    return {
      t: 'lobby',
      phase: life.phase,
      since: life.since,
      deadline: life.deadline,
      transition: life.transition,
      you: this.slotOf.get(conn) ?? null,
      owner: life.owner === null ? null : (this.slotOf.get(life.owner) ?? null),
      youOwn: life.owner === conn,
      seated: this.ids.filter((id) => this.held(id)),
      watchers: this.arrivals.filter((c) => !this.slotOf.get(c)).map((c): SlotIdentity => {
        const pubkey = this.identity.get(c);
        return pubkey ? { who: 'nostr', pubkey } : { who: 'guest' };
      }),
      forced: life.forced,
      ready: this.ids.filter((id) => {
        const holder = this.holder.get(id);
        return holder !== null && holder !== undefined && life.ready.has(holder);
      }),
      lineup: life.phase === 'lobby' || life.phase === 'countdown' ? this.nextLineup() : [...(this.live?.ids ?? [])],
      settings: { ...this.settings },
      canStart: life.canStart(view),
      need: minHumans(this.settings.bots),
      results: life.results,
    };
  }

  /** L1: bumped whenever any connection's lobby message would change. */
  get lobbyVersion(): number {
    return this.lobby?.version ?? 0;
  }

  /** The state message for the match as it stands. */
  state(): StateMessage {
    const control: Record<string, Control> = {};
    const acks: Record<string, number> = {};
    const ackTicks: Record<string, number> = {};
    for (const id of this.space.ids) {
      // L4.1: the public plaza's ambient bots are bots; its unheld seats are not in it at all.
      control[id] = this.held(id) ? 'human' : this.ambientWalks.has(id) ? 'bot' : this.lobby && !this.settings.bots ? 'none' : 'bot';
      if (this.held(id)) {
        acks[id] = this.acked.get(id) ?? -1;
        ackTicks[id] = this.ackTick.get(id) ?? this.snapshot.tick;
      }
    }
    return { t: 'state', tick: this.snapshot.tick, time: this.snapshot.time, snapshot: this.snapshot, control, acks, ackTicks };
  }

  get latest(): MatchSnapshot {
    return this.snapshot;
  }

  dispose() {
    this.social?.dispose();
    this.current?.dispose();
    this.social = null;
    this.current = null;
  }

  private resetBots() {
    this.bots.forEach((b) => b.reset(this.snapshot.round + 1000 * this.matches));
  }
}
