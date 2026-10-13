/**
 * THE RUMBLE SERVER: authoritative matches behind one WebSocket endpoint,
 * stepped by the server's own clock at a fixed rate. Since M8B a process
 * hosts several ROOMS (`rooms.ts`), each with its own match (`RumbleHost`);
 * a connection picks one by the query of the URL it opens:
 *
 *   /ws                the open room (where a plain visit plays)
 *   /ws?room=A7F2      that room; refused (4004) if there is none
 *   /ws?create=1       a new private room (4003 when over the limits)
 *   /ws?room=PLAZA     L4.1: the public plaza (needs caps=plaza; "plaza full" at eight)
 *   …&caps=lobby       L1: the client speaks the lobby: a room it creates is a
 *                      lobby room; without it, a lobby room is refused (1008,
 *                      "update required") rather than misread
 *
 *   room clients ──input / ping──► its host.receive ··· every host.tick() @ 60 Hz ··· every 3rd tick ──state──► that room's clients
 *
 * Rooms share nothing but the process: inputs, states, rosters, bots and
 * restarts stay inside their room. An empty private room is kept for a
 * grace period (a dropped player may come back), then disposed.
 *
 * The loop is a fixed-step accumulator on the monotonic clock: it wakes,
 * runs every step that is due, and sleeps until the next. Message timing
 * never moves time. If the process stalls, at most `maxCatchUp` steps run
 * at once and the rest of the backlog is dropped (counted), rather than
 * fast-forwarding through seconds of play.
 *
 * It listens on its own port (development: `npm run server`) or on a path
 * of an existing HTTP server (`serve-cli.ts`: the built game and the
 * WebSocket on one origin, behind whatever terminates TLS).
 *
 * Exposed beyond localhost, it bounds what a client can cost: at most
 * `maxConnections` connections (more are refused with "server full"), at
 * most `maxMessagesPerSecond` messages each (the rest dropped; a sustained
 * flood is disconnected), frames of at most 4 KB, no per-client send queue
 * past `maxBufferedBytes` (states are skipped for a slow client, which is
 * dropped if it falls far behind), and a heartbeat that drops connections
 * that stopped answering, or that said nothing for `idleMs`. One address
 * (an IPv4, or an IPv6 /64) holds at most `maxPerAddress` connections, and
 * `maxPerAddressPerRoom` in one room: a single client can fill neither.
 *
 * PRIVATE-ROOM CAPACITY (L4.5A): a network keeps at most `roomsPerAddress`
 * private rooms open that it made (`roomsPerAddressWhenBusy` once only
 * `reservedRooms` places are left, so the last places go to networks with
 * none); when every place is taken, a room empty the longest gives way to
 * a new one (`rooms.ts` `reclaim`); and a private room where nobody has
 * done anything a person does (moved, pressed, asked the lobby, changed a
 * look, arrived) for `roomIdleMs` is closed, after warnings, never while
 * its match is on. Staying connected, pinging or resending the same input
 * is not activity.
 *
 * IDENTITY (M8A): any connection may prove it holds a Nostr key, NIP-42
 * style (`social/auth.ts`): it asks for a challenge, signs a kind-22242
 * event naming the challenge and this server's address, and the server
 * verifies it and labels the slot the connection holds (the roster). The
 * server never talks to a relay and never learns a name: a pubkey it saw a
 * fresh signature from is all it vouches for. Unproven connections play as
 * guests, exactly as before. The address a proof must name is `authUrls`
 * (set PUBLIC_URL in production); without it, the Host the connection
 * itself came in on.
 *
 * DEV ONLY: `lagMs` / `jitterMs` delay every message each way on its own
 * connection (in order, a bounded queue), to feel latency locally. They live
 * in the transport, never in the match or the protocol.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HavokInstance } from '../sim/physics';
import { AUTH, ChallengeBook, authAddress, verifyAuth } from '../../social/auth';
import { arenaById } from '../arena/arenas';
import { shortNpub } from '../../social/keys';
import type { RumbleHost, ConnectionId } from './host';
import type { LookDeclaration } from './looks';
import { parseCaps, parseClientMessage, type AuthReply, type ChallengeMessage, type ClientMessage, type LobbyCommand, type RefusedMessage, type NoticeMessage, type RoomInfo, type ServerInfo, PROTOCOL, type RoomsMessage, UPDATE_REQUIRED } from './protocol';
import { RoomManager, type Room } from './rooms';
import { addressGroup, isIpAddress, isLoopback, trustedProxies } from './address';
import { roomShareUrl, type ServerIdentity } from './serverIdentity';

export const SERVER_LIMITS = Object.freeze({
  /** Connections at once, all rooms together. */
  maxConnections: 64,
  /** Messages a second per connection kept (a client sends at most ~61: 60 inputs and a ping); the bucket holds a second's worth. */
  maxMessagesPerSecond: 120,
  /** Over this many dropped messages in one second, the connection is flooding: disconnected. */
  floodDisconnect: 600,
  /** A frame larger than this, bytes, closes the connection (ws enforces it). */
  maxPayload: 4096,
  /** States are skipped for a client whose send queue holds more than this, bytes; past `maxBufferedBytes * 8` it is dropped. */
  maxBufferedBytes: 256 * 1024,
  /** Ping every this many ms; a connection that did not answer the last one is dropped. */
  heartbeatMs: 10_000,
  /** Dev lag only: at most this many messages waiting in a delay queue per direction. */
  maxDelayed: 1000,
  /** A connection may ask for a new auth challenge at most this often, ms. */
  challengeEveryMs: 1000,
  /** New private rooms one address may create per minute. */
  roomsPerMinute: 5,
  /**
   * Security audit H1: connections one address (an IPv4, or an IPv6 /64; `address.ts`) may hold at once, server-wide and
   * in one room. Room for a household playing together (four fighters), never every place of a room or the server.
   * Loopback is not limited (the operator; see `address.ts`).
   */
  maxPerAddress: 8,
  maxPerAddressPerRoom: 4,
  /**
   * L4.5B: once only `reservedConnections` places are left, a network may hold at most `maxPerAddressWhenBusy`: a few
   * networks cannot take the whole server (a household of four still fits).
   */
  maxPerAddressWhenBusy: 4,
  reservedConnections: 16,
  /** A connection that sent nothing at all for this long, ms, is closed (a real page pings every second, standing still or not). */
  idleMs: 120_000,
  /** M1: a connection's look is applied at most this often, ms; a newer one meanwhile waits (the latest wins, none is lost). */
  lookEveryMs: 1000,
  /** M2: private rooms one address may have open at once (made by it, not yet closed). L4.5A: 3 → 2. */
  roomsPerAddress: 2,
  /** L4.5A: once only `reservedRooms` places for private rooms are left, a network with a room open makes no other. */
  roomsPerAddressWhenBusy: 1,
  reservedRooms: 4,
  /**
   * L4.5A: a private room with people in it but no activity for this long, ms, is closed (`roomIdleWarnMs` before, the
   * people in it are told, each warning once); a lobby room's match (countdown, play, results) always counts as activity.
   */
  roomIdleMs: 20 * 60_000,
  roomIdleWarnMs: Object.freeze([120_000, 30_000]),
  /** L4.5A: address groups each per-minute limiter remembers at most (the oldest are forgotten first). */
  limiterKeys: 4096,
  /** L4.5A: refusal lines logged per 10 s at most; the rest are counted and summed up in one line. */
  refusalLogsPer10s: 20,
  /** M3: room codes one address may try in vain per minute; past that, joining by code waits for the minute to pass. */
  roomGuessesPerMinute: 10,
  /**
   * L2: one connection's lobby requests, at most one of each kind per interval, ms (more are refused as 'busy'):
   * a ready toggle, an owner's start, a settings change (which can rebuild the arena's colliders).
   */
  lobbyEveryMs: Object.freeze({ ready: 250, start: 1000, settings: 500 }),
});

