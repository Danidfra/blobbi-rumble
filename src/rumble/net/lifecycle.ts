/**
 * A PRIVATE ROOM'S LIFECYCLE (L1, L2): the stages a lobby room goes through
 * between matches, as pure state over the room's own tick. No match, no
 * socket, no renderer: the host (`host.ts`) asks it what to do and applies
 * the answer to its match.
 *
 *   LOBBY ──start──► COUNTDOWN ──deadline──► PLAYING ──match won──► RESULTS ──deadline──► LOBBY
 *     ▲                  │ (a lineup member left, too few people)                         │
 *     └──── cancelled ───┘                                                                │
 *     └───────────────────────────────────────────────────────────────────────────────────┘
 *
 * The OPEN room (and any room made by a client that does not speak the
 * lobby) has no lifecycle: it plays continuously, as it always has.
 *
 * TRANSITIONS. Every change of place is announced ahead, in ticks, as a
 * `Transition`: bodies leave their places from `departAt`, the authoritative
 * swap (the match restarted on its arena, every fighter at its spawn)
 * happens on `swapAt`, and the arrival is complete by `arriveBy`. A client
 * may draw anything over that window (a fade now; later the teleport, whose
 * departure and arrival take about the same times); the server's facts do
 * not depend on what is drawn. A countdown cancelled before its swap has
 * moved nothing, so a client can turn the departure back.
 *
 * STARTING (L2). Each seated person may say they are ready (bots always
 * are). When every seated person is ready and the minimum is met (one
 * person with bots, two without), the countdown starts by itself. The
 * room's OWNER may also start it while some are not ready, never below the
 * minimum. A countdown is cancelled when someone it started with leaves,
 * when the room falls below the minimum, or (unless the owner forced it)
 * when someone stops being ready. Back from the results, everyone is
 * unready again.
 *
 * OWNERSHIP (L2) belongs to a connection, like an identity: the room's
 * first connection owns it; when the owner leaves, the longest-present
 * seated person takes over (else the longest-present watcher; else nobody,
 * and the next to arrive owns it). It survives every stage.
 *
 * Everything here is decided by the server: no client says which stage a
 * room is in, who owns it, who is ready, or when a match starts.
 */
import type { ConnectionId } from './host';
import type { LifecyclePhase, LobbyRefusalReason, MatchResults, Transition } from './protocol';

export const LIFECYCLE = Object.freeze({
  /** Leaving the lobby (the countdown's first part), then the swap, seconds. */
  departSeconds: 2.3,
  /** Arriving on the arena (the countdown's second part), then play, seconds. */
  arriveSeconds: 2.6,
  /** The results stay up this long; the return to the lobby is the end of it, seconds. */
  resultsSeconds: 8,
});

export type LifecycleRules = typeof LIFECYCLE;

/** What the host tells the lifecycle about the room each time it asks. */
export interface LifecycleView {
  /** The connections that hold a seat (people, not bots), in the order they joined. */
  humans: readonly ConnectionId[];
  /** Every connection in the room (seated or watching), in the order they joined. */
  members: readonly ConnectionId[];
  /** Whether bots fill the seats nobody holds. */
  bots: boolean;
}

/** What the host must do now: swap the match onto its arena, start play, go back to the lobby. */
export type LifecycleEffect = 'swapIn' | 'play' | 'swapOut';

/** The fewest seated people a match may start with: one against bots, two without. */
export const minHumans = (bots: boolean) => (bots ? 1 : 2);

/** Why a request about the room was refused. */
export type LobbyRefusal = LobbyRefusalReason;

export class Lifecycle {
  phase: LifecyclePhase = 'lobby';
  /** The tick the phase began on. */
  since: number;
  /** The tick the phase ends on by itself, or null (the lobby, play). */
  deadline: number | null = null;
  transition: Transition | null = null;
  /** The people the countdown started with: if one leaves, it is cancelled. */
  lineup: ConnectionId[] = [];
  /** The last match's outcome, kept until the next countdown. */
  results: MatchResults | null = null;
  /** Bumped on every change a client should hear about. */
  version = 0;
  /** L2: the owning connection (null: nobody is in the room). */
  owner: ConnectionId | null = null;
  /** L2: the seated people who said they are ready. */
  readonly ready = new Set<ConnectionId>();
  /** L2: the running countdown was the owner's, not everyone's readiness. */
  forced = false;
  private swapped = false;

  constructor(
    private readonly tickHz: number,
    start: number,
    private readonly rules: LifecycleRules = LIFECYCLE,
  ) {
    this.since = start;
  }

  private ticks(seconds: number) {
    return Math.max(1, Math.round(seconds * this.tickHz));
  }

  /** Mark a change clients should hear about (a seat, a setting). */
  touch() {
    this.version += 1;
  }

  /** Whether a match could start with these people. */
  canStart(view: LifecycleView) {
    return view.humans.length >= minHumans(view.bots);
  }

  /** Whether every seated person is ready (bots always are). */
  allReady(view: LifecycleView) {
    return view.humans.length > 0 && view.humans.every((c) => this.ready.has(c));
  }

