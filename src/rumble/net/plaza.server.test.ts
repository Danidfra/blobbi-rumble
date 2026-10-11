/**
 * The public plaza over real sockets (L4.1): there from the start, joined
 * by `room=PLAZA` with `caps=plaza` (guests and proven Nostr identities
 * alike), refused to clients that do not speak it, listed only to those
 * that do; eight people at most, the ninth refused "plaza full" (never put
 * in a match); leaving it (for a private room, Quick Match, or nothing)
 * frees the seat at once; the OPEN room and private rooms are unchanged.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { UPDATE_REQUIRED, type RoomsMessage, type RosterMessage, type ServerMessage, type StateMessage, type WelcomeMessage } from './protocol';
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
const lastRoster = (c: Conn) => [...c.messages].reverse().find((m): m is RosterMessage => m.t === 'roster');
const lastState = (c: Conn) => [...c.messages].reverse().find((m): m is StateMessage => m.t === 'state');
const closeAndWait = async (c: Conn) => {
  c.ws.close();
  await waitFor(() => !!c.closed);
};

describe('the public plaza over the socket (L4.1)', () => {
  it('is there from the start; a guest joins it by room=PLAZA with caps=plaza, sees the plaza and no lobby', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    expect(server.rooms.plaza.kind).toBe('plaza');
    const base = `ws://127.0.0.1:${server.port}`;
    const g = await open(`${base}/?room=PLAZA&caps=lobby,plaza`);
    expect(g.welcome!.room).toMatchObject({ id: 'PLAZA', kind: 'plaza' });
    expect(g.welcome!.you).toBe('P1');
    expect(g.welcome!.features).toContain('plaza');
    server.broadcast();
    await waitFor(() => !!lastState(g));
    expect(lastState(g)!.snapshot.arena).toBe('blobbi-plaza');
    expect(g.messages.some((m) => m.t === 'lobby')).toBe(false);
    // Lower case and dashes, as a person might type it.
    expect((await open(`${base}/?room=pla-za&caps=plaza`)).welcome!.room!.id).toBe('PLAZA');
  });

  it('a proven Nostr identity is vouched for in the roster there, as anywhere', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}/?room=PLAZA&caps=plaza`;
    const c = await open(url);
    const sk = generateSecretKey();
    const at = c.messages.length;
    c.send({ t: 'challenge' });
    await waitFor(() => c.messages.slice(at).some((m) => m.t === 'challenge'));
    const ch = c.messages.slice(at).find((m) => m.t === 'challenge') as { challenge: string };
    c.send({ t: 'auth', event: finalizeEvent(makeAuthEvent(c.url.replace(/\?.*$/, ''), ch.challenge), sk) });
    await waitFor(() => (lastRoster(c)?.slots.P1 as { who: string } | undefined)?.who === 'nostr');
    expect(lastRoster(c)!.slots.P1).toEqual({ who: 'nostr', pubkey: getPublicKey(sk) });
    // The empty seats are empty, never bots; the ambient bots are not in the roster at all.
    expect(lastRoster(c)!.slots.P2).toEqual({ who: 'empty' });
    expect(Object.keys(lastRoster(c)!.slots)).not.toContain('B1');
  });

  it('a client that does not speak the plaza is refused it plainly, and never sees it listed', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const old = await open(`${base}/?room=PLAZA&caps=lobby`);
    expect(old.closed).toEqual({ code: 1008, reason: UPDATE_REQUIRED });
    const viewer = await open(`${base}/?caps=lobby`);
    viewer.send({ t: 'rooms' });
    await waitFor(() => viewer.messages.some((m) => m.t === 'rooms'));
    expect((viewer.messages.find((m) => m.t === 'rooms') as RoomsMessage).rooms.map((r) => r.id)).not.toContain('PLAZA');
    const modern = await open(`${base}/?caps=lobby,plaza`);
    modern.send({ t: 'rooms' });
    await waitFor(() => modern.messages.some((m) => m.t === 'rooms'));
    const row = (modern.messages.find((m) => m.t === 'rooms') as RoomsMessage).rooms[0];
    expect(row).toMatchObject({ id: 'PLAZA', kind: 'plaza', phase: 'plaza', players: 0, maxPlayers: 8, joinable: true });
  });

  it('eight people at most: the ninth is refused "plaza full", put nowhere else; a seat freed lets the next one in', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const url = `ws://127.0.0.1:${server.port}/?room=PLAZA&caps=plaza`;
    const eight: Conn[] = [];
    for (let i = 0; i < 8; i++) eight.push(await open(url));
    expect(eight.map((c) => c.welcome!.you)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    const ninth = await open(url);
    expect(ninth.welcome).toBeUndefined();
    expect(ninth.closed).toEqual({ code: 1013, reason: 'plaza full' });
    expect(server.rooms.open.connections.size).toBe(0);
    await closeAndWait(eight[3]);
    await waitFor(() => server!.rooms.plaza.connections.size === 7);
    expect((await open(url)).welcome!.you).toBe('P4');
  });

  it('leaving the plaza for a private room, for Quick Match, or for nothing frees the seat at once; one room per connection', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const p = await open(`${base}/?room=PLAZA&caps=lobby,plaza`);
    expect(server.rooms.plaza.connections.size).toBe(1);
    // To a new private room (the page closes the plaza socket and opens the room's).
    await closeAndWait(p);
    const room = await open(`${base}/?create=1&caps=lobby,plaza`);
    await waitFor(() => server!.rooms.plaza.connections.size === 0);
    expect(room.welcome!.room).toMatchObject({ kind: 'private', lifecycle: 'lobby' });
    // Back, then to Quick Match: the OPEN room as ever (continuous, bots in the empty seats).
    await closeAndWait(room);
    const again = await open(`${base}/?room=PLAZA&caps=lobby,plaza`);
    await closeAndWait(again);
    const quick = await open(`${base}/?room=OPEN&caps=lobby,plaza`);
    expect(quick.welcome!.room).toMatchObject({ id: 'OPEN', kind: 'open' });
    expect(quick.welcome!.room!.lifecycle).toBeUndefined();
    await waitFor(() => server!.rooms.plaza.connections.size === 0);
    server.broadcast();
    await waitFor(() => !!lastState(quick));
    expect(lastState(quick)!.control).toEqual({ P1: 'human', P2: 'bot', P3: 'bot', P4: 'bot' });
    expect(lastState(quick)!.snapshot.arena).toBe('floating-islands-classic');
  });

  it('rapid switching and interrupted joins leave no seat behind', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    for (let i = 0; i < 6; i++) {
      // A join abandoned before its welcome, then another.
      const ws = new WebSocket(`${base}/?room=PLAZA&caps=plaza`);
      sockets.push(ws);
      ws.on('error', () => {});
      ws.on('open', () => ws.terminate());
      const c = await open(`${base}/?room=${i % 2 ? 'OPEN' : 'PLAZA'}&caps=lobby,plaza`);
      await closeAndWait(c);
    }
    await waitFor(() => server!.rooms.plaza.connections.size === 0 && server!.rooms.open.connections.size === 0);
    expect(server.stats.clients).toBe(0);
  });
});