export interface ServerConfig {
  havok: HavokInstance;
  /** Listen on this port and address (when no `http` server is given). */
  port?: number;
  host?: string;
  /** Or attach to this HTTP server, on this path (the built game served beside it). */
  http?: HttpServer;
  path?: string;
  tickHz?: number;
  snapshotHz?: number;
  /** At most this many steps run in one wake-up; more backlog than that is dropped. */
  maxCatchUp?: number;
  maxConnections?: number;
  maxMessagesPerSecond?: number;
  /** Dev only: added one-way delay on every message, each way, and up to this much more at random. */
  lagMs?: number;
  jitterMs?: number;
  /** Don't start the clock (tests step `host.tick()` themselves and call `broadcast()`). */
  manual?: boolean;
  /**
   * The public addresses of this server's WebSocket (e.g.
   * wss://rumble.example/ws) that an identity proof must name. Empty: the
   * Host header each connection arrived with (fine on a LAN or a dev
   * machine; set it in production so the binding does not rest on a
   * header the client chose).
   */
  authUrls?: string[];
  /** A connection may ask for an auth challenge at most this often, ms (default SERVER_LIMITS.challengeEveryMs). */
  challengeEveryMs?: number;
  /** Who this server is (name, claimed operator, canonical public address). */
  identity?: ServerIdentity;
  /** Rooms (ROOMS defaults): at most this many, this many connections each, kept this long empty. */
  maxRooms?: number;
  perRoom?: number;
  roomGraceMs?: number;
  /** New private rooms per source address per minute. */
  roomsPerMinute?: number;
  /**
   * M10D: browser origins allowed to connect (exact origins, e.g.
   * https://rumble.example). Empty or absent: any origin (a LAN, a dev
   * machine, a server that serves its own page and is reached through it).
   * A connection with an Origin header not in the list is refused with 4005;
   * one without an Origin (not a browser) is allowed and logged.
   */
  allowedOrigins?: string[];
  /**
   * The request header that carries the player's own address, set by a
   * trusted proxy in front (e.g. `cf-connecting-ip` behind Cloudflare
   * Tunnel). Absent: the socket's address. Behind a tunnel every player
   * arrives from the tunnel's address, so the per-address limits (new
   * rooms per minute) would be one limit for everyone. Only safe when
   * nothing but that proxy can reach this port (it could otherwise be
   * forged); the header's first address is used, and the socket's when the
   * header is missing or malformed.
   */
  clientIpHeader?: string;
  /**
   * L4.5B: which peers may set `clientIpHeader` (TRUSTED_PROXIES: `loopback`, `private`, addresses, IPv4 CIDRs; see
   * `address.ts` `trustedProxies`). Absent: any peer, as before (safe only when nothing but the proxy reaches this port);
   * a header from any other peer is ignored and the socket's address counts.
   */
  trustedProxies?: string;
  maxPerAddressWhenBusy?: number;
  reservedConnections?: number;
  /** Per-address limits (SERVER_LIMITS defaults): connections server-wide and in one room. */
  maxPerAddress?: number;
  maxPerAddressPerRoom?: number;
  /** Close a connection silent for this long, ms (SERVER_LIMITS.idleMs); checked on the heartbeat. */
  idleMs?: number;
  /** The heartbeat (and idle check) interval, ms (SERVER_LIMITS.heartbeatMs). */
  heartbeatMs?: number;
  /** L2 (SERVER_LIMITS defaults): the shortest interval between one connection's lobby requests of each kind, ms. */
  lobbyEveryMs?: Partial<Record<'ready' | 'start' | 'settings', number>>;
  /** M1, M2, M3 (SERVER_LIMITS defaults): look interval, open rooms per address, failed room codes per address per minute. */
  lookEveryMs?: number;
  roomsPerAddress?: number;
  /** L4.5A (SERVER_LIMITS / ROOMS defaults): see `SERVER_LIMITS`; `roomReclaimAfterMs`: `ROOMS.reclaimAfterMs`. */
  roomsPerAddressWhenBusy?: number;
  reservedRooms?: number;
  roomIdleMs?: number;
  roomIdleWarnMs?: readonly number[];
  roomReclaimAfterMs?: number;
  roomGuessesPerMinute?: number;
  /** Compact lines about connections and abnormal traffic (never every message). */
  log?: (line: string) => void;
}

