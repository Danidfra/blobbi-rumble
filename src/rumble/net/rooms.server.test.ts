/**
 * Rooms over real sockets (M8B): create, join, missing and malformed
 * codes, capacity and spectators, the open room for old clients, room
 * isolation (inputs, states, scores, rosters and identities), the grace
 * period, destruction, creation limits, the duplicate-pubkey policy, and
 * the share link from the server's public address.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { inputMessage, type RoomsMessage, type RosterMessage, type ServerMessage, type StateMessage, type WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer } from './server';

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
function open(url: string): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
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
const roster = (c: Conn) => [...c.messages].reverse().find((m): m is RosterMessage => m.t === 'roster');
const states = (c: Conn) => c.messages.filter((m): m is StateMessage => m.t === 'state');
async function prove(c: Conn, sk: Uint8Array) {
  const at = c.messages.length;
  c.send({ t: 'challenge' });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'challenge'));
  const ch = c.messages.slice(at).find((m) => m.t === 'challenge') as { challenge: string };
  c.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(c.url.replace(/\?.*$/, ''), ch.challenge), sk) });
  await waitFor(() => c.messages.slice(at).some((m) => m.t === 'auth'));
}

describe('rooms over the socket', () => {
  it('a plain connection plays the open room, as before; create makes a private room; join enters it', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const plain = await open(base);
    expect(plain.welcome!.room).toEqual({ id: 'OPEN', kind: 'open', mode: 'casual', listed: true });
    expect(plain.welcome!.you).toBe('P1');
    const host = await open(`${base}/?create=1`);
    const id = host.welcome!.room!.id;
    expect(id).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
    expect(host.welcome!.room!.kind).toBe('private');
    expect(host.welcome!.you).toBe('P1');
    expect(host.welcome!.room!.url).toBeUndefined();
    const guest = await open(`${base}/?room=${id.toLowerCase()}`);
    expect(guest.welcome!.room!.id).toBe(id);
    expect(guest.welcome!.you).toBe('P2');
    expect(server.rooms.size).toBe(2);
  });

  it('a missing or malformed room is refused with 4004; nothing is created', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    for (const q of ['ZZZZ', 'not-a-room', '%00', 'A0F2', '']) {
      const c = await open(`${base}/?room=${q}`);
      expect(c.closed, q).toEqual({ code: 4004, reason: 'no such room' });
    }
    expect(server.rooms.size).toBe(1);
  });

  it('room capacity: four play, the rest watch, then the room is full; the open room is unaffected', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, perRoom: 5 });
    const base = `ws://127.0.0.1:${server.port}`;
    const first = await open(`${base}/?create=1`);
    const url = `${base}/?room=${first.welcome!.room!.id}`;
    const more = [await open(url), await open(url), await open(url)];
    expect(more.map((c) => c.welcome!.you)).toEqual(['P2', 'P3', 'P4']);
    const watcher = await open(url);
    expect(watcher.welcome!.you).toBeNull();
    await waitFor(() => roster(watcher)?.spectators === 1);
    const refused = await open(url);
    expect(refused.closed).toEqual({ code: 1013, reason: 'room full' });
    expect((await open(base)).welcome!.you).toBe('P1');
  });

  it('rooms are isolated: inputs, states, scores, rosters and identities stay in their room', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0 });
    const base = `ws://127.0.0.1:${server.port}`;
    const a1 = await open(`${base}/?create=1`);
    const roomA = server.rooms.get(a1.welcome!.room!.id)!;
    const a2 = await open(`${base}/?room=${roomA.id}`);
    const b1 = await open(`${base}/?create=1`);
    const roomB = server.rooms.get(b1.welcome!.room!.id)!;
    const b2 = await open(`${base}/?room=${roomB.id}`);
    expect(roomA.id).not.toBe(roomB.id);
    // An identity in A shows in A's roster only.
    const sk = generateSecretKey();
    await prove(a1, sk);
    await waitFor(() => roster(a2)?.slots.P1.who === 'nostr');
    expect(roster(b2)!.slots.P1).toEqual({ who: 'guest' });
    expect(roomB.host.roster().slots.P1).toEqual({ who: 'guest' });
    // A's P1 runs; B's P1 does not move. Only A's P1 input is acknowledged, in A only.
    a1.send(inputMessage(1, { x: 1, z: 0, run: true }, { jump: false, punch: false, grab: false }));
    await new Promise((r) => setTimeout(r, 30));
    const startA = roomA.host.latest.fighters[0].position;
    const startB = roomB.host.latest.fighters[0].position;
    for (let i = 0; i < 30; i++) {
      roomA.host.tick();
      roomB.host.tick();
    }
    server.broadcast();
    await waitFor(() => states(a2).length > 0 && states(b2).length > 0);
    const movedA = Math.hypot(roomA.host.latest.fighters[0].position.x - startA.x, roomA.host.latest.fighters[0].position.z - startA.z);
    const movedB = Math.hypot(roomB.host.latest.fighters[0].position.x - startB.x, roomB.host.latest.fighters[0].position.z - startB.z);
    expect(movedA).toBeGreaterThan(0.3);
    expect(movedB).toBeLessThan(0.05);
    expect(states(a2).at(-1)!.acks.P1).toBe(1);
    expect(states(b2).at(-1)!.acks.P1).toBe(-1);
    // Each room's clients get their own room's state (same tick count here, different bodies).
    expect(states(a2).at(-1)!.snapshot.fighters[0].position).toEqual(roomA.host.latest.fighters[0].position);
    expect(states(b2).at(-1)!.snapshot.fighters[0].position).toEqual(roomB.host.latest.fighters[0].position);
    // Scores, rounds, bots: A plays on alone (its bots fight) until a round is decided; B does not move a tick.
    const bTick = roomB.host.latest.tick;
    for (let i = 0; i < 40_000 && roomA.host.latest.fighters.every((f) => f.score === 0); i++) roomA.host.tick();
    expect(roomA.host.latest.fighters.some((f) => f.score > 0)).toBe(true);
    expect(roomB.host.latest.fighters.every((f) => f.score === 0)).toBe(true);
    expect(roomB.host.latest.round).toBe(1);
    expect(roomB.host.latest.tick).toBe(bTick);
  });

  it('an empty private room survives its grace period for a reconnect, then is closed and freed', async () => {
    const lines: string[] = [];
    server = await startRumbleServer({ havok, port: 0, manual: true, roomGraceMs: 150, log: (l) => lines.push(l) });
    const base = `ws://127.0.0.1:${server.port}`;
    const c = await open(`${base}/?create=1`);
    const id = c.welcome!.room!.id;
    const room = server.rooms.get(id)!;
    c.ws.terminate();
    await waitFor(() => room.connections.size === 0);
    server.sweep();
    expect(server.rooms.get(id)).toBe(room);
    // Back within the grace period: the same room (a new connection, a free slot).
    const back = await open(`${base}/?room=${id}`);
    expect(back.welcome!.room!.id).toBe(id);
    back.ws.terminate();
    await waitFor(() => room.connections.size === 0);
    await new Promise((r) => setTimeout(r, 200));
    server.sweep();
    expect(server.rooms.get(id)).toBeNull();
    expect(lines.some((l) => l.includes(`room ${id} closed`))).toBe(true);
    expect((await open(`${base}/?room=${id}`)).closed?.code).toBe(4004);
    expect(server.rooms.size).toBe(1);
  });

  it('room creation is bounded: per address per minute, and in total', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, roomsPerMinute: 2 });
    const base = `ws://127.0.0.1:${server.port}`;
    expect((await open(`${base}/?create=1`)).welcome).toBeTruthy();
    expect((await open(`${base}/?create=1`)).welcome).toBeTruthy();
    expect((await open(`${base}/?create=1`)).closed).toEqual({ code: 4003, reason: 'too many new rooms, wait a minute' });
    await server.close();
    server = await startRumbleServer({ havok, port: 0, manual: true, maxRooms: 2 });
    const b2 = `ws://127.0.0.1:${server.port}`;
    expect((await open(`${b2}/?create=1`)).welcome).toBeTruthy();
    expect((await open(`${b2}/?create=1`)).closed).toEqual({ code: 4003, reason: 'room limit reached' });
  });

  it('the same pubkey twice: two separate connections, two slots, nothing merged or taken over', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, challengeEveryMs: 0 });
    const base = `ws://127.0.0.1:${server.port}`;
    const sk = generateSecretKey();
    const one = await open(base);
    const two = await open(base);
    await prove(one, sk);
    await prove(two, sk);
    await waitFor(() => roster(one)?.slots.P2.who === 'nostr');
    expect(roster(one)!.slots.P1).toEqual({ who: 'nostr', pubkey: getPublicKey(sk) });
    expect(roster(one)!.slots.P2).toEqual({ who: 'nostr', pubkey: getPublicKey(sk) });
    two.ws.terminate();
    await waitFor(() => roster(one)?.slots.P2.who === 'bot');
    expect(roster(one)!.slots.P1.who).toBe('nostr');
  });

  it('with a public address, the welcome carries the canonical share link and the server’s claims', async () => {
    const operator = getPublicKey(generateSecretKey());
    server = await startRumbleServer({ havok, port: 0, manual: true, identity: { name: 'Garden', operator, public: { origin: 'https://rumble.example', websocket: 'wss://rumble.example/ws' } } });
    const base = `ws://127.0.0.1:${server.port}`;
    const c = await open(`${base}/?create=1`);
    expect(c.welcome!.room!.url).toBe(`https://rumble.example/play/${c.welcome!.room!.id}`);
    expect(c.welcome!.server).toEqual({ name: 'Garden', operator, url: 'https://rumble.example' });
    expect(c.welcome!.features).toEqual(['nostr-auth', 'rooms', 'looks', 'rooms-list']);
    expect((await open(base)).welcome!.room!.url).toBe('https://rumble.example/');
  });
});

describe('public rooms over the socket (M10)', () => {
  const roomsMsg = (c: Conn) => [...c.messages].reverse().find((m): m is RoomsMessage => m.t === 'rooms');

  it('the welcome says the protocol and lists rooms; a public creation is listed, a private one is not; the listing is rate-limited', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const pub = await open(`${base}/?create=1&public=1`);
    const priv = await open(`${base}/?create=1`);
    expect(pub.welcome!.protocol).toBe(1);
    expect(pub.welcome!.features).toContain('rooms-list');
    expect(pub.welcome!.room).toMatchObject({ kind: 'private', listed: true });
    expect(priv.welcome!.room).toMatchObject({ kind: 'private', listed: false });
    const viewer = await open(base);
    viewer.send({ t: 'rooms' });
    await waitFor(() => !!roomsMsg(viewer));
    const rooms = roomsMsg(viewer)!;
    expect(rooms.rooms.map((r) => r.id).sort()).toEqual(['OPEN', pub.welcome!.room!.id].sort());
    expect(JSON.stringify(rooms)).not.toContain(priv.welcome!.room!.id);
    expect(rooms.rooms.find((r) => r.id === pub.welcome!.room!.id)).toMatchObject({ players: 1, joinable: true });
    expect(rooms.rooms.find((r) => r.id === 'OPEN')).toMatchObject({ players: 1 });
    // Asked again at once: ignored (the protocol's minimum interval).
    const n = viewer.messages.filter((m) => m.t === 'rooms').length;
    viewer.send({ t: 'rooms' });
    viewer.send({ t: 'rooms' });
    await new Promise((r) => setTimeout(r, 30));
    expect(viewer.messages.filter((m) => m.t === 'rooms')).toHaveLength(n);
    // The private room is still joinable by its code, as before.
    const guest = await open(`${base}/?room=${priv.welcome!.room!.id}`);
    expect(guest.welcome!.room!.id).toBe(priv.welcome!.room!.id);
  });

  it('with allowed origins, a browser from elsewhere is refused with 4005 before it takes anything; a listed origin and a non-browser get in', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, allowedOrigins: ['https://rumble.example'] });
    const base = `ws://127.0.0.1:${server.port}`;
    const refused = await new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(base, { headers: { origin: 'https://evil.example' } });
      sockets.push(ws);
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(refused).toEqual({ code: 4005, reason: 'origin not allowed' });
    expect(server.stats.refused).toBe(1);
    const ok = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(base, { headers: { origin: 'https://rumble.example/' } });
      sockets.push(ws);
      ws.on('message', () => resolve(true));
      ws.on('close', () => resolve(false));
    });
    expect(ok).toBe(true);
    const bot = await open(base);
    expect(bot.welcome).toBeDefined();
  });
});
