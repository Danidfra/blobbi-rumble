/**
 * L4.5A: private-room capacity over real sockets. A network keeps at most
 * two rooms open (one once the server is nearly full); when every place is
 * taken, the room empty the longest gives way to a new one, never a room
 * anyone is in; a room nobody plays or moves in is warned, then closed,
 * never while its match is on and never the plaza or the open room; pings,
 * keepalives and listings are not activity; a header claiming loopback is
 * limited like any address; limiter state and refusal logs stay bounded.
 * Addresses come from a client address header, as behind Cloudflare Tunnel.
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { LobbyMessage, NoticeMessage, ServerMessage, WelcomeMessage } from './protocol';
import { SERVER_LIMITS, startRumbleServer, windowLimiter, type RumbleServer, type ServerConfig } from './server';

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
const lines: string[] = [];
const start = async (extra: Partial<ServerConfig> = {}) => {
  lines.length = 0;
  server = await startRumbleServer({ havok, port: 0, manual: true, clientIpHeader: 'x-client-ip', log: (l) => lines.push(l), ...extra });
  return `ws://127.0.0.1:${server.port}`;
};
const CREATE = '/ws?create=1&caps=lobby,plaza';
const create = (base: string, ip: string) => open(`${base}${CREATE}`, ip);
const join = (base: string, code: string, ip: string) => open(`${base}/ws?room=${code}&caps=lobby,plaza`, ip);
const leave = async (c: Conn) => {
  c.ws.close();
  await waitFor(() => !!c.closed);
};
const lobby = (c: Conn) => [...c.messages].reverse().find((m): m is LobbyMessage => m.t === 'lobby');
const notices = (c: Conn) => c.messages.filter((m): m is NoticeMessage => m.t === 'notice');
const roomOf = (code: string) => server!.rooms.all().find((r) => r.id === code)!;
/** Make a room look idle for `ms` (its last activity that long ago), as the clock would after waiting. */
const idleFor = (code: string, ms: number) => {
  roomOf(code).activeAt = Date.now() - ms;
};
let seq = 0;
const move = (c: Conn, x: number, z = 0) => c.send({ t: 'input', seq: ++seq, intent: { x, z, run: false } });
/** Let the server read what was sent, then look (the sweep compares the host's activity with the last look). */
const settle = async () => {
  await sleep(40);
  server!.sweep();
};