export interface ServerStats {
  ticks: number;
  /** Steps dropped because the loop fell too far behind. */
  dropped: number;
  /** How late each step ran after its scheduled time, ms: mean and worst since the last reset. */
  lateMean: number;
  lateMax: number;
  statesSent: number;
  bytesOut: number;
  bytesIn: number;
  lastStateBytes: number;
  clients: number;
  /** Since the last reset: connections refused (full), messages that were not protocol, messages dropped by the rate limit, connections dropped (flooding, too slow, silent). */
  refused: number;
  malformed: number;
  rateDropped: number;
  kicked: number;
  /** Since the last reset: identity proofs accepted and refused. */
  authOk: number;
  authFailed: number;
  /** Since the last reset: private rooms created and closed; and rooms open now. */
  roomsCreated: number;
  roomsClosed: number;
  rooms: number;
}

export interface RumbleServer {
  /** The open room's match (where a plain connection plays). */
  readonly host: RumbleHost;
  rooms: RoomManager;
  identity: ServerIdentity;
  /** Close empty private rooms past their grace period, and warn or close idle ones, now (the server does this every second by itself). */
  sweep(): void;
  /** L4.5A: how many address groups the per-minute limiters remember (for checks: it stays bounded). */
  limiterSizes(): { creations: number; guesses: number };
  port: number;
  stats: ServerStats;
  resetStats(): void;
  /** Send every room's current state to its clients now. */
  broadcast(): void;
  close(): Promise<void>;
}

/** Delivers callbacks after `lag` + up to `jitter` ms, never out of order, holding at most `max`. Dev-only latency. */
function delayer(lagMs: number, jitterMs: number, max: number) {
  let last = 0;
  let waiting = 0;
  return (fn: () => void) => {
    if (lagMs <= 0 && jitterMs <= 0) return fn();
    if (waiting >= max) return;
    const at = Math.max(last, performance.now() + lagMs + Math.random() * jitterMs);
    last = at;
    waiting++;
    setTimeout(() => {
      waiting--;
      fn();
    }, at - performance.now());
  };
}

