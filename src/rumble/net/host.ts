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
 */
import { BotInput, botWorldFrom } from '../control/bot';
import { createRumbleMatch, type RumbleMatch } from '../sim/match';
import type { HavokInstance } from '../sim/physics';
import type { MatchSnapshot } from '../sim/snapshot';
import { parseClientMessage, type Control, type PongMessage, type StateMessage, type WelcomeMessage } from './protocol';

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

  constructor(config: HostConfig) {
    const ids = config.players ?? ['P1', 'P2', 'P3', 'P4'];
    this.tickHz = config.tickHz ?? NET.tickHz;
    this.snapshotHz = config.snapshotHz ?? NET.snapshotHz;
    if (this.tickHz % this.snapshotHz !== 0) throw new Error('snapshotHz must divide tickHz');
    this.dt = 1 / this.tickHz;
    this.match = createRumbleMatch({ havok: config.havok, players: ids.map((id) => ({ id })) });
    this.ids = this.match.ids;
    this.bots = this.ids.map((_, i) => new BotInput(i + 1));
    for (const id of this.ids) this.holder.set(id, null);
    this.snapshot = this.match.snapshot();
  }

  /** Steps between two states sent. */
  get ticksPerSnapshot() {
    return this.tickHz / this.snapshotHz;
  }

  /** A new connection: the first free slot is its, or none (it watches). */
  connect(conn: ConnectionId): WelcomeMessage {
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
    return { t: 'welcome', you: free, players: [...this.ids], tickHz: this.tickHz, snapshotHz: this.snapshotHz };
  }

  /** A connection left: its slot (if any) goes back to its bot at once, with no input of the person's left held. */
  disconnect(conn: ConnectionId) {
    const slot = this.slotOf.get(conn) ?? null;
    this.slotOf.delete(conn);
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
    const slot = this.slotOf.get(conn);
    if (!slot || this.holder.get(slot) !== conn) return null;
    if (msg.seq <= (this.lastSeq.get(slot) ?? -1)) return null;
    this.lastSeq.set(slot, msg.seq);
    this.lastInputTick.set(slot, this.match.tick);
    this.match.setInput(slot, msg.intent);
    return null;
  }

  /** One fixed step of the match: bots decide for their fighters, then the match advances by exactly dt. */
  tick() {
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
        this.match.restart();
        this.snapshot = this.match.snapshot();
        this.resetBots();
      }
    }
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
