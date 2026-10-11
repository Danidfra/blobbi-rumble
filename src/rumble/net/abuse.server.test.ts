/**
 * The security audit's limits over real sockets: per-address connection
 * caps and idle sockets (H1), look changes (M1), private-room exhaustion
 * (M2), room-code guessing (M3), and what the log says about players (L2).
 * Addresses come from a client address header, as behind Cloudflare Tunnel.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
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
async function prove(c: Conn, sk: Uint8Array) {
  const at = c.messages.length;
  c.send({ t: 'challenge' });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'challenge'));
  const ch = c.messages.slice(at).find((m) => m.t === 'challenge') as { challenge: string };
  c.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(c.url.replace(/\?.*$/, ''), ch.challenge), sk) });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'auth'));
}
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

describe('look changes (M1)', () => {
  it('a look flood reaches the room at most once per interval, and the latest look always wins', async () => {
    const base = await start({ lookEveryMs: 200 });
    const sk = generateSecretKey();
    const d = (tail: string) => `blobbi-${getPublicKey(sk).slice(0, 12)}-${tail}`;
    const flooder = await open(base, '203.0.113.7');
    const watcher = await open(base, '198.51.100.2');
    await prove(flooder, sk);
    await waitFor(() => roster(watcher)?.slots.P1?.who === 'nostr');
    const before = watcher.messages.filter((m) => m.t === 'roster').length;
    const t0 = Date.now();
    // The first look is applied at once.
    flooder.send({ t: 'look', form: { v: 1, d: d('0000000000'), gen: 'v3' } });
    await waitFor(() => roster(watcher)?.slots.P1?.who === 'nostr' && 'form' in roster(watcher)!.slots.P1);
    // Then 100 alternating looks as fast as the socket goes (under the message rate limit), the last one 'ffffffffff'.
    for (let i = 0; i < 99; i++) flooder.send({ t: 'look', form: { v: 1, d: d(i % 2 ? '1111111111' : '2222222222'), gen: 'v3' } });
    flooder.send({ t: 'look', form: { v: 1, d: d('ffffffffff'), gen: 'v3' } });
    await waitFor(() => { const s = roster(watcher)?.slots.P1; return s?.who === 'nostr' && s.form?.d === d('ffffffffff'); }, 3000);
    await sleep(500);
    const rosters = watcher.messages.filter((m) => m.t === 'roster').length - before;
    const seconds = (Date.now() - t0) / 1000;
    // Without the limit: 101 rosters. With it: one at once, then at most one per 200 ms.
    expect(rosters).toBeLessThanOrEqual(2 + Math.ceil(seconds / 0.2));
    expect(rosters).toBeLessThan(15);
    const last = roster(watcher)?.slots.P1;
    expect(last?.who === 'nostr' && last.form?.d).toBe(d('ffffffffff'));
  });

  it('a single look change is applied at once, as before', async () => {
    const base = await start();
    const sk = generateSecretKey();
    const c = await open(base, '203.0.113.7');
    await prove(c, sk);
    const at = c.messages.length;
    const t0 = Date.now();
    c.send({ t: 'look', form: { v: 1, d: `blobbi-${getPublicKey(sk).slice(0, 12)}-0123456789`, gen: 'v3' } });
    await waitFor(() => c.messages.slice(at).some((m) => m.t === 'look'));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(c.messages.slice(at).find((m) => m.t === 'look')).toEqual({ t: 'look', ok: true });
  });
});

describe('private-room exhaustion (M2)', () => {
  it('one address keeps at most roomsPerAddress games open; others can still make theirs; a closed one frees its place', async () => {
    const base = await start({ roomsPerAddress: 2, roomsPerMinute: 10, roomGraceMs: 60_000 });
    for (let i = 0; i < 2; i++) {
      const made = await open(`${base}/ws?create=1`, '203.0.113.7');
      expect(made.welcome?.room?.kind).toBe('private');
      // The maker leaves: the room stays (grace period) and still counts.
      made.ws.close();
    }
    await waitFor(() => server!.stats.clients === 0);
    const third = await open(`${base}/ws?create=1`, '203.0.113.7');
    expect(third.closed).toEqual({ code: 4003, reason: 'too many open games from your network' });
    // A whole IPv6 /64 is one address; another network is not affected.
    await open(`${base}/ws?create=1`, '2001:db8:1:2::1');
    await open(`${base}/ws?create=1`, '2001:db8:1:2::2');
    expect((await open(`${base}/ws?create=1`, '2001:db8:1:2::3')).closed?.code).toBe(4003);
    expect((await open(`${base}/ws?create=1`, '198.51.100.2')).welcome?.room?.kind).toBe('private');
    // Its games closed (empty past the grace period), the first address may make new ones.
    server!.rooms.all().forEach((r) => (r.emptySince = r.kind === 'private' ? 0 : r.emptySince));
    for (const s of sockets) s.terminate();
    await waitFor(() => server!.stats.clients === 0);
    server!.rooms.all().forEach((r) => (r.emptySince = r.kind === 'private' ? 0 : r.emptySince));
    server!.sweep();
    expect(server!.rooms.size).toBe(1);
    expect((await open(`${base}/ws?create=1`, '203.0.113.7')).welcome?.room?.kind).toBe('private');
  });

  it('the per-minute creation limit counts an IPv6 /64 as one address', async () => {
    const base = await start({ roomsPerMinute: 1 });
    expect((await open(`${base}/ws?create=1`, '2001:db8:9:9::1')).welcome).toBeDefined();
    expect((await open(`${base}/ws?create=1`, '2001:db8:9:9::2')).closed).toEqual({ code: 4003, reason: 'too many new rooms, wait a minute' });
  });
});

describe('room-code guessing (M3)', () => {
  it('past roomGuessesPerMinute codes tried in vain, joining by code waits; right codes never count; other addresses are unaffected', async () => {
    const base = await start({ roomGuessesPerMinute: 3 });
    const made = await open(`${base}/ws?create=1`, '198.51.100.2');
    const code = made.welcome!.room!.id;
    // Right codes, as often as you like (a reconnecting player).
    for (let i = 0; i < 5; i++) {
      const c = await open(`${base}/ws?room=${code}`, '203.0.113.7');
      expect(c.welcome?.room?.id).toBe(code);
      c.ws.close();
    }
    for (const wrong of ['ZZZZ', 'YYYY', 'not-a-code']) expect((await open(`${base}/ws?room=${wrong}`, '203.0.113.7')).closed?.code).toBe(4004);
    // The limit reached: even the right code waits for the minute to pass (no oracle for a guesser).
    expect((await open(`${base}/ws?room=${code}`, '203.0.113.7')).closed).toEqual({ code: 4003, reason: 'too many room codes tried, wait a minute' });
    expect((await open(`${base}/ws?room=WXYZ`, '2001:db8:1:2::7')).closed?.code).toBe(4004);
    // Another address, and plain visits to the open room, are not affected.
    expect((await open(`${base}/ws?room=${code}`, '192.0.2.5')).welcome?.room?.id).toBe(code);
    expect((await open(base, '203.0.113.7')).welcome?.room?.id).toBe('OPEN');
  });
});
