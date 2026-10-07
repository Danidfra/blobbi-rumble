/**
 * THE RUMBLE SERVER, M7B: one authoritative match (`RumbleHost`) behind a
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
 * DEV ONLY: `lagMs` / `jitterMs` delay every message each way on its own
 * connection (in order), to feel latency locally. They live in the
 * transport, never in the match or the protocol.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { HavokInstance } from '../sim/physics';
import { RumbleHost, type ConnectionId } from './host';

export interface ServerConfig {
  havok: HavokInstance;
  port?: number;
  host?: string;
  tickHz?: number;
  snapshotHz?: number;
  /** At most this many steps run in one wake-up; more backlog than that is dropped. */
  maxCatchUp?: number;
  /** Dev only: added one-way delay on every message, each way, and up to this much more at random. */
  lagMs?: number;
  jitterMs?: number;
  /** Don't start the clock (tests step `host.tick()` themselves and call `broadcast()`). */
  manual?: boolean;
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

/** Delivers callbacks after `lag` + up to `jitter` ms, never out of order. Dev-only latency. */
function delayer(lagMs: number, jitterMs: number) {
  let last = 0;
  return (fn: () => void) => {
    if (lagMs <= 0 && jitterMs <= 0) return fn();
    const at = Math.max(last, performance.now() + lagMs + Math.random() * jitterMs);
    last = at;
    setTimeout(fn, at - performance.now());
  };
}

export function startRumbleServer(config: ServerConfig): Promise<RumbleServer> {
  const host = new RumbleHost({ havok: config.havok, tickHz: config.tickHz, snapshotHz: config.snapshotHz });
  const maxCatchUp = config.maxCatchUp ?? 5;
  const lag = config.lagMs ?? 0;
  const jitter = config.jitterMs ?? 0;
  const stats: ServerStats = { ticks: 0, dropped: 0, lateMean: 0, lateMax: 0, statesSent: 0, bytesOut: 0, bytesIn: 0, lastStateBytes: 0, clients: 0 };
  let lateSum = 0;
  let lateCount = 0;
  const resetStats = () => {
    Object.assign(stats, { ticks: 0, dropped: 0, lateMean: 0, lateMax: 0, statesSent: 0, bytesOut: 0, bytesIn: 0 });
    lateSum = 0;
    lateCount = 0;
  };
  const clients = new Map<WebSocket, { id: ConnectionId; send: (data: string) => void }>();
  let nextConn = 1;

  const wss = new WebSocketServer({ port: config.port ?? 8787, host: config.host ?? '127.0.0.1', maxPayload: 4096 });
  wss.on('connection', (ws) => {
    const id = nextConn++;
    const out = delayer(lag, jitter);
    const inbound = delayer(lag, jitter);
    const send = (data: string) =>
      out(() => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(data);
        stats.bytesOut += data.length;
      });
    clients.set(ws, { id, send });
    stats.clients = clients.size;
    send(JSON.stringify(host.connect(id)));
    ws.on('message', (data, isBinary) => {
      const raw = isBinary ? null : data.toString();
      stats.bytesIn += raw?.length ?? 0;
      inbound(() => {
        if (!clients.has(ws)) return;
        const reply = host.receive(id, raw);
        if (reply) send(JSON.stringify(reply));
      });
    });
    ws.on('close', () => {
      // At once, not after the simulated lag: the slot stops taking this connection's input now.
      clients.delete(ws);
      stats.clients = clients.size;
      host.disconnect(id);
    });
    ws.on('error', () => ws.terminate());
  });

  const broadcast = () => {
    const data = JSON.stringify(host.state());
    stats.statesSent += 1;
    stats.lastStateBytes = data.length;
    for (const c of clients.values()) c.send(data);
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

  return new Promise((resolve) => {
    wss.on('listening', () => {
      if (running) loop();
      const address = wss.address();
      resolve({
        host,
        port: typeof address === 'object' && address ? address.port : (config.port ?? 8787),
        stats,
        resetStats,
        broadcast,
        close: () =>
          new Promise<void>((done) => {
            running = false;
            if (timer) clearTimeout(timer);
            for (const ws of clients.keys()) ws.terminate();
            wss.close(() => {
              host.dispose();
              done();
            });
          }),
      });
    });
  });
}