describe('creating rooms (L4.5A)', () => {
  it('a guest makes a room and friends join it; a proven Nostr identity gets no more rooms than a guest', async () => {
    const base = await start();
    const a = await create(base, '203.0.113.1');
    expect(a.welcome?.room?.kind).toBe('private');
    const code = a.welcome!.room!.id;
    const friend = await join(base, code, '198.51.100.9');
    expect(friend.welcome?.room?.id).toBe(code);
    // A proven identity on the same network: the network's places are the same.
    const b = await create(base, '203.0.113.1');
    const sk = generateSecretKey();
    b.send({ t: 'challenge' });
    await waitFor(() => b.messages.some((m) => m.t === 'challenge'));
    const ch = b.messages.find((m) => m.t === 'challenge') as { challenge: string };
    b.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(`${base}/ws`, ch.challenge), sk) });
    await waitFor(() => b.messages.some((m) => m.t === 'auth'));
    expect(b.messages.find((m) => m.t === 'auth')).toMatchObject({ ok: true });
    expect((await create(base, '203.0.113.1')).closed).toEqual({ code: 4003, reason: 'too many open games from your network' });
  });

  it('one network keeps two rooms open at most, whatever it tries: a burst, reconnecting, leaving them empty', async () => {
    const base = await start({ roomsPerMinute: 30 });
    let made = 0;
    let refused = 0;
    for (let i = 0; i < 20; i++) {
      const c = await create(base, '203.0.113.7');
      if (c.welcome) made += 1;
      else refused += 1;
      await leave(c);
    }
    expect(made).toBe(SERVER_LIMITS.roomsPerAddress);
    expect(refused).toBe(20 - SERVER_LIMITS.roomsPerAddress);
    // Rejoining its own empty rooms by code is always possible (a reconnect), and makes no more places.
    for (const r of server!.rooms.all().filter((x) => x.kind === 'private')) expect((await join(base, r.id, '203.0.113.7')).welcome?.room?.id).toBe(r.id);
    expect((await create(base, '203.0.113.7')).closed?.code).toBe(4003);
    // An IPv6 /64 is one network, however many addresses it rotates through.
    expect((await create(base, '2001:db8:5:5::1')).welcome).toBeDefined();
    expect((await create(base, '2001:db8:5:5::2')).welcome).toBeDefined();
    expect((await create(base, '2001:db8:5:5::3')).closed?.reason).toBe('too many open games from your network');
  });

  it('a shared network (a household, a café): two groups each host a room; a third joins one by its code instead', async () => {
    const base = await start();
    const one = await create(base, '192.0.2.50');
    const two = await create(base, '192.0.2.50');
    expect(one.welcome && two.welcome).toBeTruthy();
    const three = await create(base, '192.0.2.50');
    expect(three.closed).toEqual({ code: 4003, reason: 'too many open games from your network' });
    expect((await join(base, one.welcome!.room!.id, '192.0.2.50')).welcome?.room?.id).toBe(one.welcome!.room!.id);
    // Room switching: someone in one room goes to the other.
    const switching = await join(base, two.welcome!.room!.id, '192.0.2.50');
    expect(switching.welcome?.room?.id).toBe(two.welcome!.room!.id);
  });

  it('a creation cooldown per network: past roomsPerMinute in a minute, wait (other networks are not affected)', async () => {
    const base = await start({ roomsPerMinute: 2, roomsPerAddress: 10 });
    expect((await create(base, '203.0.113.20')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.20')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.20')).closed).toEqual({ code: 4003, reason: 'too many new rooms, wait a minute' });
    expect((await create(base, '203.0.113.21')).welcome).toBeDefined();
  });

  it('nearly full, a network with a room open makes no second one: the last places go to networks with none', async () => {
    // Eight rooms: OPEN, PLAZA and six private; nearly full at four places left.
    const base = await start({ maxRooms: 8, reservedRooms: 4 });
    expect((await create(base, '203.0.113.30')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.30')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.31')).welcome).toBeDefined();
    // Three places left (≤ 4): the network with one room gets no second.
    expect((await create(base, '203.0.113.31')).closed?.reason).toBe('too many open games from your network');
    expect((await create(base, '203.0.113.32')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.33')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.34')).welcome).toBeDefined();
    expect(server!.rooms.size).toBe(8);
  });

  it('a header claiming loopback is just another address: limited (only the socket’s own loopback is the operator)', async () => {
    const base = await start();
    expect((await create(base, '127.0.0.1')).welcome).toBeDefined();
    expect((await create(base, '127.0.0.1')).welcome).toBeDefined();
    expect((await create(base, '127.0.0.1')).closed?.reason).toBe('too many open games from your network');
    // The operator's own loopback socket (no header) is still not limited.
    for (let i = 0; i < 3; i++) expect((await open(`${base}${CREATE}`)).welcome).toBeDefined();
  });

  it('a restart forgets every room and limit (all in memory): PLAZA and OPEN are back, a network may create again', async () => {
    let base = await start({ roomsPerMinute: 1 });
    expect((await create(base, '203.0.113.40')).welcome).toBeDefined();
    expect((await create(base, '203.0.113.40')).closed?.code).toBe(4003);
    for (const s of sockets.splice(0)) s.terminate();
    await server!.close();
    base = await start({ roomsPerMinute: 1 });
    expect(server!.rooms.all().map((r) => r.id).sort()).toEqual(['OPEN', 'PLAZA']);
    expect((await create(base, '203.0.113.40')).welcome).toBeDefined();
  });
});