/** A token bucket: `take()` is true while the rate is respected. `clock` (ms) is for tests (L4.4A). */
export function bucket(perSecond: number, clock: () => number = () => performance.now()) {
  let tokens = perSecond;
  let at = clock();
  return () => {
    const now = clock();
    tokens = Math.min(perSecond, tokens + ((now - at) / 1000) * perSecond);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

interface Client {
  id: ConnectionId;
  room: Room;
  send: (data: string, droppable?: boolean) => void;
  alive: boolean;
  /** The address group it counts against (null: loopback, not limited). */
  group: string | null;
  /** When it last sent a valid message (performance.now()). */
  heard: number;
}

export function startRumbleServer(config: ServerConfig): Promise<RumbleServer> {
  const maxCatchUp = config.maxCatchUp ?? 5;
  const maxConnections = config.maxConnections ?? SERVER_LIMITS.maxConnections;
  const perSecond = config.maxMessagesPerSecond ?? SERVER_LIMITS.maxMessagesPerSecond;
  const lag = config.lagMs ?? 0;
  const jitter = config.jitterMs ?? 0;
  const log = config.log ?? (() => {});
  const identity: ServerIdentity = config.identity ?? { name: null, operator: null, public: null };
  const rooms = new RoomManager({ havok: config.havok, tickHz: config.tickHz, snapshotHz: config.snapshotHz, maxRooms: config.maxRooms, perRoom: config.perRoom, graceMs: config.roomGraceMs, reclaimAfterMs: config.roomReclaimAfterMs });
  const tickHz = rooms.open.host.tickHz;
  const ticksPerSnapshot = rooms.open.host.ticksPerSnapshot;
  const fresh = () => ({ ticks: 0, dropped: 0, lateMean: 0, lateMax: 0, statesSent: 0, bytesOut: 0, bytesIn: 0, refused: 0, malformed: 0, rateDropped: 0, kicked: 0, authOk: 0, authFailed: 0, roomsCreated: 0, roomsClosed: 0 });
  const stats: ServerStats = { ...fresh(), lastStateBytes: 0, clients: 0, rooms: rooms.size };
  let lateSum = 0;
  let lateCount = 0;
  const resetStats = () => {
    Object.assign(stats, fresh());
    lateSum = 0;
    lateCount = 0;
  };
  const clients = new Map<WebSocket, Client>();
  /** Per room, its clients (the sockets a room's states and roster go to). */
  const members = new Map<Room, Set<Client>>();
  let nextConn = 1;
  const challenges = new ChallengeBook({ max: Math.max(maxConnections * 2, 8) });
  const configuredAddresses = [...(config.authUrls ?? []), ...(identity.public ? [identity.public.websocket] : [])].map(authAddress).filter((a): a is string => !!a);
  const creations = windowLimiter(config.roomsPerMinute ?? SERVER_LIMITS.roomsPerMinute, SERVER_LIMITS.limiterKeys);
  /** M3: room codes tried in vain, per address group. */
  const guesses = windowLimiter(config.roomGuessesPerMinute ?? SERVER_LIMITS.roomGuessesPerMinute, SERVER_LIMITS.limiterKeys);
  /** M2: who made each private room still open (its address group; none for loopback). */
  const owners = new Map<Room, string>();
  const roomsPerAddress = config.roomsPerAddress ?? SERVER_LIMITS.roomsPerAddress;
  const roomsPerAddressWhenBusy = config.roomsPerAddressWhenBusy ?? SERVER_LIMITS.roomsPerAddressWhenBusy;
  const reservedRooms = config.reservedRooms ?? SERVER_LIMITS.reservedRooms;
  // L4.5A: 0 (or anything not a positive number) turns idle closing off.
  const roomIdleMs = config.roomIdleMs ?? SERVER_LIMITS.roomIdleMs;
  const idleClosing = Number.isFinite(roomIdleMs) && roomIdleMs > 0;
  const roomIdleWarnMs = [...(config.roomIdleWarnMs ?? SERVER_LIMITS.roomIdleWarnMs)].filter((w) => w > 0 && w < roomIdleMs).sort((a, b) => b - a);
  const ipHeader = config.clientIpHeader?.trim().toLowerCase() || null;
  /** The player's address: from the trusted proxy's header when configured (and sane), else the socket's. */
  const clientAddress = (req: IncomingMessage): string => peerAddress(req).address;
  /**
   * L4.5A: the address, and whether it came from the proxy's header. Only an address the socket itself has is the
   * operator's loopback (never limited): a header saying 127.0.0.1 is just another address, limited like any other.
   */
  const proxies = config.trustedProxies === undefined ? null : trustedProxies(config.trustedProxies);
  if (proxies?.invalid.length) log(`WARNING TRUSTED_PROXIES entries not understood (they trust nothing): ${proxies.invalid.join(', ')}`);
  let warnedUntrustedHeader = false;
  const peerAddress = (req: IncomingMessage): { address: string; fromHeader: boolean } => {
    const socket = req.socket.remoteAddress ?? '?';
    if (!ipHeader) return { address: socket, fromHeader: false };
    const raw = req.headers[ipHeader];
    // L4.5B: the header is believed only from a trusted proxy (when TRUSTED_PROXIES says which), and only as one real IP address.
    if (proxies && !proxies.trusts(socket)) {
      if (raw !== undefined && !warnedUntrustedHeader) {
        warnedUntrustedHeader = true;
        log(`ignoring ${ipHeader} from ${socket}: not a trusted proxy (TRUSTED_PROXIES); its own address counts`);
      }
      return { address: socket, fromHeader: false };
    }
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim() ?? '';
    return first.length <= 45 && isIpAddress(first) ? { address: first, fromHeader: true } : { address: socket, fromHeader: false };
  };
  /** L4.5A: refusals are logged, but never more than `refusalLogsPer10s` lines in ten seconds (a burst is summed up). */
  let refusalWindow = 0;
  let refusalLines = 0;
  let refusalsHidden = 0;
  const logRefusal = (line: string) => {
    const t = Date.now();
    if (t - refusalWindow >= 10_000) {
      if (refusalsHidden) log(`(${refusalsHidden} more refusals in the last 10 s not logged)`);
      refusalWindow = t;
      refusalLines = 0;
      refusalsHidden = 0;
    }
    if (refusalLines < SERVER_LIMITS.refusalLogsPer10s) {
      refusalLines += 1;
      log(line);
    } else refusalsHidden += 1;
  };
  /** L4.5A: per private room, the host's activity count last seen and how many idle warnings went out (gone with the room). */
  const idleSeen = new Map<Room, { activity: number; warned: number }>();
  /** L4.5A: rooms closing for inactivity, by id, until they are gone. */
  const closing = new Set<string>();
  /** L4.5A: tell everyone in a room it closes in `closesIn` seconds for inactivity (null: it does not any more). */
  const notice = (room: Room, closesIn: number | null) => {
    const data = JSON.stringify({ t: 'notice', kind: 'idle', closesIn } satisfies NoticeMessage);
    for (const c of members.get(room) ?? []) c.send(data);
  };
  /** A private room is gone (reaped, reclaimed): everything the server kept about it goes too. */
  const forget = (id: string, why: string) => {
    for (const r of [...members.keys()]) if (r.id === id) members.delete(r);
    for (const r of [...lobbySent.keys()]) if (r.id === id) lobbySent.delete(r);
    for (const r of [...owners.keys()]) if (r.id === id) owners.delete(r);
    for (const r of [...idleSeen.keys()]) if (r.id === id) idleSeen.delete(r);
    closing.delete(id);
    stats.roomsClosed += 1;
    stats.rooms = rooms.size;
    log(`room ${id} closed (${why}) · ${rooms.size} rooms`);
  };
  const allowedOrigins = (config.allowedOrigins ?? []).map((o) => o.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean);
  /** M10D: whether a browser from this Origin may connect (no list: anyone; no Origin: not a browser, allowed). */
  const originAllowed = (origin: string | undefined) => !allowedOrigins.length || origin === undefined || allowedOrigins.includes(origin.replace(/\/$/, '').toLowerCase());
  /** Who drives each slot in a room (bot, guest, proven pubkey) to everyone in it: on any change, never droppable. */
  const sendRoster = (room: Room) => {
    const roster = room.host.roster();
    const data = JSON.stringify({ ...roster, spectators: [...room.connections].filter((c) => room.host.slot(c) === null).length });
    for (const c of members.get(room) ?? []) c.send(data);
  };
  /** L1: what each connection must know of a lobby room's lifecycle (its own seat in it), when anything in it changed. */
  const lobbySent = new Map<Room, number>();
  const sendLobby = (room: Room, withRoster = true) => {
    if (!room.host.lobby || lobbySent.get(room) === room.host.lobbyVersion) return;
    lobbySent.set(room, room.host.lobbyVersion);
    // L2: seats change only with the lifecycle (a watcher seated in the lobby): the roster goes with it.
    if (withRoster) sendRoster(room);
    for (const c of members.get(room) ?? []) {
      const m = room.host.lobbyFor(c.id);
      if (m) c.send(JSON.stringify(m));
    }
  };
  /** The room a connection asked for (by the query of its URL): the open room, a known room, or a new one. */
  const roomFor = (req: IncomingMessage, who: string, group: string | null, lobby: boolean): { room: Room } | { code: number; why: string } => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (q.has('create')) {
      // Per address group: an IPv6 /64 is one (rotating through it makes no more rooms).
      const key = group ?? addressGroup(clientAddress(req));
      // L4.5A: two at most; once the server is nearly full, one per network (the last places go to networks with none).
      const cap = rooms.free <= reservedRooms ? roomsPerAddressWhenBusy : roomsPerAddress;
      if (group !== null && [...owners.values()].filter((g) => g === group).length >= cap) return { code: 4003, why: 'too many open games from your network' };
      if (!creations.allow(key)) return { code: 4003, why: 'too many new rooms, wait a minute' };
      // L4.5A: every place taken: the room empty the longest (if long enough) gives way; never a room anyone is in.
      if (rooms.free <= 0) {
        const id = rooms.reclaim();
        if (id) forget(id, 'given up to a new game: empty while the server was full');
      }
      // M10B: `public=1` lists the new room for anyone on this server; otherwise it is reached by its code or link only.
      // M11A: `arena=<id>` picks the arena (unknown: the classic island); `rotate=1` moves to another after each match.
      // L1: a client that speaks the lobby makes a lobby room; an older one, a continuous room it understands.
      const room = rooms.create({ listed: q.get('public') === '1', arena: arenaById(q.get('arena')) ?? undefined, rotate: q.get('rotate') === '1', lifecycle: lobby ? 'lobby' : 'continuous' });
      if (!room) return { code: 4003, why: 'room limit reached' };
      idleSeen.set(room, { activity: room.host.activity, warned: 0 });
      if (group !== null) owners.set(room, group);
      stats.roomsCreated += 1;
      stats.rooms = rooms.size;
      log(`room ${room.id} created by ${who} (${room.listed ? 'listed' : 'unlisted'}${room.lifecycle === 'lobby' ? ', lobby' : ''}) · ${rooms.size} rooms`);
      return { room };
    }
    if (!q.has('room')) return { room: rooms.open };
    // M3: codes tried in vain are counted per address; past the limit, joining by code waits for the minute to pass.
    if (group !== null && guesses.full(group)) return { code: 4003, why: 'too many room codes tried, wait a minute' };
    const room = rooms.get(q.get('room'));
    if (!room && group !== null) guesses.add(group);
    // L4.5A: a room closing for inactivity takes nobody new (it is gone in a moment).
    if (room?.expired) return { code: 4009, why: 'room closed: inactive' };
    return room ? { room } : { code: 4004, why: 'no such room' };
  };

  const wss = config.http
    ? new WebSocketServer({ server: config.http, path: config.path ?? '/ws', maxPayload: SERVER_LIMITS.maxPayload })
    : new WebSocketServer({ port: config.port ?? 8787, host: config.host ?? '127.0.0.1', maxPayload: SERVER_LIMITS.maxPayload });

  const kicked = new WeakSet<WebSocket>();
  const kick = (ws: WebSocket, code: number, why: string) => {
    if (kicked.has(ws)) return;
    kicked.add(ws);
    stats.kicked += 1;
    log(`conn ${clients.get(ws)?.id ?? '?'} dropped: ${why}`);
    ws.close(code, why);
    setTimeout(() => ws.terminate(), 1000).unref?.();
  };

  const maxPerAddress = config.maxPerAddress ?? SERVER_LIMITS.maxPerAddress;
  const maxPerAddressWhenBusy = config.maxPerAddressWhenBusy ?? SERVER_LIMITS.maxPerAddressWhenBusy;
  const reservedConnections = config.reservedConnections ?? SERVER_LIMITS.reservedConnections;
  const maxPerAddressPerRoom = config.maxPerAddressPerRoom ?? SERVER_LIMITS.maxPerAddressPerRoom;
  /** Connections held by an address group, server-wide or in one room. */
  const heldBy = (group: string, room?: Room) => {
    let n = 0;
    for (const c of room ? (members.get(room) ?? []) : clients.values()) if (c.group === group) n += 1;
    return n;
  };

  /**
   * L2: the logs never put a player's address beside their Nostr key. A connection is logged with a tag of its address
   * group (salted per process: the same network reads the same until a restart, and cannot be turned back into an
   * address); only refusals, which never carry an identity, name the address (what an operator acts on).
   */
  const salt = randomBytes(16);
  const netTag = (address: string) => (isLoopback(address) ? 'local' : createHash('sha256').update(salt).update(addressGroup(address)).digest('hex').slice(0, 8));

  wss.on('connection', (ws, req: IncomingMessage) => {
    const peer = peerAddress(req);
    const address = peer.address;
    const group = !peer.fromHeader && isLoopback(address) ? null : addressGroup(address);
    const origin = req.headers.origin ? ` (${req.headers.origin})` : '';
    const from = `${address}${origin}`;
    const seen = `net ${netTag(address)}${origin}`;
    if (!originAllowed(req.headers.origin)) {
      stats.refused += 1;
      logRefusal(`refused ${from}: origin not allowed`);
      ws.close(4005, 'origin not allowed');
      return;
    }
    if (clients.size >= maxConnections) {
      // Full: refused cleanly, before it takes a slot, a room or any state.
      stats.refused += 1;
      logRefusal(`refused ${from}: server full (${clients.size}/${maxConnections})`);
      ws.close(1013, 'server full');
      return;
    }
    // L4.5B: near full, a network holds fewer, so the last places go to others (a household of four still fits).
    const perAddress = maxConnections - clients.size <= reservedConnections ? Math.min(maxPerAddress, maxPerAddressWhenBusy) : maxPerAddress;
    if (group !== null && heldBy(group) >= perAddress) {
      // H1: one address cannot hold the server; refused before it takes a room or any state.
      stats.refused += 1;
      logRefusal(`refused ${from}: ${perAddress} connections from this address already`);
      ws.close(1013, 'network full: too many connections from your network');
      return;
    }
    const caps = parseCaps(new URL(req.url ?? '/', 'http://x').searchParams.get('caps'));
    const target = roomFor(req, seen, group, caps.has('lobby'));
    if ('code' in target) {
      stats.refused += 1;
      logRefusal(`refused ${from}: ${target.why}`);
      ws.close(target.code, target.why);
      return;
    }
    const room = target.room;
    if ((room.lifecycle === 'lobby' && !caps.has('lobby')) || (room.kind === 'plaza' && !caps.has('plaza'))) {
      // L1: a page that does not know the lobby would misread this room: refused, plainly, without a retry loop.
      stats.refused += 1;
      logRefusal(`refused ${from}: room ${room.id} needs a newer client`);
      ws.close(1008, UPDATE_REQUIRED);
      return;
    }
    if (!rooms.hasRoom(room)) {
      stats.refused += 1;
      logRefusal(`refused ${from}: room ${room.id} full`);
      // L4.1: the plaza says so in its own words (the page offers another room or Quick Match, never sends anyone into a match).
      ws.close(1013, room.kind === 'plaza' ? 'plaza full' : 'room full');
      return;
    }
    if (group !== null && heldBy(group, room) >= maxPerAddressPerRoom) {
      // H1: nor every place of one room.
      stats.refused += 1;
      logRefusal(`refused ${from}: ${maxPerAddressPerRoom} connections from this address in room ${room.id} already`);
      ws.close(1013, 'network full: too many connections from your network in this room');
      return;
    }
    const host = room.host;
    const id = nextConn++;
    const out = delayer(lag, jitter, SERVER_LIMITS.maxDelayed);
    const inbound = delayer(lag, jitter, SERVER_LIMITS.maxDelayed);
    const allow = bucket(perSecond);
    let droppedThisSecond = 0;
    let droppedSince = performance.now();
    let warnedMalformed = false;
    let lastChallenge = -Infinity;
    let lastRooms = -Infinity;
    /** M1: when this connection's look was last applied, and the newest one waiting (the latest wins). */
    let lastLook = -Infinity;
    let waitingLook: { form: LookDeclaration | null } | null = null;
    let lookTimer: ReturnType<typeof setTimeout> | null = null;
    const lookEveryMs = config.lookEveryMs ?? SERVER_LIMITS.lookEveryMs;
    /** L2: when this connection's last lobby request of each kind was taken. */
    const lastLobbyAt: Record<LobbyCommand['t'], number> = { ready: -Infinity, start: -Infinity, settings: -Infinity };
    const lobbyCommand = (cmd: LobbyCommand) => {
      const t = performance.now();
      const every = config.lobbyEveryMs?.[cmd.t] ?? SERVER_LIMITS.lobbyEveryMs[cmd.t];
      const refuse = (reason: RefusedMessage['reason']) => client.send(JSON.stringify({ t: 'refused', of: cmd.t, reason } satisfies RefusedMessage));
      if (t - lastLobbyAt[cmd.t] < every) {
        stats.rateDropped += 1;
        return refuse('busy');
      }
      lastLobbyAt[cmd.t] = t;
      const refused = host.command(id, cmd);
      if (refused) return refuse(refused);
      if (cmd.t === 'settings') {
        log(`room ${room.id}: settings by conn ${id}${cmd.bots !== undefined ? ` · bots ${cmd.bots ? 'on' : 'off'}` : ''}${cmd.arena ? ` · arena ${room.host.settings.arena}` : ''}${cmd.rotate !== undefined ? ` · rotate ${cmd.rotate ? 'on' : 'off'}` : ''}`);
      } else if (cmd.t === 'start') log(`room ${room.id}: started by its owner (conn ${id})`);
      // With the roster: bots on or off changes what an empty seat is.
      sendLobby(room);
    };
    const applyLook = (form: LookDeclaration | null) => {
      lastLook = performance.now();
      const r = host.setLook(id, form);
      client.send(JSON.stringify(r.ok ? { t: 'look', ok: true } : { t: 'look', ok: false, reason: r.reason }));
      if (r.ok && r.changed) sendRoster(room);
    };
    // The address a proof must name: the configured public one(s), or the one this connection came in on.
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const addresses = configuredAddresses.length ? configuredAddresses : [authAddress(`ws://${req.headers.host ?? ''}${pathname}`)].filter((a): a is string => !!a);
    const client: Client = {
      id,
      room,
      alive: true,
      group,
      heard: performance.now(),
      send: (data, droppable = false) =>
        out(() => {
          if (ws.readyState !== ws.OPEN) return;
          // A client that cannot keep up: skip states (each supersedes the last); far behind, drop it.
          if (ws.bufferedAmount > SERVER_LIMITS.maxBufferedBytes * 8) return kick(ws, 1013, 'too slow');
          if (droppable && ws.bufferedAmount > SERVER_LIMITS.maxBufferedBytes) return;
          ws.send(data);
          stats.bytesOut += data.length;
        }),
    };
    clients.set(ws, client);
    stats.clients = clients.size;
    rooms.enter(room, id);
    const inRoom = members.get(room) ?? new Set<Client>();
    members.set(room, inRoom.add(client));
    const welcome = host.connect(id);
    log(`conn ${id} from ${seen}: room ${room.id}, ${welcome.you ?? 'spectator'} · ${clients.size} connected`);
    const info: RoomInfo = { id: room.id, kind: room.kind, mode: room.mode, listed: room.listed, arena: room.host.arena.id, rotate: room.host.settings.rotate, ...(identity.public ? { url: roomShareUrl(identity.public.origin, room.id) } : {}), ...(room.lifecycle === 'lobby' ? { lifecycle: 'lobby' as const } : {}) };
    const server: ServerInfo = { ...(identity.name ? { name: identity.name } : {}), ...(identity.operator ? { operator: identity.operator } : {}), ...(identity.public ? { url: identity.public.origin } : {}) };
    client.send(JSON.stringify({ ...welcome, protocol: PROTOCOL.version, features: ['nostr-auth', 'rooms', 'looks', 'rooms-list', 'lobby', 'plaza'], room: info, server }));
    sendRoster(room);
    sendLobby(room, false);
    /** The identity handshake (M8A): challenge, proof, logout. Off the match entirely. */
    const identityMessage = (msg: ClientMessage) => {
      const reply = (m: AuthReply | ChallengeMessage) => client.send(JSON.stringify(m));
      if (msg.t === 'challenge') {
        const t = performance.now();
        if (t - lastChallenge < (config.challengeEveryMs ?? SERVER_LIMITS.challengeEveryMs)) return reply({ t: 'auth', ok: false, reason: 'busy' });
        lastChallenge = t;
        const challenge = challenges.issue(id);
        if (!challenge) return reply({ t: 'auth', ok: false, reason: 'busy' });
        return reply({ t: 'challenge', challenge, ttl: AUTH.ttlMs / 1000 });
      }
      if (msg.t === 'logout') {
        challenges.drop(id);
        if (host.setIdentity(id, null)) sendRoster(room);
        return reply({ t: 'auth', ok: false, reason: 'logged-out' });
      }
      // M10B: the public rooms, counts only, bounded, not more often than the protocol allows per connection.
      if (msg.t === 'rooms') {
        const t = performance.now();
        if (t - lastRooms < PROTOCOL.roomsEveryMs) return;
        lastRooms = t;
        // L4.1: the plaza is listed only to a client that can go there.
        client.send(JSON.stringify({ t: 'rooms', rooms: rooms.listing().filter((r) => r.kind !== 'plaza' || caps.has('plaza')) } satisfies RoomsMessage));
        return;
      }
      // M9C: the look of this connection's own fighter; the host binds it to the proven identity.
      // M1: at most one look (and so one roster to the room) per `lookEveryMs`; a newer one meanwhile replaces the waiting one.
      if (msg.t === 'look') {
        const wait = lastLook + lookEveryMs - performance.now();
        if (wait <= 0 && !lookTimer) return applyLook(msg.form);
        waitingLook = { form: msg.form };
        lookTimer ??= setTimeout(
          () => {
            lookTimer = null;
            const next = waitingLook;
            waitingLook = null;
            if (next && clients.has(ws)) applyLook(next.form);
          },
          Math.max(0, wait),
        );
        return;
      }
      if (msg.t !== 'auth') return;
      const issued = challenges.take(id);
      const result = issued === 'none' ? ({ ok: false, reason: 'no-challenge' } as const) : issued === 'expired' ? ({ ok: false, reason: 'expired' } as const) : verifyAuth(msg.event, { challenge: issued.value, addresses });
      if (!result.ok) {
        stats.authFailed += 1;
        log(`conn ${id}: identity refused (${result.reason})`);
        return reply({ t: 'auth', ok: false, reason: result.reason });
      }
      stats.authOk += 1;
      const changed = host.setIdentity(id, result.pubkey);
      log(`conn ${id}: room ${room.id} ${host.slot(id) ?? 'spectator'} is ${shortNpub(result.pubkey)}`);
      reply({ t: 'auth', ok: true, pubkey: result.pubkey });
      if (changed) sendRoster(room);
    };
    ws.on('pong', () => (client.alive = true));
    ws.on('message', (data, isBinary) => {
      // A connection being dropped says nothing more.
      if (kicked.has(ws)) return;
      const raw = isBinary ? null : data.toString();
      stats.bytesIn += raw?.length ?? 0;
      if (!allow()) {
        stats.rateDropped += 1;
        const now = performance.now();
        if (now - droppedSince > 1000) {
          droppedSince = now;
          droppedThisSecond = 0;
        }
        if (++droppedThisSecond > SERVER_LIMITS.floodDisconnect) kick(ws, 1008, 'flooding');
        return;
      }
      const msg = parseClientMessage(raw);
      if (!msg) {
        stats.malformed += 1;
        if (!warnedMalformed) {
          warnedMalformed = true;
          log(`conn ${id}: malformed message ignored (further ones counted, not logged)`);
        }
        return;
      }
      client.heard = performance.now();
      inbound(() => {
        if (!clients.has(ws)) return;
        if (msg.t === 'challenge' || msg.t === 'auth' || msg.t === 'logout' || msg.t === 'look' || msg.t === 'rooms') return identityMessage(msg);
        if (msg.t === 'ready' || msg.t === 'start' || msg.t === 'settings') return lobbyCommand(msg);
        const reply = host.receive(id, raw);
        if (reply) client.send(JSON.stringify(reply));
      });
    });
    ws.on('close', () => {
      // At once, not after the simulated lag: the slot stops taking this connection's input now.
      if (!clients.delete(ws)) return;
      if (lookTimer) clearTimeout(lookTimer);
      stats.clients = clients.size;
      const slot = host.slot(id);
      host.disconnect(id);
      challenges.drop(id);
      rooms.leave(room, id);
      members.get(room)?.delete(client);
      log(`conn ${id} left room ${room.id}${slot ? `: ${slot} ${room.host.lobby && !room.host.settings.bots ? 'empty' : 'back to its bot'}` : ''} · ${clients.size} connected`);
      sendRoster(room);
      sendLobby(room, false);
    });
    ws.on('error', () => ws.terminate());
  });

  // Heartbeat: a connection that did not answer the last ping (a vanished laptop, a dead route) is dropped; so is one
  // that answers pings (any WebSocket library does, by itself) but has said nothing for `idleMs` (H1: a parked socket).
  const idleMs = config.idleMs ?? SERVER_LIMITS.idleMs;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    for (const [ws, c] of clients) {
      if (!c.alive) {
        kick(ws, 1001, 'no heartbeat');
        continue;
      }
      if (now - c.heard > idleMs) {
        kick(ws, 4008, 'idle');
        continue;
      }
      c.alive = false;
      ws.ping();
    }
  }, config.heartbeatMs ?? SERVER_LIMITS.heartbeatMs);
  heartbeat.unref?.();

  /** Empty private rooms past their grace period go, with their match; L4.5A: idle ones are warned, then closed. */
  const sweep = () => {
    for (const id of rooms.reap()) forget(id, closing.has(id) ? 'inactive' : `empty for ${Math.round(rooms.graceMs / 1000)} s`);
    const t = Date.now();
    for (const room of rooms.all()) {
      if (!idleClosing || room.kind !== 'private' || room.expired || room.connections.size === 0) continue;
      const seen = idleSeen.get(room) ?? { activity: -1, warned: 0 };
      idleSeen.set(room, seen);
      const phase = room.host.lobby?.phase;
      // Something a person did since the last look, or a match on: the room is in use.
      if (seen.activity !== room.host.activity || phase === 'countdown' || phase === 'playing' || phase === 'results') {
        seen.activity = room.host.activity;
        room.activeAt = Math.max(room.activeAt, t);
        if (seen.warned) notice(room, null);
        seen.warned = 0;
        continue;
      }
      const left = room.activeAt + roomIdleMs - t;
      if (left <= 0) {
        // Closed: everyone in it is told why; the room goes as soon as the last socket has (the next sweep).
        rooms.expire(room);
        closing.add(room.id);
        log(`room ${room.id} closing: nobody has played or moved for ${Math.round(roomIdleMs / 60_000)} min`);
        for (const [ws, c] of clients) if (c.room === room) kick(ws, 4009, 'room closed: inactive');
        continue;
      }
      // A warning when each threshold is crossed, once (the largest first).
      const due = roomIdleWarnMs.filter((w) => left <= w).length;
      if (due > seen.warned) {
        seen.warned = due;
        notice(room, Math.ceil(left / 1000));
      }
    }
    stats.rooms = rooms.size;
  };
  const sweeper = config.manual ? null : setInterval(sweep, 1000);
  sweeper?.unref?.();

  const broadcastRoom = (room: Room) => {
    // Nobody to tell: no state built.
    if (!members.get(room)?.size) return;
    const data = JSON.stringify(room.host.state());
    stats.statesSent += 1;
    stats.lastStateBytes = data.length;
    for (const c of members.get(room) ?? []) c.send(data, true);
  };
  const broadcast = () => {
    for (const room of rooms.all()) {
      sendLobby(room);
      broadcastRoom(room);
    }
  };

  // The fixed-step loop on the monotonic clock: every room steps on the same beat.
  const stepMs = 1000 / tickHz;
  let next = performance.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = !config.manual;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    let steps = 0;
    while (now >= next && steps < maxCatchUp) {
      const late = now - next;
      lateSum += late;
      lateCount += 1;
      stats.lateMean = lateSum / lateCount;
      stats.lateMax = Math.max(stats.lateMax, late);
      for (const room of rooms.all()) {
        room.host.tick();
        // L1: a lifecycle change goes out before the state of the tick it happened on.
        sendLobby(room);
        if (room.host.latest.tick % ticksPerSnapshot === 0) broadcastRoom(room);
      }
      stats.ticks += 1;
      next += stepMs;
      steps += 1;
    }
    if (now - next > stepMs) {
      // Too far behind: drop the backlog rather than race through it.
      const behind = Math.floor((now - next) / stepMs);
      stats.dropped += behind;
      next += behind * stepMs;
    }
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  };

  const ready = (port: number): RumbleServer => {
    if (running) loop();
    return {
      get host() {
        return rooms.open.host;
      },
      rooms,
      identity,
      port,
      stats,
      resetStats,
      broadcast,
      sweep,
      limiterSizes: () => ({ creations: creations.size, guesses: guesses.size }),
      close: () =>
        new Promise<void>((done) => {
          running = false;
          if (timer) clearTimeout(timer);
          clearInterval(heartbeat);
          if (sweeper) clearInterval(sweeper);
          for (const ws of clients.keys()) ws.terminate();
          wss.close(() => {
            rooms.dispose();
            done();
          });
        }),
    };
  };

  return new Promise((resolve) => {
    if (config.http) {
      const address = config.http.address();
      resolve(ready(typeof address === 'object' && address ? address.port : 0));
      return;
    }
    wss.on('listening', () => {
      const address = wss.address();
      resolve(ready(typeof address === 'object' && address ? address.port : (config.port ?? 8787)));
    });
  });
}

