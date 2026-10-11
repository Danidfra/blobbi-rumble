/**
 * ROOMS: one server process, several independent matches. A room owns one
 * authoritative `RumbleHost` (and so one `RumbleMatch`, its own Havok
 * world, bots, slots, roster and restarts); nothing is shared between rooms
 * but the process and the Havok wasm instance. Transport-free: the
 * WebSocket server routes connections to rooms; this decides which rooms
 * exist.
 *
 *   OPEN      the open room: always there (a plain visit plays here), never reaped
 *   private   created on request with a fresh code; lives while anyone is in
 *             it, and for `graceMs` after the last connection leaves (so a
 *             dropped player can come back), then it is disposed. M10B: made
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
import { OPEN_ROOM, newRoomId, normalizeRoomId } from './roomId';

export const ROOMS = Object.freeze({
  /** Rooms at once, the open room included. */
  maxRooms: 16,
  /** Connections in one room: four players and four watching. */
  perRoom: 8,
  /** A private room with nobody in it is kept this long, ms. */
  graceMs: 120_000,
});

export type RoomKind = 'open' | 'private';
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
  readonly lifecycle: 'continuous' | 'lobby';
  readonly host: RumbleHost;
  /** The connections in it (players and spectators). */
  readonly connections: Set<ConnectionId>;
  readonly createdAt: number;
  /** Since when it has had no connection (null: someone is in it). */
  emptySince: number | null;
}

export interface RoomManagerConfig {
  havok: HavokInstance;
  tickHz?: number;
  snapshotHz?: number;
  maxRooms?: number;
  perRoom?: number;
  graceMs?: number;
  now?: () => number;
  random?: (n: number) => number;
}

export class RoomManager {
  readonly open: Room;
  readonly maxRooms: number;
  readonly perRoom: number;
  readonly graceMs: number;
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;

  constructor(private readonly config: RoomManagerConfig) {
    this.maxRooms = config.maxRooms ?? ROOMS.maxRooms;
    this.perRoom = config.perRoom ?? ROOMS.perRoom;
    this.graceMs = config.graceMs ?? ROOMS.graceMs;
    this.now = config.now ?? (() => Date.now());
    this.open = this.make(OPEN_ROOM, 'open');
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
        const players = Object.values(roster).filter((s) => s.who !== 'bot').length;
        const snap = r.host.latest;
        const life = r.host.lobby;
        return { id: r.id, kind: r.kind, players, maxPlayers: Object.keys(roster).length, spectators: Math.max(0, r.connections.size - players), maxConnections: this.perRoom, phase: life ? life.phase : snap.phase, round: snap.round, joinable: this.hasRoom(r), age: Math.max(0, Math.floor((t - r.createdAt) / 1000)), arena: r.host.arena.id, ...(life ? { lifecycle: 'lobby' as const } : {}) };
      });
    rows.sort((a, b) => Number(b.kind === 'open') - Number(a.kind === 'open') || b.players - a.players || a.age - b.age);
    return rows.slice(0, PROTOCOL.maxListedRooms);
  }

  /** Whether a connection would fit. */
  hasRoom(room: Room) {
    return room.connections.size < this.perRoom;
  }

  /** A connection entered the room (the caller then connects it to `room.host`). */
  enter(room: Room, conn: ConnectionId) {
    room.connections.add(conn);
    room.emptySince = null;
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
      if (room.kind === 'open' || room.emptySince === null || t - room.emptySince < this.graceMs) continue;
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

  private make(id: string, kind: RoomKind, listed = kind === 'open', arena: ArenaDef = CLASSIC, rotate = false, lifecycle: 'continuous' | 'lobby' = 'continuous'): Room {
    const host = new RumbleHost({ havok: this.config.havok, tickHz: this.config.tickHz, snapshotHz: this.config.snapshotHz, arena, rotate, lifecycle });
    // A new private room starts empty: its grace period runs until someone enters.
    const room: Room = { id, kind, mode: 'casual', listed, arena, rotate, lifecycle, host, connections: new Set(), createdAt: this.now(), emptySince: kind === 'private' ? this.now() : null };
    this.rooms.set(id, room);
    return room;
  }
}