describe('a full server (L4.5A)', () => {
  it('the original exhaustion: rooms made and left empty fill every place; a new game takes the one empty the longest', async () => {
    const base = await start({ roomReclaimAfterMs: 0 });
    // Networks make two rooms each (one, once nearly full) and leave at once, until every private place is taken.
    const made: string[] = [];
    let networks = 0;
    for (let n = 1; server!.rooms.size < 16; n++) {
      networks = n;
      for (let k = 0; k < 2; k++) {
        const c = await create(base, `203.0.113.${100 + n}`);
        if (c.welcome) made.push(c.welcome.room!.id);
        await leave(c);
      }
    }
    // Before L4.5A five networks did it (three rooms each); now it takes nine.
    expect(networks).toBe(9);
    expect(made).toHaveLength(14);
    // The ninth network's only room, empty the longest.
    const oldest = made[made.length - 1];
    roomOf(oldest).emptySince = Date.now() - 60_000;
    const legit = await create(base, '192.0.2.77');
    expect(legit.welcome?.room?.kind).toBe('private');
    expect(server!.rooms.size).toBe(16);
    expect(server!.rooms.get(oldest)).toBeNull();
    expect(lines.some((l) => l.includes(`room ${oldest} closed (given up to a new game`))).toBe(true);
    // Its maker may make a room again (the reclaimed one no longer counts against its network); a network that still
    // has a room open makes no second one while the server is this full.
    expect((await create(base, '203.0.113.101')).closed?.reason).toBe('too many open games from your network');
    expect((await create(base, '203.0.113.109')).welcome).toBeDefined();
  });

  it('never a room anyone is in, nor one just emptied (a dropped player is coming back): then the server is plainly full', async () => {
    const base = await start({ roomReclaimAfterMs: 20_000 });
    for (let n = 1; n <= 14; n++) await create(base, `198.51.100.${n}`);
    expect(server!.rooms.size).toBe(16);
    expect((await create(base, '192.0.2.78')).closed).toEqual({ code: 4003, reason: 'room limit reached' });
    // One room's people drop: just emptied, it is kept for them.
    const someone = sockets[0];
    someone.close();
    await waitFor(() => server!.rooms.all().some((r) => r.kind === 'private' && r.emptySince !== null));
    expect((await create(base, '192.0.2.79')).closed?.reason).toBe('room limit reached');
    expect(server!.rooms.size).toBe(16);
  });
});

describe('rooms nobody plays in (L4.5A)', () => {
  const MIN = 60_000;

  it('warned before it closes; moving keeps it; then, idle for good, it closes with 4009 and is gone', async () => {
    const base = await start({ roomIdleMs: 20 * MIN });
    const a = await create(base, '203.0.113.50');
    const code = a.welcome!.room!.id;
    await settle();
    idleFor(code, 19 * MIN);
    server!.sweep();
    await waitFor(() => notices(a).length === 1);
    expect(notices(a)[0].closesIn).toBeGreaterThan(30);
    expect(notices(a)[0].closesIn).toBeLessThanOrEqual(120);
    // Moving is activity: the warning is taken back.
    move(a, 1);
    await settle();
    await waitFor(() => notices(a).length === 2);
    expect(notices(a)[1].closesIn).toBeNull();
    expect(Date.now() - roomOf(code).activeAt).toBeLessThan(5000);
    // Idle again past the limit: closed, everyone told, the room disposed once empty, its code no longer answers.
    idleFor(code, 19.6 * MIN);
    server!.sweep();
    await waitFor(() => notices(a).length === 3);
    expect(notices(a)[2].closesIn).toBeLessThanOrEqual(30);
    idleFor(code, 21 * MIN);
    server!.sweep();
    await waitFor(() => !!a.closed);
    expect(a.closed).toEqual({ code: 4009, reason: 'room closed: inactive' });
    expect((await join(base, code, '198.51.100.3')).closed?.code).toBeGreaterThanOrEqual(4004);
    await waitFor(() => server!.stats.clients === 0);
    server!.sweep();
    expect(server!.rooms.get(code)).toBeNull();
    expect(lines.some((l) => l.includes(`room ${code} closed (inactive)`))).toBe(true);
    // Its maker's place is free again.
    expect((await create(base, '203.0.113.50')).welcome).toBeDefined();
  });

  it('fake activity does not keep a room: pings, the same input resent, listings and challenges', async () => {
    const base = await start({ roomIdleMs: 20 * MIN });
    const a = await create(base, '203.0.113.51');
    const code = a.welcome!.room!.id;
    move(a, 0.5);
    await settle();
    idleFor(code, 21 * MIN);
    for (let i = 0; i < 5; i++) {
      a.send({ t: 'ping', id: i, ct: 0 });
      a.send({ t: 'input', seq: ++seq, intent: { x: 0.5, z: 0, run: false } });
      a.send({ t: 'rooms' });
      a.send({ t: 'challenge' });
      a.send({ t: 'bogus' });
    }
    await settle();
    await waitFor(() => !!a.closed);
    expect(a.closed?.code).toBe(4009);
  });

  it('a social session is kept: people walking and changing their look, a press, a lobby request, someone arriving', async () => {
    const base = await start({ roomIdleMs: 20 * MIN });
    const a = await create(base, '203.0.113.52');
    const code = a.welcome!.room!.id;
    const acts: ((c: Conn) => void | Promise<unknown>)[] = [
      (c) => move(c, Math.random() * 2 - 1, 0.3),
      (c) => c.send({ t: 'input', seq: ++seq, intent: { x: 0, z: 0, jump: true } }),
      (c) => c.send({ t: 'ready', ready: true }),
      async () => join(base, code, '198.51.100.52'),
    ];
    for (const act of acts) {
      await settle();
      idleFor(code, 21 * MIN);
      await act(a);
      await settle();
      expect(a.closed).toBeUndefined();
      expect(roomOf(code).expired).toBe(false);
    }
  });

  it('never while a match is on (countdown, play, results), however long nobody touches anything', async () => {
    const base = await start({ roomIdleMs: 20 * MIN });
    const a = await create(base, '203.0.113.53');
    const code = a.welcome!.room!.id;
    a.send({ t: 'start' });
    await waitFor(() => lobby(a)?.phase === 'countdown');
    for (let i = 0; i < 3; i++) {
      idleFor(code, 60 * MIN);
      server!.sweep();
    }
    expect(a.closed).toBeUndefined();
    expect(roomOf(code).expired).toBe(false);
    expect(notices(a)).toHaveLength(0);
  });

  it('the plaza and the open room are never closed for idleness; an empty room is left to its grace period', async () => {
    const base = await start({ roomIdleMs: 20 * MIN });
    const p = await open(`${base}/ws?room=PLAZA&caps=lobby,plaza`, '203.0.113.54');
    const o = await open(base, '203.0.113.55');
    for (const r of server!.rooms.all()) r.activeAt = 0;
    server!.sweep();
    await sleep(50);
    expect(p.closed).toBeUndefined();
    expect(o.closed).toBeUndefined();
    expect(server!.rooms.size).toBe(2);
  });

  it('0 turns idle closing off', async () => {
    const base = await start({ roomIdleMs: 0 });
    const a = await create(base, '203.0.113.56');
    idleFor(a.welcome!.room!.id, 1000 * MIN);
    server!.sweep();
    await sleep(50);
    expect(a.closed).toBeUndefined();
  });
});

