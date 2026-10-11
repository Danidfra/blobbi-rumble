/**
 * Lobby rooms over real sockets (L1): negotiated both ways. A client that
 * says `caps=lobby` makes lobby rooms and hears their lifecycle; one that
 * does not is refused a lobby room plainly ("update required", 1008, which
 * older pages show without retrying), still makes continuous rooms of its
 * own, and plays the OPEN room exactly as before.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { UPDATE_REQUIRED, type LobbyMessage, type RoomsMessage, type ServerMessage, type WelcomeMessage } from './protocol';
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
  welcome?: WelcomeMessage;
  closed?: { code: number; reason: string };
  messages: ServerMessage[];
  send: (m: unknown) => void;
}
function open(url: string): Promise<Conn> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const c: Conn = { ws, messages: [], send: (m) => ws.send(JSON.stringify(m)) };
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
const lastLobby = (c: Conn) => [...c.messages].reverse().find((m): m is LobbyMessage => m.t === 'lobby');

describe('lobby rooms over the socket (L1)', () => {
  it('a lobby-speaking client makes a lobby room, is told so, and hears its lifecycle; the server lists the feature', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    expect(a.welcome!.features).toContain('lobby');
    expect(a.welcome!.room).toMatchObject({ kind: 'private', lifecycle: 'lobby' });
    await waitFor(() => !!lastLobby(a));
    expect(lastLobby(a)).toMatchObject({ phase: 'lobby', you: 'P1', canStart: true, need: 1 });
    // The next step starts the countdown; the change goes out with the next broadcast.
    server.rooms.get(a.welcome!.room!.id)!.host.tick();
    server.broadcast();
    await waitFor(() => lastLobby(a)?.phase === 'countdown');
    const b = await open(`${base}/?room=${a.welcome!.room!.id}&caps=lobby`);
    expect(b.welcome!.you).toBe('P2');
    await waitFor(() => lastLobby(b)?.you === 'P2');
  });

  it('a client that does not speak the lobby is refused a lobby room, plainly, before it takes a place', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    const old = await open(`${base}/?room=${a.welcome!.room!.id}`);
    expect(old.welcome).toBeUndefined();
    expect(old.closed).toEqual({ code: 1008, reason: UPDATE_REQUIRED });
    expect(server.rooms.get(a.welcome!.room!.id)!.connections.size).toBe(1);
  });

  it('an older client still makes a continuous room of its own, and plays the OPEN room as before (no lobby, no lifecycle)', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const mine = await open(`${base}/?create=1`);
    expect(mine.welcome!.room!.lifecycle).toBeUndefined();
    expect(server.rooms.get(mine.welcome!.room!.id)!.host.lobby).toBeNull();
    const plain = await open(base);
    expect(plain.welcome!.room!.lifecycle).toBeUndefined();
    // A lobby-speaking client in a continuous room hears no lobby either.
    const modern = await open(`${base}/?caps=lobby`);
    expect(modern.welcome!.room!.id).toBe('OPEN');
    server.broadcast();
    await waitFor(() => modern.messages.some((m) => m.t === 'state'));
    expect([...plain.messages, ...mine.messages, ...modern.messages].some((m) => m.t === 'lobby')).toBe(false);
  });

  it('the listing gives a lobby room’s stage as its phase', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&public=1&caps=lobby`);
    a.send({ t: 'rooms' });
    await waitFor(() => a.messages.some((m) => m.t === 'rooms'));
    const rooms = (a.messages.find((m) => m.t === 'rooms') as RoomsMessage).rooms;
    expect(rooms.find((r) => r.id === a.welcome!.room!.id)).toMatchObject({ lifecycle: 'lobby', phase: 'lobby' });
    expect(rooms.find((r) => r.id === 'OPEN')!.lifecycle).toBeUndefined();
  });
});
