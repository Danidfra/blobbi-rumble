/**
 * The security audit's limits over real sockets: per-address connection
 * caps and idle sockets (H1), look changes (M1), private-room exhaustion
 * (M2), room-code guessing (M3), and what the log says about players (L2).
 * Addresses come from a client address header, as behind Cloudflare Tunnel.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { RosterMessage, ServerMessage, WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer, type ServerConfig } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
let server: RumbleServer | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

interface Conn {
  ws: WebSocket;
  url: string;
  welcome?: WelcomeMessage;
  closed?: { code: number; reason: string };
  messages: ServerMessage[];
  send: (m: unknown) => void;
}
function open(url: string, ip?: string): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, ip ? { headers: { 'x-client-ip': ip } } : undefined);
    sockets.push(ws);
    const c: Conn = { ws, url, messages: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      c.messages.push(m);
      if (m.t === 'welcome') {
        c.welcome = m;
        resolve(c);
      }
    });
    ws.on('close', (code, reason) => {
      c.closed = { code, reason: reason.toString() };
      resolve(c);
    });
    ws.on('error', () => {});
  });
}
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roster = (c: Conn) => [...c.messages].reverse().find((m): m is RosterMessage => m.t === 'roster');
const start = async (extra: Partial<ServerConfig> = {}) => {
  server = await startRumbleServer({ havok, port: 0, manual: true, clientIpHeader: 'x-client-ip', ...extra });
  return `ws://127.0.0.1:${server.port}`;
};

describe('connection exhaustion (H1)', () => {
  it('one address holds at most four places of a room; others still get in', async () => {
    const base = await start();
    const mine = await Promise.all([1, 2, 3, 4].map(() => open(base, '203.0.113.7')));
    expect(mine.map((c) => c.welcome?.you)).toEqual(['P1', 'P2', 'P3', 'P4']);
    const fifth = await open(base, '203.0.113.7');
    expect(fifth.closed).toEqual({ code: 1013, reason: 'network full: too many connections from your network in this room' });
    // Another household gets the places left (watching: the four fighters are taken).
    const other = await open(base, '198.51.100.2');
    expect(other.welcome?.you).toBeNull();
    // A place freed is a place again.
    mine[0].ws.close();
    await waitFor(() => server!.stats.clients === 4);
    expect((await open(base, '203.0.113.7')).welcome?.you).toBe('P1');
  });

  it('counts a whole IPv6 /64 as one address: rotating through it does not multiply the limit', async () => {
    const base = await start();
    for (let i = 1; i <= 4; i++) expect((await open(base, `2001:db8:1:2::${i}`)).welcome).toBeDefined();
    expect((await open(base, '2001:db8:1:2:abcd::99')).closed?.code).toBe(1013);
    expect((await open(base, '2001:db8:1:3::1')).welcome).toBeDefined();
    // IPv4-mapped IPv6 is its IPv4.
    for (let i = 0; i < 4; i++) await open(base, '192.0.2.1');
    expect((await open(base, '::ffff:192.0.2.1')).closed?.code).toBe(1013);
  });

  it('one address holds at most maxPerAddress connections server-wide, refused before a room is made', async () => {
    const base = await start({ maxPerAddress: 3, maxPerAddressPerRoom: 2 });
    await open(base, '203.0.113.7');
    await open(base, '203.0.113.7');
    const made = await open(`${base}/ws?create=1`, '203.0.113.7');
    expect(made.welcome?.room?.kind).toBe('private');
    const rooms = server!.rooms.size;
    const over = await open(`${base}/ws?create=1`, '203.0.113.7');
    expect(over.closed).toEqual({ code: 1013, reason: 'network full: too many connections from your network' });
    expect(server!.rooms.size).toBe(rooms);
    expect((await open(`${base}/ws?room=${made.welcome!.room!.id}`, '198.51.100.2')).welcome).toBeDefined();
  });

  it('never limits loopback (the operator, local play, a smoke check)', async () => {
    const base = await start();
    const all = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => open(base)));
    expect(all.every((c) => c.welcome)).toBe(true);
  });

  it('closes a socket that says nothing (it only answers pings), and keeps one that pings while standing still', async () => {
    const base = await start({ idleMs: 400, heartbeatMs: 100 });
    const parked = await open(base, '203.0.113.7');
    const player = await open(base, '198.51.100.2');
    let id = 0;
    const pinging = setInterval(() => player.send({ t: 'ping', id: ++id, ct: 0 }), 100);
    try {
      await waitFor(() => parked.closed !== undefined, 2000);
      expect(parked.closed).toEqual({ code: 4008, reason: 'idle' });
      await sleep(600);
      expect(player.closed).toBeUndefined();
      // The parked fighter went back to its bot.
      expect(roster(player)?.slots.P1).toEqual({ who: 'bot' });
      expect(roster(player)?.slots.P2).toEqual({ who: 'guest' });
    } finally {
      clearInterval(pinging);
    }
  });
});