describe('ownership (L4.5A review)', () => {
  it('the owner leaving hands the room to who is left (it stays); only the owner starts or changes settings; no message claims ownership', async () => {
    const base = await start();
    const owner = await create(base, '203.0.113.60');
    const code = owner.welcome!.room!.id;
    const guest = await join(base, code, '198.51.100.60');
    await waitFor(() => lobby(guest)?.youOwn === false && lobby(owner)?.youOwn === true);
    // Forged: a non-owner asking to start or change settings, or naming itself owner, is refused or ignored.
    guest.send({ t: 'start' });
    guest.send({ t: 'settings', bots: false });
    guest.send({ t: 'owner', owner: true });
    await waitFor(() => guest.messages.filter((m) => m.t === 'refused').length === 2);
    expect(guest.messages.filter((m) => m.t === 'refused').map((m) => (m as { reason: string }).reason)).toEqual(['not-owner', 'not-owner']);
    await leave(owner);
    await waitFor(() => lobby(guest)?.youOwn === true);
    expect(server!.rooms.get(code)).not.toBeNull();
    // (one settings request per connection per half second: wait out the forged one's)
    await sleep(SERVER_LIMITS.lobbyEveryMs.settings + 50);
    guest.send({ t: 'settings', bots: false });
    await waitFor(() => lobby(guest)?.settings.bots === false);
  });
});

describe('bounded bookkeeping (L4.5A)', () => {
  it('a per-minute limiter never remembers more than its bound, whatever the number of networks', () => {
    const l = windowLimiter(5, 100);
    for (let i = 0; i < 5000; i++) l.allow(`net-${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
    // The newest are the ones kept, and still limited.
    for (let i = 0; i < 5; i++) l.allow('net-4999');
    expect(l.full('net-4999')).toBe(true);
  });

  it('a burst of refusals is logged in a bounded number of lines, the rest summed up', async () => {
    const base = await start({ roomsPerMinute: 1, roomsPerAddress: 1 });
    await create(base, '203.0.113.70');
    for (let i = 0; i < 40; i++) await create(base, '203.0.113.70');
    const refusals = lines.filter((l) => l.startsWith('refused'));
    expect(refusals.length).toBe(SERVER_LIMITS.refusalLogsPer10s);
    expect(server!.limiterSizes().creations).toBe(1);
  });
});
