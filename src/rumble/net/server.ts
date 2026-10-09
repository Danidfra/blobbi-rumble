/**
 * THE RUMBLE SERVER: one authoritative match (`RumbleHost`) behind a
 * WebSocket endpoint, stepped by the server's own clock at a fixed rate.
 *
 *   clients ──input / ping──► host.receive ··· host.tick() @ 60 Hz ··· every 3rd tick ──state──► every client
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
 * that stopped answering.
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
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HavokInstance } from '../sim/physics';
import { AUTH, ChallengeBook, authAddress, verifyAuth } from '../../social/auth';
import { shortNpub } from '../../social/keys';
import { RumbleHost, type ConnectionId } from './host';
import { parseClientMessage, type AuthReply, type ChallengeMessage, type ClientMessage } from './protocol';

export const SERVER_LIMITS = Object.freeze({
  /** Connections at once: four players and a few spectators. */
  maxConnections: 16,
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
}

export interface RumbleServer {
  host: RumbleHost;
  port: number;
  stats: ServerStats;
  resetStats(): void;
  /** Send the current state to every client now. */
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

/** A token bucket: `take()` is true while the rate is respected. */
function bucket(perSecond: number) {
  let tokens = perSecond;
  let at = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(perSecond, tokens + ((now - at) / 1000) * perSecond);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

interface Client {
  id: ConnectionId;
  send: (data: string, droppable?: boolean) => void;
  alive: boolean;
}

export function startRumbleServer(config: ServerConfig): Promise<RumbleServer> {
  const host = new RumbleHost({ havok: config.havok, tickHz: config.tickHz, snapshotHz: config.snapshotHz });
  const maxCatchUp = config.maxCatchUp ?? 5;
  const maxConnections = config.maxConnections ?? SERVER_LIMITS.maxConnections;
  const perSecond = config.maxMessagesPerSecond ?? SERVER_LIMITS.maxMessagesPerSecond;
  const lag = config.lagMs ?? 0;
  const jitter = config.jitterMs ?? 0;
  const log = config.log ?? (() => {});
  const fresh = () => ({ ticks: 0, dropped: 0, lateMean: 0, lateMax: 0, statesSent: 0, bytesOut: 0, bytesIn: 0, refused: 0, malformed: 0, rateDropped: 0, kicked: 0, authOk: 0, authFailed: 0 });
  const stats: ServerStats = { ...fresh(), lastStateBytes: 0, clients: 0 };
  let lateSum = 0;
  let lateCount = 0;
  const resetStats = () => {
    Object.assign(stats, fresh());
    lateSum = 0;
    lateCount = 0;
  };
  const clients = new Map<WebSocket, Client>();
  let nextConn = 1;
  const challenges = new ChallengeBook({ max: Math.max(maxConnections * 2, 8) });
  const configuredAddresses = (config.authUrls ?? []).map(authAddress).filter((a): a is string => !!a);
  /** Who drives each slot (bot, guest, proven pubkey) to everyone: on any change, never droppable. */
  const sendRoster = () => {
    const data = JSON.stringify(host.roster());
    for (const c of clients.values()) c.send(data);
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

  wss.on('connection', (ws, req: IncomingMessage) => {
    const from = `${req.socket.remoteAddress ?? '?'}${req.headers.origin ? ` (${req.headers.origin})` : ''}`;
    if (clients.size >= maxConnections) {
      // Full: refused cleanly, before it takes a slot or any state.
      stats.refused += 1;
      log(`refused ${from}: server full (${clients.size}/${maxConnections})`);
      ws.close(1013, 'server full');
      return;
    }
    const id = nextConn++;
    const out = delayer(lag, jitter, SERVER_LIMITS.maxDelayed);
    const inbound = delayer(lag, jitter, SERVER_LIMITS.maxDelayed);
    const allow = bucket(perSecond);
    let droppedThisSecond = 0;
    let droppedSince = performance.now();
    let warnedMalformed = false;
    let lastChallenge = -Infinity;
    // The address a proof must name: the configured public one(s), or the one this connection came in on.
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const addresses = configuredAddresses.length ? configuredAddresses : [authAddress(`ws://${req.headers.host ?? ''}${pathname}`)].filter((a): a is string => !!a);
    const client: Client = {
      id,
      alive: true,
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
    const welcome = host.connect(id);
    log(`conn ${id} from ${from}: ${welcome.you ?? 'spectator'} · ${clients.size} connected`);
    client.send(JSON.stringify({ ...welcome, features: ['nostr-auth'] }));
    sendRoster();
    /** The identity handshake (M8A): challenge, proof, logout. Off the match entirely. */
    const identity = (msg: ClientMessage) => {
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
        if (host.setIdentity(id, null)) sendRoster();
        return reply({ t: 'auth', ok: false, reason: 'logged-out' });
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
      log(`conn ${id}: ${host.slot(id) ?? 'spectator'} is ${shortNpub(result.pubkey)}`);
      reply({ t: 'auth', ok: true, pubkey: result.pubkey });
      if (changed) sendRoster();
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
      inbound(() => {
        if (!clients.has(ws)) return;
        if (msg.t === 'challenge' || msg.t === 'auth' || msg.t === 'logout') return identity(msg);
        const reply = host.receive(id, raw);
        if (reply) client.send(JSON.stringify(reply));
      });
    });
    ws.on('close', () => {
      // At once, not after the simulated lag: the slot stops taking this connection's input now.
      if (!clients.delete(ws)) return;
      stats.clients = clients.size;
      const slot = host.slot(id);
      host.disconnect(id);
      challenges.drop(id);
      if (slot) sendRoster();
      log(`conn ${id} left${slot ? `: ${slot} back to its bot` : ''} · ${clients.size} connected`);
    });
    ws.on('error', () => ws.terminate());
  });

  // Heartbeat: a connection that did not answer the last ping (a vanished laptop, a dead route) is dropped.
  const heartbeat = setInterval(() => {
    for (const [ws, c] of clients) {
      if (!c.alive) {
        kick(ws, 1001, 'no heartbeat');
        continue;
      }
      c.alive = false;
      ws.ping();
    }
  }, SERVER_LIMITS.heartbeatMs);
  heartbeat.unref?.();

  const broadcast = () => {
    const data = JSON.stringify(host.state());
    stats.statesSent += 1;
    stats.lastStateBytes = data.length;
    for (const c of clients.values()) c.send(data, true);
  };

  // The fixed-step loop on the monotonic clock.
  const stepMs = 1000 / host.tickHz;
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
      host.tick();
      stats.ticks += 1;
      if (host.latest.tick % host.ticksPerSnapshot === 0) broadcast();
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
      host,
      port,
      stats,
      resetStats,
      broadcast,
      close: () =>
        new Promise<void>((done) => {
          running = false;
          if (timer) clearTimeout(timer);
          clearInterval(heartbeat);
          for (const ws of clients.keys()) ws.terminate();
          wss.close(() => {
            host.dispose();
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
