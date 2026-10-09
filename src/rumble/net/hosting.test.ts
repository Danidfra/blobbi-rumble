/**
 * Hosting beyond localhost: the production entrypoint's static files and
 * /ws on one port, and the limits a public server needs (full, floods,
 * malformed traffic), plus spectators and reconnecting as a new connection.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { ServerMessage, WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer } from './server';
import { LANDING, resolveStatic, staticHandler } from './static';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
let server: RumbleServer | null = null;
let http: Server | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
});

/** Open a client; resolves with its welcome, or with the close code/reason if refused. */
function open(url: string): Promise<{ ws: WebSocket; welcome?: WelcomeMessage; closed?: { code: number; reason: string }; messages: ServerMessage[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      messages.push(m);
      if (m.t === 'welcome') resolve({ ws, welcome: m, messages });
    });
    ws.on('close', (code, reason) => resolve({ ws, closed: { code, reason: reason.toString() }, messages }));
    ws.on('error', () => {});
  });
}
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the production entrypoint', () => {
  function site() {
    const root = mkdtempSync(join(tmpdir(), 'rumble-dist-'));
    writeFileSync(join(root, 'rumble.html'), '<!doctype html><title>Blobbi Rumble</title>');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'HavokPhysics-abc.wasm'), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(root, 'assets', 'rumble-abc.js'), 'export {}');
    return root;
  }

  it('serves the built game and the match on one port: / to the network game, pages, hashed assets, wasm, /healthz, and /ws', async () => {
    const root = site();
    http = createServer(staticHandler(root, () => ({ ok: true, clients: server?.stats.clients ?? 0 })));
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    server = await startRumbleServer({ havok, http, path: '/ws', manual: true });
    const port = (http.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const landing = await fetch(`${base}/`, { redirect: 'manual' });
    expect(landing.status).toBe(302);
    expect(landing.headers.get('location')).toBe(LANDING);
    const pageRes = await fetch(`${base}/rumble.html?network=1`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('content-type')).toMatch(/text\/html/);
    expect(pageRes.headers.get('cache-control')).toBe('no-cache');
    const wasm = await fetch(`${base}/assets/HavokPhysics-abc.wasm`);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(wasm.headers.get('cache-control')).toMatch(/immutable/);
    expect((await fetch(`${base}/assets/rumble-abc.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${base}/nope.html`)).status).toBe(404);
    expect((await fetch(`${base}/rumble.html`, { method: 'POST' })).status).toBe(405);
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health).toMatchObject({ ok: true });
    const c = await open(`ws://127.0.0.1:${port}/ws`);
    expect(c.welcome?.you).toBe('P1');
    // Any other path is not the game's socket.
    const other = await new Promise<string>((r) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
      ws.on('error', () => r('refused'));
      ws.on('open', () => r('opened'));
    });
    expect(other).toBe('refused');
  });

  it('never serves a file outside the build directory', () => {
    const root = site();
    expect(resolveStatic(root, '/rumble.html')).toBe(join(root, 'rumble.html'));
    for (const evil of ['/../package.json', '/..%2f..%2fetc/passwd', '/assets/../../x', '/%00', '/%E0%A4%A']) {
      const r = resolveStatic(root, evil);
      expect(r === null || r.startsWith(root)).toBe(true);
    }
  });
});

describe('limits for a public server', () => {
  it('past the connection cap a newcomer is refused cleanly with "server full", before it takes anything', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, maxConnections: 5 });
    const url = `ws://127.0.0.1:${server.port}`;
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) got.push((await open(url)).welcome!.you);
    expect(got).toEqual(['P1', 'P2', 'P3', 'P4', null]);
    const sixth = await open(url);
    expect(sixth.welcome).toBeUndefined();
    expect(sixth.closed).toEqual({ code: 1013, reason: 'server full' });
    expect(server.stats.refused).toBe(1);
    expect(server.stats.clients).toBe(5);
  });

  it('a flood is cut down to the rate limit, and a sustained one is disconnected; normal play is untouched', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}`;
    const normal = await open(url);
    const flooder = await open(url);
    let closed: number | null = null;
    flooder.ws.on('close', (code) => (closed = code));
    // A normal client: 60 inputs in a second, none dropped.
    for (let i = 1; i <= 60; i++) normal.ws.send(JSON.stringify({ t: 'input', seq: i, intent: { x: 1 } }));
    // The flooder: thousands at once.
    for (let i = 1; i <= 3000; i++) flooder.ws.send(JSON.stringify({ t: 'input', seq: i, intent: { x: -1 } }));
    await waitFor(() => closed !== null);
    expect(closed).toBe(1008);
    expect(server.stats.rateDropped).toBeGreaterThan(600);
    expect(server.stats.kicked).toBe(1);
    // The normal client's inputs all arrived: its last seq is applied at the next step.
    server.host.tick();
    expect(server.host.state().acks.P1).toBe(60);
    // The flooder's slot went back to its bot.
    expect(server.host.state().control.P2).toBe('bot');
  });

  it('malformed traffic is counted (and logged once per connection), never applied', async () => {
    const lines: string[] = [];
    server = await startRumbleServer({ havok, port: 0, manual: true, log: (l) => lines.push(l) });
    const c = await open(`ws://127.0.0.1:${server.port}`);
    for (const raw of ['nonsense', '{"t":"teleport"}', '{"t":"input","seq":"x"}', '[]']) c.ws.send(raw);
    await waitFor(() => server!.stats.malformed === 4);
    expect(lines.filter((l) => l.includes('malformed'))).toHaveLength(1);
    expect(lines.some((l) => /conn 1 from .*: room OPEN, P1/.test(l))).toBe(true);
  });
});

describe('spectators and reconnects', () => {
  it('a fifth connection watches: it receives the authoritative states and drives nobody', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}`;
    for (let i = 0; i < 4; i++) await open(url);
    const watcher = await open(url);
    expect(watcher.welcome?.you).toBeNull();
    for (let k = 0; k < 6; k++) server.host.tick();
    server.broadcast();
    await waitFor(() => watcher.messages.some((m) => m.t === 'state'));
    const st = watcher.messages.find((m) => m.t === 'state');
    expect(st && st.t === 'state' && st.snapshot.fighters).toHaveLength(4);
    expect(Object.values(server.host.state().control)).toEqual(['human', 'human', 'human', 'human']);
  });

  it('a reconnect is a new connection: the freed slot, a fresh input sequence, nothing restored', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}`;
    const a = await open(url);
    const b = await open(url);
    expect(a.welcome?.you).toBe('P1');
    a.ws.send(JSON.stringify({ t: 'input', seq: 50, intent: { x: 1 } }));
    await new Promise((r) => setTimeout(r, 50));
    server.host.tick();
    expect(server.host.state().acks.P1).toBe(50);
    a.ws.close();
    await waitFor(() => server!.host.state().control.P1 === 'bot');
    const again = await open(url);
    expect(again.welcome?.you).toBe('P1');
    // A new connection's sequence starts over: seq 1 is accepted, not refused as stale.
    again.ws.send(JSON.stringify({ t: 'input', seq: 1, intent: { x: -1 } }));
    await new Promise((r) => setTimeout(r, 50));
    server.host.tick();
    expect(server.host.state().acks.P1).toBe(1);
    expect(b.welcome?.you).toBe('P2');
  });
});
