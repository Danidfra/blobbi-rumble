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
 * LOBBY ROOMS (L1): a host made with `lifecycle: 'lobby'` does not play
 * continuously. Its `Lifecycle` (`lifecycle.ts`) decides the stage: in the
 * lobby and the countdown the match stands still (`match.idle`: time
 * passes, nothing moves, no input is taken); the countdown's swap restarts
 * the match on the room's arena; play is the match as ever; a won match
 * shows its results, then the room goes back to its lobby (rotating its
 * arena if it does). Without a lifecycle (the OPEN room, older clients'
 * rooms) everything is as before: the next match starts by itself.
 *
 * SEATS AND FIGHTERS (L2). `ids` are the room's seats (P1..P4); the match's
 * fighters are `match.ids`. In a continuous room, and in a lobby room with
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
import { createRumbleMatch, type RumbleMatch } from '../sim/match';
import type { HavokInstance } from '../sim/physics';
import type { MatchSnapshot } from '../sim/snapshot';
import { bindLook, sameForm, type LookDeclaration, type SlotForm } from './looks';
import { CLASSIC, arenaById, nextArena, type ArenaDef } from '../arena/arenas';
import { parseClientMessage, type Control, type LobbyCommand, type LobbyMessage, type LookReason, type MatchResults, type PongMessage, type RoomSettings, type RosterMessage, type SlotIdentity, type StateMessage, type WelcomeMessage } from './protocol';
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
  /** L1: 'lobby' for a room with the lobby lifecycle; continuous play otherwise (the default). */
  lifecycle?: 'continuous' | 'lobby';
}

export type ConnectionId = number;