/**
 * Events per key (an address group) in any minute: room creations, room codes tried in vain. Bounded memory: keys
 * with nothing in the last minute are forgotten, and (L4.5A) never more than `maxKeys` are kept, the oldest first to go.
 */
export function windowLimiter(perMinute: number, maxKeys = 4096) {
  const seen = new Map<string, number[]>();
  const recent = (key: string, t: number) => (seen.get(key) ?? []).filter((x) => t - x < 60_000);
  return {
    get size() {
      return seen.size;
    },
    /** Whether `key` has had `perMinute` events in the last minute. */
    full(key: string) {
      return recent(key, Date.now()).length >= perMinute;
    },
    /** Count one event for `key`. */
    add(key: string) {
      const t = Date.now();
      if (seen.size > 1024) for (const [k, v] of seen) if (!v.some((x) => t - x < 60_000)) seen.delete(k);
      // Never more than a minute's worth kept per key; a key seen again moves to the newest end.
      const kept = [...recent(key, t), t].slice(-perMinute);
      seen.delete(key);
      seen.set(key, kept);
      while (seen.size > maxKeys) seen.delete(seen.keys().next().value!);
    },
    /** An event for `key` if it is under the limit (counted), else false. */
    allow(key: string) {
      if (this.full(key)) return false;
      this.add(key);
      return true;
    },
  };
}
