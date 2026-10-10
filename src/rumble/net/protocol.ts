/**
 * THE RUMBLE WIRE PROTOCOL, M7B: JSON over one WebSocket per client. Small
 * on purpose; everything a client may say is here, and it is only ever a
 * player's intent or a ping. There is no message that places, powers,
 * scores or hits anything: the server's match decides all of that.
 *
 *   client → server
 *     { t: 'input', seq, intent: { x, z, run, jump, punch, grab } }
 *         movement state and the one-shot requests made since the last input
 *     { t: 'ping', id, ct }                           ct: the client's clock, echoed back
 *     { t: 'challenge' }                              M8A: ask for a Nostr auth challenge
 *     { t: 'auth', event }                            M8A: a signed kind-22242 answer to it
 *     { t: 'logout' }                                 M8A: drop this connection's Nostr identity
 *     { t: 'look', form }                             M9C: the Rumble form my fighter wears (null: the default);
 *                                                     only for a connection with a proven identity, and only a
 *                                                     Blobbi address that identity owns (`looks.ts`)
 *     { t: 'rooms' }                                  M10B: list this server's public rooms (bounded, rate-limited)
 *
 *   server → client
 *     { t: 'welcome', you, players, tickHz, snapshotHz, features?, room?, server? }
 *                                                     you: the player id it controls, or null (spectating);
 *                                                     room (M8B): which room, and its share link if the
 *                                                     server knows its public address; server: its claims
 *     { t: 'state', tick, time, snapshot, control, acks, ackTicks }   the authoritative match, ~snapshotHz
 *     { t: 'pong', id, ct, tick }
 *     { t: 'challenge', challenge, ttl }              M8A: sign this within ttl seconds
 *     { t: 'auth', ok, pubkey?, reason? }             M8A: the answer to a proof (or a logout)
 *     { t: 'roster', slots, spectators? }             M8A: per player slot, who drives it: a bot,
 *                                                     a guest, or a person proven to hold a pubkey;
 *                                                     M9C: and the form their fighter wears, if any
 *     { t: 'look', ok, reason? }                      M9C: the answer to a look
 *     { t: 'rooms', rooms }                           M10B: the public rooms, counts only (never who is in them)
 *
 * VERSION (M10A): the welcome carries `protocol`, the number below. A client
 * plays with a server whose number it knows (older ones are missing some
 * features, which the `features` list says); a server with a higher number
 * than the client knows is "incompatible" and the client does not pretend
 * otherwise. A welcome without the number is a pre-M10 server (0).
 *
 * IDENTITY (M8A) is optional and separate from play: a connection plays as
 * a guest from its welcome on; proving a Nostr key later only labels the
 * slot it holds. The roster carries only what the server can vouch for
 * (a pubkey it saw a fresh signature from): never a name or a picture,
 * which clients look up themselves. A slot is not a person: the same
 * pubkey may come back on another slot, and a slot's next holder starts
 * as a guest.
 *
 * `control` says who drives each fighter ('human' or 'bot'); `acks` is,
 * per human-driven player, the highest input `seq` the server has applied
 * to the match by `tick`, and `ackTicks` the step it was first applied on,
 * which is what client reconciliation replays from. Pure: parsing and
 * validation are shared by the server and tested without sockets.
 */
import type { PlayerIntent } from '../sim/intent';
import type { MatchSnapshot } from '../sim/snapshot';
import { parseLookDeclaration, type LookDeclaration, type SlotForm } from './looks';

export const PROTOCOL = Object.freeze({
  /** The wire protocol this build speaks (M10A); see the header. */
  version: 1,
  /** A client message longer than this, in characters, is dropped unread. */
  maxClientMessage: 512,
  /** Rooms in one listing at most, and the shortest interval one connection may ask at, ms. */
  maxListedRooms: 32,
  roomsEveryMs: 2000,
  /** An auth message (a signed event) may be this long, characters. */
  maxAuthMessage: 2048,
  /** The largest input sequence number accepted (it must stay an exact integer). */
  maxSeq: Number.MAX_SAFE_INTEGER,
});