  /** Whether the room wants to start now by itself: everyone ready, the minimum met. */
  private wantsStart(view: LifecycleView) {
    return this.canStart(view) && this.allReady(view);
  }

  /** Whether a running countdown must stop. */
  private mustCancel(view: LifecycleView) {
    return !this.canStart(view) || this.lineup.some((c) => !view.humans.includes(c)) || (!this.forced && !this.allReady(view));
  }

  /** L2: a connection arrived: the first owns the room. */
  join(conn: ConnectionId) {
    this.owner ??= conn;
    this.touch();
  }

  /** L2: a connection left: it is no longer ready; ownership passes on if it was the owner. */
  leave(conn: ConnectionId, view: LifecycleView) {
    this.ready.delete(conn);
    if (this.owner === conn) this.owner = view.humans.find((c) => c !== conn) ?? view.members.find((c) => c !== conn) ?? null;
    this.touch();
  }

  /** L2: a seated person says they are (or are not) ready: in the lobby and the countdown only. */
  setReady(conn: ConnectionId, on: boolean, view: LifecycleView): LobbyRefusal | null {
    if (!view.humans.includes(conn)) return 'spectator';
    if (this.phase !== 'lobby' && this.phase !== 'countdown') return 'phase';
    if (this.ready.has(conn) === on) return null;
    if (on) this.ready.add(conn);
    else this.ready.delete(conn);
    this.touch();
    return null;
  }

  /** L2: the owner starts the match without waiting for everyone to be ready (never below the minimum). */
  ownerStart(conn: ConnectionId, now: number, view: LifecycleView): LobbyRefusal | null {
    if (conn !== this.owner) return 'not-owner';
    if (this.phase !== 'lobby') return 'phase';
    if (this.arriving(now)) return 'busy';
    if (!this.canStart(view)) return 'too-few';
    this.start(now, view, true);
    return null;
  }

  /** L2: whether `conn` may change the room's settings now (the owner, in the lobby). */
  maySet(conn: ConnectionId): LobbyRefusal | null {
    if (conn !== this.owner) return 'not-owner';
    if (this.phase !== 'lobby') return 'phase';
    return null;
  }

  /** Whether the return to the lobby is still arriving (nothing starts until it is over). */
  arriving(now: number) {
    return this.phase === 'lobby' && !!this.transition && now < this.transition.arriveBy;
  }

  /** Begin the countdown, if this is the lobby, the return is over and the minimum is met (`forced`: by the owner). */
  start(now: number, view: LifecycleView, forced = false): boolean {
    if (this.phase !== 'lobby' || this.arriving(now) || !this.canStart(view)) return false;
    this.forced = forced;
    const swapAt = now + this.ticks(this.rules.departSeconds);
    const arriveBy = swapAt + this.ticks(this.rules.arriveSeconds);
    this.enter('countdown', now, arriveBy, { kind: 'toArena', departAt: now, swapAt, arriveBy });
    this.lineup = [...view.humans];
    this.swapped = false;
    this.results = null;
    return true;
  }

  /** The match was decided (or given up): show the results, then go back to the lobby. */
  finish(now: number, results: MatchResults): boolean {
    if (this.phase !== 'playing') return false;
    const swapAt = now + this.ticks(this.rules.resultsSeconds);
    const departAt = Math.max(now, swapAt - this.ticks(this.rules.departSeconds));
    this.enter('results', now, swapAt, { kind: 'toLobby', departAt, swapAt, arriveBy: swapAt + this.ticks(this.rules.arriveSeconds) });
    this.results = results;
    this.lineup = [];
    return true;
  }

  /** One tick's decisions: start, cancel, swap, play, return. */
  advance(now: number, view: LifecycleView): LifecycleEffect[] {
    const fx: LifecycleEffect[] = [];
    if (this.phase === 'lobby') {
      // The last return's arrival is over: nothing left to announce.
      if (this.transition && now >= this.transition.arriveBy) {
        this.transition = null;
        this.touch();
      }
      if (this.wantsStart(view)) this.start(now, view);
    } else if (this.phase === 'countdown') {
      if (this.mustCancel(view)) this.cancel(now);
      else {
        if (!this.swapped && now >= this.transition!.swapAt) {
          this.swapped = true;
          fx.push('swapIn');
        }
        if (now >= this.deadline!) {
          this.enter('playing', now, null, null);
          this.lineup = [];
          this.forced = false;
          fx.push('play');
        }
      }
    } else if (this.phase === 'results' && now >= this.deadline!) {
      // Back to the lobby, everyone unready; the return's arrival is still announced until it is over.
      this.ready.clear();
      this.enter('lobby', now, null, this.transition);
      fx.push('swapOut');
    }
    return fx;
  }

  /** Stop the countdown: back to the lobby (with whatever the swap already did). */
  cancel(now: number) {
    if (this.phase !== 'countdown') return;
    this.enter('lobby', now, null, null);
    this.lineup = [];
    this.forced = false;
  }

  private enter(phase: LifecyclePhase, now: number, deadline: number | null, transition: Transition | null) {
    this.phase = phase;
    this.since = now;
    this.deadline = deadline;
    this.transition = transition;
    this.touch();
  }
}
