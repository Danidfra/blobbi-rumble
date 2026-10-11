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
 *     { t: 'ready', ready }                           L2: in a lobby room, this seated person is (not) ready
 *     { t: 'start' }                                  L2: the room's owner starts the match (never below the minimum)
 *     { t: 'settings', bots?, arena?, rotate? }       L2: the owner changes the room's settings, in the lobby only
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
 *     { t: 'lobby', phase, since, deadline, transition, you, owner, youOwn, seated, ready, watchers, forced, lineup, settings, canStart, need, results }
 *                                                     L1: a lobby room's lifecycle (`lifecycle.ts`), on every change,
 *                                                     to each connection (`you`: its seat now, which can change
 *                                                     between matches)
 *     { t: 'refused', of, reason }                    L2: why a ready / start / settings was not done
 *
 * THE LOBBY (L1) is negotiated both ways, so no client misreads a room: a
 * client that knows it says so in the socket URL (`caps=lobby`); a server
 * that has it lists 'lobby' in `features`. A room made by a client that
 * asked for it (`create=1&caps=lobby`) is a lobby room (`room.lifecycle`);
 * any other room plays continuously, as before. A client that did not say
 * `caps=lobby` is refused a lobby room with close code 1008 and the reason
 * "update required" (which a pre-lobby page shows as a refusal, without
 * retrying), never let in to misread it.
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
 * `control` says who drives each fighter ('human', 'bot', or L3 'none': a
 * lobby room without bots whose person left); `acks` is,
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

/** Who drives a fighter: a person, a bot, or (L3: a lobby room without bots, its person gone) nobody. */
export type Control = 'human' | 'bot' | 'none';

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
/** L2: lobby requests. Each is only a request; the server decides (`lifecycle.ts`). */
export interface ReadyMessage {
  t: 'ready';
  ready: boolean;
}
export interface StartMessage {
  t: 'start';
}
export interface SettingsMessage {
  t: 'settings';
  bots?: boolean;
  arena?: string;
  rotate?: boolean;
}
export type LobbyCommand = ReadyMessage | StartMessage | SettingsMessage;
export type ClientMessage = InputMessage | PingMessage | ChallengeRequest | AuthMessage | LogoutMessage | LookMessage | RoomsRequest | ThrowMessage | LobbyCommand;

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
/** L1: what a client may announce it understands, in the socket URL's `caps` (comma-separated). */
export const CLIENT_CAPS = Object.freeze(['lobby'] as const);
export type ClientCap = (typeof CLIENT_CAPS)[number];
/** The capabilities a socket URL's query announces (unknown ones ignored, bounded). */
export function parseCaps(raw: string | null): Set<ClientCap> {
  const caps = new Set<ClientCap>();
  if (!raw || raw.length > 64) return caps;
  for (const c of raw.split(',')) if ((CLIENT_CAPS as readonly string[]).includes(c)) caps.add(c as ClientCap);
  return caps;
}
/** The close reason a pre-lobby client is refused a lobby room with (code 1008). */
export const UPDATE_REQUIRED = 'update required: reload the page to join this room';

/** L1: the stages of a lobby room (`lifecycle.ts`). */
export type LifecyclePhase = 'lobby' | 'countdown' | 'playing' | 'results';
/**
 * L1: a change of place, announced ahead in ticks (the state messages'
 * ticks): bodies leave from `departAt`, the server swaps them on `swapAt`
 * (the match restarted, every fighter at its spawn), the arrival is over by
 * `arriveBy`. What is drawn over it is the client's (a fade, a teleport).
 */
export interface Transition {
  kind: 'toArena' | 'toLobby';
  departAt: number;
  swapAt: number;
  arriveBy: number;
}
/** L1: a lobby room's settings, decided by the server. */
export interface RoomSettings {
  /** Bots fill the seats nobody holds. */
  bots: boolean;
  /** The arena the next match is played on. */
  arena: string;
  /** Move to another arena after each match. */
  rotate: boolean;
}
/** L1: how a match ended, per fighter: who drove it at the end (a bot, a guest, a proven pubkey) and its score. */
export interface MatchResults {
  /** The winning fighter's id, or null (abandoned). */
  winner: string | null;
  /** 'won': first to the target; 'forfeit': everyone else left; 'abandoned': nobody was left. */
  reason: 'won' | 'forfeit' | 'abandoned';
  arena: string;
  fighters: { id: string; who: SlotIdentity; score: number }[];
}
export interface LobbyMessage {
  t: 'lobby';
  phase: LifecyclePhase;
  /** The tick the phase began on, and the tick it ends on by itself (null: it does not). */
  since: number;
  deadline: number | null;
  transition: Transition | null;
  /** This connection's seat now (null: watching until the next lobby has a seat for it). */
  you: string | null;
  /** L2: the owner's seat (null: the owner watches, or nobody owns the room), and whether this connection is the owner. */
  owner: string | null;
  youOwn: boolean;
  /** L2: the seats people hold, and those whose people said they are ready (bots always are, and are not listed). */
  seated: string[];
  ready: string[];
  /** L3: who is waiting for the next match (watchers, in arrival order: a guest or a proven pubkey, never a form). */
  watchers: SlotIdentity[];
  /** L3: the running countdown is the owner's (someone becoming unready does not cancel it). */
  forced: boolean;
  /** The fighters of the match (the next one, in the lobby). */
  lineup: string[];
  settings: RoomSettings;
  /** Whether the minimum to start is met, and the fewest seated people a start needs. */
  canStart: boolean;
  need: number;
  results: MatchResults | null;
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
  /** L1: 'lobby' for a room with the lobby lifecycle (absent: it plays continuously). */
  lifecycle?: 'lobby';
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
  /** L1: 'lobby' for a lobby room, whose `phase` is then its lifecycle's (lobby, countdown, playing, results). */
  lifecycle?: 'lobby';
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
export type SlotIdentity = { who: 'bot' } | { who: 'guest' } | { who: 'nostr'; pubkey: string; form?: SlotForm } | { who: 'empty' };
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
/** L2: why a lobby request was not done. */
export type LobbyRefusalReason = 'not-owner' | 'spectator' | 'phase' | 'too-few' | 'busy' | 'malformed' | 'no-lobby';
export interface RefusedMessage {
  t: 'refused';
  of: LobbyCommand['t'];
  reason: LobbyRefusalReason;
}
export type ServerMessage = WelcomeMessage | StateMessage | PongMessage | ChallengeMessage | AuthReply | RosterMessage | LookReply | RoomsMessage | LobbyMessage | RefusedMessage;

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
  // L2: lobby requests, shape-checked only (the host decides whether they may be done).
  if (v.t === 'ready') return typeof v.ready === 'boolean' ? { t: 'ready', ready: v.ready } : null;
  if (v.t === 'start') return { t: 'start' };
  if (v.t === 'settings') {
    const out: SettingsMessage = { t: 'settings' };
    for (const k of ['bots', 'rotate'] as const) {
      if (v[k] === undefined) continue;
      if (typeof v[k] !== 'boolean') return null;
      out[k] = v[k] as boolean;
    }
    if (v.arena !== undefined) {
      if (typeof v.arena !== 'string' || v.arena.length > 64) return null;
      out.arena = v.arena;
    }
    return out;
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