export type Control = 'human' | 'bot';

export interface InputMessage {
  t: 'input';
  seq: number;
  intent: PlayerIntent;
}
/** M11F: a player out of the round throws a banana peel at a point on the floor; the server judges it. */
export interface ThrowMessage {
  t: 'throw';
  x: number;
  z: number;
}
export interface PingMessage {
  t: 'ping';
  id: number;
  ct: number;
}
export interface ChallengeRequest {
  t: 'challenge';
}
export interface AuthMessage {
  t: 'auth';
  /** Shape-checked here; the signature and everything else is checked by the server. */
  event: Record<string, unknown>;
}
export interface LogoutMessage {
  t: 'logout';
}
export interface LookMessage {
  t: 'look';
  /** The form, or null: the default fighter. */
  form: LookDeclaration | null;
}
export interface RoomsRequest {
  t: 'rooms';
}
export type ClientMessage = InputMessage | PingMessage | ChallengeRequest | AuthMessage | LogoutMessage | LookMessage | RoomsRequest | ThrowMessage;

export interface WelcomeMessage {
  t: 'welcome';
  you: string | null;
  players: string[];
  tickHz: number;
  snapshotHz: number;
  /** What this server offers beyond play ('nostr-auth': the M8A identity handshake; 'rooms'). Absent on older servers. */
  features?: string[];
  /** M8B: the room this connection is in. */
  room?: RoomInfo;
  /** M8B: what the server says about itself (claims, not proofs). */
  server?: ServerInfo;
  /** M10A: the wire protocol version (absent: a pre-M10 server, 0). */
  protocol?: number;
  /** M11A: the room's arena, and whether it rotates between matches (absent: a pre-M11 server, the classic island). */
  arena?: { id: string; rotate: boolean };
}
export interface RoomInfo {
  id: string;
  kind: 'open' | 'private';
  mode: 'casual';
  /** The canonical share link, when the server knows its public address. */
  url?: string;
  /** M10B: whether the room appears in the public listing (the open room always does; a code room as it was made). */
  listed?: boolean;
  /** M11A: the arena the room was made with (absent: the classic island). */
  arena?: string;
  rotate?: boolean;
}
/** M10B: one public room as the listing shows it: counts, never who. */
export interface RoomListing {
  id: string;
  kind: 'open' | 'private';
  /** People playing (slots held by a connection) and the slots there are. */
  players: number;
  maxPlayers: number;
  /** Connections watching, and how many connections the room takes in all. */
  spectators: number;
  maxConnections: number;
  /** The match's phase and round. */
  phase: string;
  round: number;
  /** Whether a new connection would get in (as a player or a spectator). */
  joinable: boolean;
  /** Seconds since the room was made. */
  age: number;
  /** M11A: the arena in play now. */
  arena: string;
}
export interface RoomsMessage {
  t: 'rooms';
  rooms: RoomListing[];
}
export interface ServerInfo {
  name?: string;
  /** Hex pubkey of the operator, as the server claims. */
  operator?: string;
  /** Its canonical public origin. */
  url?: string;
}
/** Close codes beyond the standard ones: the room asked for does not exist; no new room can be made now. */
export const CLOSE = Object.freeze({ noSuchRoom: 4004, roomRefused: 4003 });
export interface StateMessage {
  t: 'state';
  tick: number;
  time: number;
  snapshot: MatchSnapshot;
  control: Record<string, Control>;
  acks: Record<string, number>;
  /** Per human player, the tick on which its acknowledged input was first applied (so a client knows how much of it the state already contains). */
  ackTicks: Record<string, number>;
}
export interface PongMessage {
  t: 'pong';
  id: number;
  ct: number;
  tick: number;
}
export interface ChallengeMessage {
  t: 'challenge';
  challenge: string;
  /** Seconds it stays good for. */
  ttl: number;
}
export type AuthReason = 'malformed' | 'kind' | 'signature' | 'challenge' | 'server' | 'stale' | 'expired' | 'no-challenge' | 'busy' | 'logged-out';
export interface AuthReply {
  t: 'auth';
  ok: boolean;
  pubkey?: string;
  reason?: AuthReason;
}
/** Who drives a slot, as far as the server can vouch; and (M9C) the form its fighter wears, bound to that pubkey. */
export type SlotIdentity = { who: 'bot' } | { who: 'guest' } | { who: 'nostr'; pubkey: string; form?: SlotForm };
export type LookReason = 'no-identity' | 'not-yours' | 'spectator' | 'malformed';
export interface LookReply {
  t: 'look';
  ok: boolean;
  reason?: LookReason;
}
export interface RosterMessage {
  t: 'roster';
  slots: Record<string, SlotIdentity>;
  /** M8B: how many connections in the room are watching. */
  spectators?: number;
}
export type ServerMessage = WelcomeMessage | StateMessage | PongMessage | ChallengeMessage | AuthReply | RosterMessage | LookReply | RoomsMessage;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Read an intent from untrusted data: x and z finite numbers (absent means
 * 0), the direction cut to unit length, the four flags booleans (absent
 * means false). Anything else (a NaN, a string where a number goes, a
 * number where a flag goes) rejects the whole intent: null.
 */
