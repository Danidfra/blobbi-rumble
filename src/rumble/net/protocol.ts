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
 *
 *   server → client
 *     { t: 'welcome', you, players, tickHz, snapshotHz }    you: the player id it controls, or null (spectating)
 *     { t: 'state', tick, time, snapshot, control, acks }   the authoritative match, ~snapshotHz
 *     { t: 'pong', id, ct, tick }
 *
 * `control` says who drives each fighter ('human' or 'bot'); `acks` is,
 * per human-driven player, the highest input `seq` the server has applied
 * to the match by `tick` (groundwork for reconciliation). Pure: parsing and
 * validation are shared by the server and tested without sockets.
 */
import type { PlayerIntent } from '../sim/intent';
import type { MatchSnapshot } from '../sim/snapshot';

export const PROTOCOL = Object.freeze({
  /** A client message longer than this, in characters, is dropped unread. */
  maxClientMessage: 512,
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
export type ClientMessage = InputMessage | PingMessage;

export interface WelcomeMessage {
  t: 'welcome';
  you: string | null;
  players: string[];
  tickHz: number;
  snapshotHz: number;
}
export interface StateMessage {
  t: 'state';
  tick: number;
  time: number;
  snapshot: MatchSnapshot;
  control: Record<string, Control>;
  acks: Record<string, number>;
}
export interface PongMessage {
  t: 'pong';
  id: number;
  ct: number;
  tick: number;
}
export type ServerMessage = WelcomeMessage | StateMessage | PongMessage;

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
  if (typeof raw !== 'string' || raw.length > PROTOCOL.maxClientMessage) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
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

/** Whether a received state is newer than the newest one already shown (by tick): older or repeated states are dropped. */
export const isNewer = (tick: number, newestShown: number | null) => newestShown === null || tick > newestShown;