export class RumbleHost {
  private current: RumbleMatch;
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
  /** Per slot: the last input sequence applied, the tick it arrived on, and what the latest step had applied. */
  private readonly lastSeq = new Map<string, number>();
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
    this.current = createRumbleMatch({ havok: config.havok, players: ids.map((id) => ({ id })), arena: config.arena ?? CLASSIC });
    this.ids = this.current.ids;
    this.bots = this.ids.map((_, i) => new BotInput(i + 1));
    for (const id of this.ids) this.holder.set(id, null);
    this.snapshot = this.match.snapshot();
    this.settings = { bots: true, arena: this.match.arena.id, rotate: this.rotate };
    this.lobby = config.lifecycle === 'lobby' ? new Lifecycle(this.tickHz, this.match.tick) : null;
  }

  /** The authoritative match (in a lobby room without bots, rebuilt for each match's lineup). */
  get match(): RumbleMatch {
    return this.current;
  }

  /** M11A: the arena in play. */
  get arena(): ArenaDef {
    return this.match.arena;
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
    return { t: 'welcome', you: free, players: [...this.match.ids], tickHz: this.tickHz, snapshotHz: this.snapshotHz, arena: { id: this.match.arena.id, rotate: this.settings.rotate } };
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
    this.ackTick.set(slot, this.match.tick);
    this.lastInputTick.set(slot, this.match.tick);
    if (!this.match.ids.includes(slot)) return;
    // From the bot to the person: nothing of the bot's last intent carries on.
    this.match.clearInput(slot);
    this.match.resetScore(slot);
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
    if (slot && this.holder.get(slot) === conn) {
      this.holder.set(slot, null);
      this.lastSeq.delete(slot);
      this.acked.delete(slot);
      this.ackTick.delete(slot);
      if (this.match.ids.includes(slot)) {
        this.match.clearInput(slot);
        // L2: in a match without bots nobody takes the fighter over: it forfeits.
        if (this.lobby && !this.settings.bots && this.lobby.phase === 'playing') this.match.forfeit(slot);
      }
      this.bots[this.ids.indexOf(slot)].reset(this.snapshot.round + 1000 * this.matches);
    }
    const life = this.lobby;
    if (!life) return;
    life.leave(conn, this.view());
    if (life.phase === 'lobby') this.promote();
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
    if (msg.t === 'ping') return { t: 'pong', id: msg.id, ct: msg.ct, tick: this.match.tick };
    if (msg.t !== 'input' && msg.t !== 'throw') return null;
    const slot = this.slotOf.get(conn);
    if (!slot || this.holder.get(slot) !== conn || !this.match.ids.includes(slot)) return null;
    if (msg.t === 'throw') {
      // M11F: the match judges the throw (out of the round, budget, cooldown, floor); a refusal is silent.
      this.match.throwBanana(slot, msg.x, msg.z);
      return null;
    }
    if (msg.seq <= (this.lastSeq.get(slot) ?? -1)) return null;
    this.lastSeq.set(slot, msg.seq);
    this.lastInputTick.set(slot, this.match.tick);
    this.match.setInput(slot, msg.intent);
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
      // L2: in a lobby room without bots, a seat nobody holds is empty, not a bot's.
      const nobody: SlotIdentity = this.lobby && !this.settings.bots ? { who: 'empty' } : { who: 'bot' };
      slots[id] = conn === null ? nobody : pubkey ? { who: 'nostr', pubkey, ...(form ? { form } : {}) } : { who: 'guest' };
    }
    return { t: 'roster', slots };
  }

  /** One fixed step of the match: bots decide for their fighters, then the match advances by exactly dt. */
  tick() {
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

  /** This step's intents: a person's latest (let go of when it stalls), a bot's plan for every seat nobody holds. */
  private drive() {
    const s = this.snapshot;
    const playing = s.phase === 'playing';
    const timeout = Math.round(NET.inputTimeout * this.tickHz);
    this.match.ids.forEach((id, i) => {
      if (this.holder.get(id) !== null) {
        // A person whose inputs stopped arriving (a stalled tab) does not keep running.
        if (this.match.tick - (this.lastInputTick.get(id) ?? 0) > timeout) this.match.setInput(id, {});
        const seq = this.lastSeq.get(id) ?? -1;
        if (seq !== this.acked.get(id)) {
          this.acked.set(id, seq);
          // The step about to run is the first to apply it.
          this.ackTick.set(id, this.match.tick + 1);
        }
        return;
      }
      // L2: a lobby room without bots: nobody drives a fighter whose person left.
      if (this.lobby && !this.settings.bots) return this.match.setInput(id, {});
      const bot = this.bots[this.ids.indexOf(id)];
      bot.enabled = playing && !s.fighters[i].eliminated;
      bot.plan(botWorldFrom(s, id), this.dt);
      this.match.setInput(id, bot.read());
    });
  }

  /** L1: a lobby room's step: the match plays only while the lifecycle says so, and the lifecycle moves on. */
  private tickLobby(life: Lifecycle) {
    const live = life.phase === 'playing' || life.phase === 'results';
    let events: ReturnType<RumbleMatch['step']> = [];
    if (live) {
      this.drive();
      events = this.match.step(this.dt);
    } else this.match.idle(this.dt);
    this.snapshot = this.match.snapshot();
    for (const e of events) if (e.kind === 'newRound') this.resetBots();
    const now = this.match.tick;
    if (life.phase === 'playing') {
      const won = events.find((e) => e.kind === 'match');
      // L2: the people still in the match; without them it is over: nobody left (abandoned), or one left without bots (theirs by forfeit).
      const people = this.match.ids.filter((id) => this.holder.get(id) !== null);
      if (won) life.finish(now, this.results(won.who ?? null, 'won'));
      else if (people.length === 0) life.finish(now, this.results(null, 'abandoned'));
      else if (!this.settings.bots && people.length === 1) life.finish(now, this.results(people[0], 'forfeit'));
    }
    if (life.phase === 'lobby') this.promote();
    for (const fx of life.advance(now, this.view())) {
      if (fx === 'swapIn') this.buildLineup();
      else if (fx === 'swapOut') {
        this.matches += 1;
        // M11A: a rotating room moves to another arena with the new match (shown in the lobby, before it starts).
        if (this.settings.rotate) this.settings.arena = nextArena(this.match.arena.id, this.random()).id;
        this.restartOn(this.settings.arena);
      }
    }
  }

  /** L2: the fighters of the next match: every seat with bots, only the seated people's without. */
  private nextLineup(): string[] {
    return this.settings.bots ? [...this.ids] : this.ids.filter((id) => this.holder.get(id) !== null);
  }

  /** L2: the countdown's swap: the match restarted on the room's arena with its lineup (a new match when the lineup changed). */
  private buildLineup() {
    const ids = this.nextLineup();
    const same = ids.length === this.match.ids.length && ids.every((id, i) => id === this.match.ids[i]);
    if (same || ids.length < 2) return this.restartOn(this.settings.arena);
    const old = this.current;
    this.current = createRumbleMatch({ havok: this.havok, players: ids.map((id) => ({ id })), arena: arenaById(this.settings.arena) ?? old.arena, startTick: old.tick, startTime: old.time });
    old.dispose();
    this.snapshot = this.match.snapshot();
    this.resetBots();
  }

  /** The match back to its start on `arena` (switched if it is another): scores, rounds, fighters at their spawns. */
  private restartOn(arena: string) {
    const def = arenaById(arena) ?? this.match.arena;
    if (def.id !== this.match.arena.id) this.match.switchArena(def);
    this.match.restart();
    this.snapshot = this.match.snapshot();
    this.resetBots();
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
    if (cmd.t === 'start') return life.ownerStart(conn, this.match.tick, view);
    const refused = life.maySet(conn);
    if (refused) return refused;
    const arena = cmd.arena === undefined ? undefined : arenaById(cmd.arena);
    if (arena === null) return 'malformed';
    if (cmd.bots !== undefined) this.settings.bots = cmd.bots;
    if (cmd.rotate !== undefined) this.settings.rotate = cmd.rotate;
    if (arena && arena.id !== this.settings.arena) {
      this.settings.arena = arena.id;
      // Shown in the lobby now (the match stands still there).
      this.restartOn(arena.id);
    }
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
      seated: this.ids.filter((id) => this.holder.get(id) !== null),
      ready: this.ids.filter((id) => {
        const holder = this.holder.get(id);
        return holder !== null && holder !== undefined && life.ready.has(holder);
      }),
      lineup: life.phase === 'lobby' || life.phase === 'countdown' ? this.nextLineup() : [...this.match.ids],
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
    for (const id of this.match.ids) {
      control[id] = this.holder.get(id) === null ? 'bot' : 'human';
      if (this.holder.get(id) !== null) {
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
    this.match.dispose();
  }

  private resetBots() {
    this.bots.forEach((b) => b.reset(this.snapshot.round + 1000 * this.matches));
  }
}