export function parseIntent(v: unknown): PlayerIntent | null {
  if (!isObject(v)) return null;
  const x = v.x === undefined ? 0 : v.x;
  const z = v.z === undefined ? 0 : v.z;
  if (!finite(x) || !finite(z)) return null;
  const flags = ['run', 'jump', 'punch', 'grab'] as const;
  for (const f of flags) if (v[f] !== undefined && typeof v[f] !== 'boolean') return null;
  let dx = x;
  let dz = z;
  const len = Math.hypot(dx, dz);
  if (len > 1) {
    dx /= len;
    dz /= len;
  }
  return { x: dx, z: dz, run: v.run === true, jump: v.jump === true, punch: v.punch === true, grab: v.grab === true };
}

/** Read one client message from its raw text; null for anything the protocol does not allow (it is then ignored). */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > PROTOCOL.maxAuthMessage) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  // Only a proof may be long.
  if (v.t !== 'auth' && raw.length > PROTOCOL.maxClientMessage) return null;
  if (v.t === 'challenge') return { t: 'challenge' };
  if (v.t === 'logout') return { t: 'logout' };
  if (v.t === 'rooms') return { t: 'rooms' };
  if (v.t === 'look') {
    if (v.form === null) return { t: 'look', form: null };
    const form = parseLookDeclaration(v.form);
    return form ? { t: 'look', form } : null;
  }
  if (v.t === 'auth') return isObject(v.event) ? { t: 'auth', event: v.event } : null;
  if (v.t === 'input') {
    if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 0 || (v.seq as number) > PROTOCOL.maxSeq) return null;
    const intent = parseIntent(v.intent);
    return intent ? { t: 'input', seq: v.seq as number, intent } : null;
  }
  if (v.t === 'ping') {
    if (!finite(v.id) || !finite(v.ct)) return null;
    return { t: 'ping', id: v.id, ct: v.ct };
  }
  if (v.t === 'throw') {
    if (!finite(v.x) || !finite(v.z) || Math.abs(v.x) > 100 || Math.abs(v.z) > 100) return null;
    return { t: 'throw', x: v.x, z: v.z };
  }
  return null;
}

/**
 * The one message a client sends about play: its intent, numbered. Built
 * from the movement held and the one-shot requests made since the last
 * message, and nothing else: no position, prediction or outcome can ride
 * along.
 */
export function inputMessage(seq: number, move: { x: number; z: number; run: boolean }, actions: { jump: boolean; punch: boolean; grab: boolean }): InputMessage {
  return { t: 'input', seq, intent: { x: move.x, z: move.z, run: move.run, jump: actions.jump, punch: actions.punch, grab: actions.grab } };
}

/** Whether a received state is newer than the newest one already shown (by tick): older or repeated states are dropped. */
export const isNewer = (tick: number, newestShown: number | null) => newestShown === null || tick > newestShown;
