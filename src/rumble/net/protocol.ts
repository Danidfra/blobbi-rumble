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
 *
 *   server → client
 *     { t: 'welcome', you, players, tickHz, snapshotHz }    you: the player id it controls, or null (spectating)
 *     { t: 'state', tick, time, snapshot, control, acks, ackTicks }   the authoritative match, ~snapshotHz
 *     { t: 'pong', id, ct, tick }
 *     { t: 'challenge', challenge, ttl }              M8A: sign this within ttl seconds
 *     { t: 'auth', ok, pubkey?, reason? }             M8A: the answer to a proof (or a logout)
 *     { t: 'roster', slots }                          M8A: per player slot, who drives it: a bot,
 *                                                     a guest, or a person proven to hold a pubkey
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

export const PROTOCOL = Object.freeze({
  /** A client message longer than this, in characters, is dropped unread. */
  maxClientMessage: 512,
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
export type ClientMessage = InputMessage | PingMessage | ChallengeRequest | AuthMessage | LogoutMessage;

export interface WelcomeMessage {
  t: 'welcome';
  you: string | null;
  players: string[];
  tickHz: number;
  snapshotHz: number;
  /** What this server offers beyond play ('nostr-auth': the M8A identity handshake). Absent on older servers. */
  features?: string[];
}
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
/** Who drives a slot, as far as the server can vouch. */
export type SlotIdentity = { who: 'bot' } | { who: 'guest' } | { who: 'nostr'; pubkey: string };
export interface RosterMessage {
  t: 'roster';
  slots: Record<string, SlotIdentity>;
}
export type ServerMessage = WelcomeMessage | StateMessage | PongMessage | ChallengeMessage | AuthReply | RosterMessage;

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
