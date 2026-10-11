/**
 * WHICH ROOM A PAGE WANTS, and the links for it. Pure.
 *
 *   /play/A7F2  or  ?room=A7F2     join that room
 *   ?room=PLAZA                    L4.1: the public social plaza
 *   ?room=OPEN                     Quick Match: the open combat room
 *   ?create=1                      make a new room (then the page's address
 *                                  becomes the room's link, so a reload or a
 *                                  reconnect rejoins instead of making another)
 *   anything else                  L4.1: the MENU (nothing connects until the
 *                                  player chooses; it used to be the open room)
 *
 * The page's other query flags that matter across a switch (`server`,
 * `relays`, dev knobs) are kept; `room`, `create` and `network` are the
 * room's to set.
 */
import { OPEN_ROOM, PLAZA_ROOM, normalizeRoomId } from '../net/roomId';

export type RoomIntent = { kind: 'menu' } | { kind: 'plaza' } | { kind: 'open' } | { kind: 'join'; id: string } | { kind: 'create'; listed?: boolean; arena?: string; rotate?: boolean } | { kind: 'invalid'; raw: string };

export function roomIntent(loc: { pathname: string; search: string }): RoomIntent {
  const q = new URLSearchParams(loc.search);
  const fromPath = /^\/play\/([^/]*)$/.exec(loc.pathname)?.[1];
  let raw: string | null = null;
  try {
    raw = fromPath !== undefined ? decodeURIComponent(fromPath) : q.get('room');
  } catch {
    return { kind: 'invalid', raw: fromPath ?? '' };
  }
  if (raw !== null) {
    const id = normalizeRoomId(raw);
    if (!id) return { kind: 'invalid', raw: raw.slice(0, 16) };
    return id === OPEN_ROOM ? { kind: 'open' } : id === PLAZA_ROOM ? { kind: 'plaza' } : { kind: 'join', id };
  }
  if (!q.has('create')) return { kind: 'menu' };
  const arena = q.get('arena');
  return { kind: 'create', listed: q.get('public') === '1', ...(arena ? { arena } : {}), ...(q.get('rotate') === '1' ? { rotate: true } : {}) };
}

/**
 * The WebSocket URL for a room: the server's URL with `room=` or `create=1`
 * (any other query kept), and (L1) `caps=lobby`: this page understands lobby
 * rooms, so a room it creates is one and a lobby room lets it in. A server
 * that does not know the lobby ignores it.
 */
export function socketUrl(serverUrl: string, intent: RoomIntent): string {
  const u = new URL(serverUrl);
  for (const k of ['room', 'create', 'public', 'arena', 'rotate', 'caps']) u.searchParams.delete(k);
  if (intent.kind === 'join') u.searchParams.set('room', intent.id);
  else if (intent.kind === 'plaza') u.searchParams.set('room', PLAZA_ROOM);
  else if (intent.kind === 'create') {
    u.searchParams.set('create', '1');
    if (intent.listed) u.searchParams.set('public', '1');
    if (intent.arena) u.searchParams.set('arena', intent.arena);
    if (intent.rotate) u.searchParams.set('rotate', '1');
  }
  u.searchParams.set('caps', 'lobby,plaza');
  return u.toString();
}

const KEEP = ['server', 'relays', 'interp', 'predict', 'delay'];

/**
 * The page address (path + query) for being in `roomId`, keeping the flags
 * that matter: a private room's share path; L4.1: `?room=OPEN` (Quick Match)
 * and `?room=PLAZA`, so a reload goes back there; null: the menu.
 */
export function pageAddress(roomId: string | null, search: string): string {
  const from = new URLSearchParams(search);
  const q = new URLSearchParams();
  for (const k of KEEP) if (from.has(k)) q.set(k, from.get(k)!);
  if (!roomId || roomId === OPEN_ROOM || roomId === PLAZA_ROOM) {
    q.set('network', '1');
    if (roomId) q.set('room', roomId);
    return `/rumble.html?${q.toString()}`;
  }
  const rest = q.toString();
  return `/play/${roomId}${rest ? `?${rest}` : ''}`;
}

/**
 * The link to share for a room: the server's canonical one when it gave
 * one (its PUBLIC_URL: what friends elsewhere can reach; that server
 * serves the page too), else this page's own origin, and, when the game
 * server is not this page's own (M10A: a picked or linked server without a
 * public address), with `?server=` so the link names it. Only http(s)
 * links are ever shown.
 */
export function shareLink(roomId: string, origin: string, serverUrl?: string, gameServer?: string): string {
  if (serverUrl) {
    try {
      const u = new URL(serverUrl);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.toString();
    } catch {
      // Fall through to this page's origin.
    }
  }
  const base = roomId === OPEN_ROOM ? `${origin}/` : `${origin}/play/${roomId}`;
  if (gameServer && !isOwnServer(origin, gameServer)) return `${base}?server=${encodeURIComponent(gameServer)}`;
  return base;
}

/** Whether a game server URL is this page's own origin at /ws (the hosted game), so a link needs no `?server=`. */
export function isOwnServer(origin: string, gameServer: string): boolean {
  try {
    const o = new URL(origin);
    const g = new URL(gameServer);
    const wsScheme = o.protocol === 'https:' ? 'wss:' : 'ws:';
    return g.protocol === wsScheme && g.host === o.host && (g.pathname === '/ws' || g.pathname === '/');
  } catch {
    return false;
  }
}
