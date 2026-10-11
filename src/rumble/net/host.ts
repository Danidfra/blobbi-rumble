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
 */
import { BotInput, botWorldFrom } from '../control/bot';
import { createRumbleMatch, type RumbleMatch } from '../sim/match';
import type { HavokInstance } from '../sim/physics';
import type { MatchSnapshot } from '../sim/snapshot';
import { bindLook, sameForm, type LookDeclaration, type SlotForm } from './looks';
import { CLASSIC, arenaById, nextArena, type ArenaDef } from '../arena/arenas';
import { parseClientMessage, type Control, type LobbyMessage, type LookReason, type MatchResults, type PongMessage, type RoomSettings, type RosterMessage, type SlotIdentity, type StateMessage, type WelcomeMessage } from './protocol';
import { Lifecycle, minHumans, type LifecycleView } from './lifecycle';

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
  readonly match: RumbleMatch;
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

  constructor(config: HostConfig) {
    const ids = config.players ?? ['P1', 'P2', 'P3', 'P4'];
    this.tickHz = config.tickHz ?? NET.tickHz;
    this.snapshotHz = config.snapshotHz ?? NET.snapshotHz;
    if (this.tickHz % this.snapshotHz !== 0) throw new Error('snapshotHz must divide tickHz');
    this.dt = 1 / this.tickHz;
    this.rotate = config.rotate === true;
    this.random = config.random ?? Math.random;
    this.match = createRumbleMatch({ havok: config.havok, players: ids.map((id) => ({ id })), arena: config.arena ?? CLASSIC });
    this.ids = this.match.ids;
    this.bots = this.ids.map((_, i) => new BotInput(i + 1));
    for (const id of this.ids) this.holder.set(id, null);
    this.snapshot = this.match.snapshot();
    this.settings = { bots: true, arena: this.match.arena.id, rotate: this.rotate };
    this.lobby = config.lifecycle === 'lobby' ? new Lifecycle(this.tickHz, this.match.tick) : null;
  }

  /** M11A: the arena in play. */
  get arena(): ArenaDef {
    return this.match.arena;
  }

  /** Steps between two states sent. */
  get ticksPerSnapshot() {
    return this.tickHz / this.snapshotHz;
  }

  /** A new connection: the first free slot is its, or none (it watches). */
  connect(conn: ConnectionId): WelcomeMessage {
    this.arrivals.push(conn);
    this.lobby?.touch();
    const free = this.ids.find((id) => this.holder.get(id) === null) ?? null;
    this.slotOf.set(conn, free);
    if (free) {
      this.holder.set(free, conn);
      // From the bot to the person: nothing of the bot's last intent carries on, and a fresh sequence starts.
      this.match.clearInput(free);
      this.lastSeq.set(free, -1);
      this.acked.set(free, -1);
      this.ackTick.set(free, this.match.tick);
      this.lastInputTick.set(free, this.match.tick);
    }
    return { t: 'welcome', you: free, players: [...this.ids], tickHz: this.tickHz, snapshotHz: this.snapshotHz, arena: { id: this.match.arena.id, rotate: this.rotate } };
  }

  /** A connection left: its slot (if any) goes back to its bot at once, with no input of the person's left held. */
  disconnect(conn: ConnectionId) {
    const at = this.arrivals.indexOf(conn);
    if (at >= 0) this.arrivals.splice(at, 1);
    this.lobby?.touch();
    const slot = this.slotOf.get(conn) ?? null;
    this.slotOf.delete(conn);
    this.identity.delete(conn);
    this.looks.delete(conn);
    if (!slot || this.holder.get(slot) !== conn) return;
    this.holder.set(slot, null);
    this.match.clearInput(slot);
    this.lastSeq.delete(slot);
    this.acked.delete(slot);
    this.ackTick.delete(slot);
    this.bots[this.ids.indexOf(slot)].reset(this.snapshot.round + 1000 * this.matches);
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
    if (!slot || this.holder.get(slot) !== conn) return null;
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
      slots[id] = conn === null ? { who: 'bot' } : pubkey ? { who: 'nostr', pubkey, ...(form ? { form } : {}) } : { who: 'guest' };
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
    this.ids.forEach((id, i) => {
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
      const bot = this.bots[i];
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
      if (won) life.finish(now, this.results(won.who ?? null, 'won'));
    }
    for (const fx of life.advance(now, this.view())) {
      if (fx === 'swapIn') this.restartOn(this.settings.arena);
      else if (fx === 'swapOut') {
        this.matches += 1;
        // M11A: a rotating room moves to another arena with the new match (shown in the lobby, before it starts).
        if (this.settings.rotate) this.settings.arena = nextArena(this.match.arena.id, this.random()).id;
        this.restartOn(this.settings.arena);
      }
    }
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
    return { humans, bots: this.settings.bots };
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
      lineup: [...this.match.ids],
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
    for (const id of this.ids) {
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
