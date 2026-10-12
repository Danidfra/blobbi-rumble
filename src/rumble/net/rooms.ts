/**
 * ROOMS: one server process, several independent matches. A room owns one
 * authoritative `RumbleHost` (and so one `RumbleMatch`, its own Havok
 * world, bots, slots, roster and restarts); nothing is shared between rooms
 * but the process and the Havok wasm instance. Transport-free: the
 * WebSocket server routes connections to rooms; this decides which rooms
 * exist.
 *
 *   OPEN      the open room: always there (Quick Match plays here), never reaped
 *   PLAZA     L4.1: the public social plaza: always there, never reaped; up
 *             to eight people walking it (one per connection: no watchers),
 *             no match ever; reached by clients that speak it only
 *   private   created on request with a fresh code; lives while anyone is in
 *             it, and for `graceMs` after the last connection leaves (so a
 *             dropped player can come back), then it is disposed. L4.5A: when
 *             every room is taken, the one empty the longest (at least
 *             `reclaimAfterMs`) is given up early to a new one; a room
 *             closed for inactivity (`expire`) goes as soon as it is empty.
 *             M10B: made
 *             LISTED (it appears in the public listing, for anyone on this
 *             server to join) or UNLISTED (reached by its code or link only;
 *             a code is an address, not a secret, so this is privacy from
 *             browsing, not access control)
 *
 * L1: a private room made by a client that speaks the lobby is a LOBBY
 * room (`lifecycle: 'lobby'`): its host runs the lobby lifecycle
 * (`lifecycle.ts`) instead of playing continuously. The open room never is.
 *
 * Rooms are casual: whoever runs the process is trusted with the result.
 * `mode` is recorded so a future value-bearing mode cannot be confused
 * with it; nothing reads it yet.
 */
import type { HavokInstance } from '../sim/physics';
import { CLASSIC, type ArenaDef } from '../arena/arenas';
import { RumbleHost, type ConnectionId } from './host';
import { PROTOCOL, type RoomListing } from './protocol';
import { OPEN_ROOM, PLAZA_ROOM, newRoomId, normalizeRoomId } from './roomId';

export const ROOMS = Object.freeze({
  /** Rooms at once, the open room included. */
  maxRooms: 16,
  /** Connections in one room: four players and four watching. */
  perRoom: 8,
  /** A private room with nobody in it is kept this long, ms. */
  graceMs: 120_000,
  /** L4.5A: when every room is taken, a private room empty at least this long, ms, may be given up to a new one. */
  reclaimAfterMs: 20_000,
});

export type RoomKind = 'open' | 'private' | 'plaza';
export type RoomMode = 'casual';

export interface Room {
  readonly id: string;
  readonly kind: RoomKind;
  readonly mode: RoomMode;
  /** M10B: in the public listing. The open room always; a code room as it was made. */
  readonly listed: boolean;
  /** M11A: the arena the room was made with; `host.arena` is the one in play (a rotation moves on). */
  readonly arena: ArenaDef;
  readonly rotate: boolean;
  /** L1: 'lobby' (the lobby lifecycle) or 'continuous' (the open room, and rooms made by pre-lobby clients). */
  readonly lifecycle: 'continuous' | 'lobby' | 'plaza';
  readonly host: RumbleHost;
  /** The connections in it (players and spectators). */
  readonly connections: Set<ConnectionId>;
  readonly createdAt: number;
  /** Since when it has had no connection (null: someone is in it). */
  emptySince: number | null;
  /**
   * L4.5A: when someone last did something in it that a person does
   * (`server.ts`: entering, moving, a press, a lobby request, a look; a
   * match being played), ms; and whether it is closing for inactivity.
   */
  activeAt: number;
  expired: boolean;
}

export interface RoomManagerConfig {
  havok: HavokInstance;
  tickHz?: number;
  snapshotHz?: number;
  maxRooms?: number;
  perRoom?: number;
  graceMs?: number;
  reclaimAfterMs?: number;
  now?: () => number;
  random?: (n: number) => number;
}

export class RoomManager {
  readonly open: Room;
  /** L4.1: the public plaza. */
  readonly plaza: Room;
  readonly maxRooms: number;
  readonly perRoom: number;
  readonly graceMs: number;
  readonly reclaimAfterMs: number;
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;

  constructor(private readonly config: RoomManagerConfig) {
    this.maxRooms = config.maxRooms ?? ROOMS.maxRooms;
    this.perRoom = config.perRoom ?? ROOMS.perRoom;
    this.graceMs = config.graceMs ?? ROOMS.graceMs;
    this.reclaimAfterMs = config.reclaimAfterMs ?? ROOMS.reclaimAfterMs;
    this.now = config.now ?? (() => Date.now());
    this.open = this.make(OPEN_ROOM, 'open');
    this.plaza = this.make(PLAZA_ROOM, 'plaza', true, CLASSIC, false, 'plaza');
  }

  get size() {
    return this.rooms.size;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** The room with this id (any spelling a person might type), or null. */
  get(raw: unknown): Room | null {
    const id = normalizeRoomId(raw);
    return id ? (this.rooms.get(id) ?? null) : null;
  }

  /** A new code room, listed or not (default: unlisted, as before M10), or null when the server holds as many as it may. */
  create(opts: { listed?: boolean; arena?: ArenaDef; rotate?: boolean; lifecycle?: 'continuous' | 'lobby' } = {}): Room | null {
    if (this.rooms.size >= this.maxRooms) return null;
    return this.make(newRoomId((id) => this.rooms.has(id), this.config.random), 'private', opts.listed === true, opts.arena ?? CLASSIC, opts.rotate === true, opts.lifecycle ?? 'continuous');
  }

  /**
   * M10B: the public rooms, counts only (never who is in them), bounded:
   * the open room first, then listed code rooms, busiest first. Unlisted
   * rooms are not here whatever the caller knows.
   */
  listing(): RoomListing[] {
    const t = this.now();
    const rows = this.all()
      .filter((r) => r.listed)
      .map((r): RoomListing => {
        const roster = r.host.roster().slots;
        const players = Object.values(roster).filter((s) => s.who !== 'bot' && s.who !== 'empty').length;
        const snap = r.host.latest;
        const life = r.host.lobby;
        return { id: r.id, kind: r.kind, players, maxPlayers: Object.keys(roster).length, spectators: Math.max(0, r.connections.size - players), maxConnections: this.perRoom, phase: r.kind === 'plaza' ? 'plaza' : life ? life.phase : snap.phase, round: snap.round, joinable: this.hasRoom(r), age: Math.max(0, Math.floor((t - r.createdAt) / 1000)), arena: r.host.arena.id, ...(life ? { lifecycle: 'lobby' as const } : {}) };
      });
    const rank = (k: RoomKind) => (k === 'plaza' ? 2 : k === 'open' ? 1 : 0);
    rows.sort((a, b) => rank(b.kind) - rank(a.kind) || b.players - a.players || a.age - b.age);
    return rows.slice(0, PROTOCOL.maxListedRooms);
  }

  /** Whether a connection would fit (L4.5A: never in a room closing for inactivity). */
  hasRoom(room: Room) {
    return !room.expired && room.connections.size < this.perRoom;
  }

  /** A connection entered the room (the caller then connects it to `room.host`). */
  enter(room: Room, conn: ConnectionId) {
    room.connections.add(conn);
    room.emptySince = null;
    room.activeAt = this.now();
  }

  /** L4.5A: private rooms that may still be made now (a slot free, or an empty room that may be reclaimed). */
  get free(): number {
    return this.maxRooms - this.rooms.size;
  }

  /**
   * L4.5A: every room is taken and someone wants a new one: the private
   * room empty the longest, if empty at least `reclaimAfterMs`, is disposed
   * now instead of at the end of its grace period. Never a room anyone is
   * in, never the open room or the plaza. Returns its id, or null.
   */
  reclaim(): string | null {
    const t = this.now();
    let oldest: Room | null = null;
    for (const r of this.rooms.values()) {
      if (r.kind !== 'private' || r.emptySince === null || t - r.emptySince < this.reclaimAfterMs) continue;
      if (!oldest || r.emptySince < oldest.emptySince!) oldest = r;
    }
    if (!oldest) return null;
    this.rooms.delete(oldest.id);
    oldest.host.dispose();
    return oldest.id;
  }

  /** L4.5A: close a private room for inactivity: nobody new gets in, and it goes as soon as it is empty (`reap`). */
  expire(room: Room) {
    if (room.kind === 'private') room.expired = true;
  }

  /** A connection left the room (the caller has already disconnected it from `room.host`). */
  leave(room: Room, conn: ConnectionId) {
    room.connections.delete(conn);
    if (room.connections.size === 0) room.emptySince = this.now();
  }

  /** Dispose of every private room empty for longer than the grace period; returns their ids. */
  reap(): string[] {
    const t = this.now();
    const gone: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.kind !== 'private' || room.emptySince === null || (t - room.emptySince < this.graceMs && !room.expired)) continue;
      this.rooms.delete(room.id);
      room.host.dispose();
      gone.push(room.id);
    }
    return gone;
  }

  dispose() {
    for (const room of this.rooms.values()) room.host.dispose();
    this.rooms.clear();
  }

  private make(id: string, kind: RoomKind, listed = kind === 'open', arena: ArenaDef = CLASSIC, rotate = false, lifecycle: 'continuous' | 'lobby' | 'plaza' = 'continuous'): Room {
    // L4.1: the plaza has a seat for every connection it may take.
    const players = lifecycle === 'plaza' ? Array.from({ length: this.perRoom }, (_, i) => `P${i + 1}`) : undefined;
    const host = new RumbleHost({ havok: this.config.havok, tickHz: this.config.tickHz, snapshotHz: this.config.snapshotHz, arena, rotate, lifecycle, ...(players ? { players } : {}) });
    // A new private room starts empty: its grace period runs until someone enters.
    const room: Room = { id, kind, mode: 'casual', listed, arena, rotate, lifecycle, host, connections: new Set(), createdAt: this.now(), emptySince: kind === 'private' ? this.now() : null, activeAt: this.now(), expired: false };
    this.rooms.set(id, room);
    return room;
  }
}
