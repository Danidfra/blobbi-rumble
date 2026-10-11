/**
 * Lobby rooms over real sockets (L1, L2): negotiated both ways. A client that
 * says `caps=lobby` makes lobby rooms and hears their lifecycle; one that
 * does not is refused a lobby room plainly ("update required", 1008, which
 * older pages show without retrying), still makes continuous rooms of its
 * own, and plays the OPEN room exactly as before.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { UPDATE_REQUIRED, type LobbyMessage, type RefusedMessage, type RosterMessage, type RoomsMessage, type ServerMessage, type WelcomeMessage } from './protocol';
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
const refusals = (c: Conn) => c.messages.filter((m): m is RefusedMessage => m.t === 'refused');
const lastRoster = (c: Conn) => [...c.messages].reverse().find((m): m is RosterMessage => m.t === 'roster');
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
    // L2: ready, then the next step starts the countdown; the change goes out at once and with the next broadcast.
    a.send({ t: 'ready', ready: true });
    await waitFor(() => lastLobby(a)?.ready.includes('P1') === true);
    server.rooms.get(a.welcome!.room!.id)!.host.tick();
    server.broadcast();
    await waitFor(() => lastLobby(a)?.phase === 'countdown');
    const b = await open(`${base}/?room=${a.welcome!.room!.id}&caps=lobby`);
    // L2: arriving during the countdown, it watches this match.
    expect(b.welcome!.you).toBeNull();
    await waitFor(() => !!lastLobby(b));
    expect(lastLobby(b)).toMatchObject({ phase: 'countdown', you: null });
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

describe('lobby requests over the socket (L2)', () => {
  it('the owner changes settings and starts; another person is refused; each person hears their own seat and ownership', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    const code = a.welcome!.room!.id;
    const b = await open(`${base}/?room=${code}&caps=lobby`);
    await waitFor(() => lastLobby(b)?.you === 'P2' && lastLobby(a)?.seated.length === 2);
    expect(lastLobby(a)).toMatchObject({ owner: 'P1', youOwn: true });
    expect(lastLobby(b)).toMatchObject({ owner: 'P1', youOwn: false });
    b.send({ t: 'settings', bots: false });
    await waitFor(() => refusals(b).length === 1);
    expect(refusals(b)[0]).toEqual({ t: 'refused', of: 'settings', reason: 'not-owner' });
    b.send({ t: 'start' });
    await waitFor(() => refusals(b).length === 2);
    expect(refusals(b)[1].reason).toBe('not-owner');
    a.send({ t: 'settings', bots: false });
    await waitFor(() => lastLobby(b)?.settings.bots === false);
    expect(lastRoster(b)!.slots).toMatchObject({ P3: { who: 'empty' }, P4: { who: 'empty' } });
    a.send({ t: 'start' });
    await waitFor(() => lastLobby(b)?.phase === 'countdown');
    expect(server.rooms.get(code)!.host.lobby!.forced).toBe(true);
    // Settings are refused once the countdown has begun.
    await new Promise((r) => setTimeout(r, 550));
    a.send({ t: 'settings', bots: true });
    await waitFor(() => refusals(a).length === 1);
    expect(refusals(a)[0]).toEqual({ t: 'refused', of: 'settings', reason: 'phase' });
  });

  it('rate-limits each kind of request per connection ("busy"), and a flood changes the room at most once per interval', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true, lobbyEveryMs: { ready: 200, settings: 200, start: 200 } });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    const host = server.rooms.get(a.welcome!.room!.id)!.host;
    for (let i = 0; i < 20; i++) a.send({ t: 'ready', ready: i % 2 === 0 });
    await waitFor(() => refusals(a).length === 19);
    expect(refusals(a).every((r) => r.reason === 'busy' && r.of === 'ready')).toBe(true);
    expect(host.lobbyFor(0)).toBeTruthy();
    expect(host.lobby!.ready.size).toBe(1);
    // Another kind has its own allowance.
    a.send({ t: 'settings', rotate: true });
    await waitFor(() => host.settings.rotate);
    await new Promise((r) => setTimeout(r, 220));
    a.send({ t: 'ready', ready: false });
    await waitFor(() => host.lobby!.ready.size === 0);
  });

  it('malformed requests are ignored like any other malformed message; requests in the OPEN room are refused as having no lobby', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    const host = server.rooms.get(a.welcome!.room!.id)!.host;
    const before = server.stats.malformed;
    a.send({ t: 'ready', ready: 'yes' });
    a.send({ t: 'settings', bots: 1 });
    a.send({ t: 'settings', arena: 'x'.repeat(65) });
    await waitFor(() => server!.stats.malformed === before + 3);
    a.send({ t: 'settings', arena: 'nowhere' });
    await waitFor(() => refusals(a).length === 1);
    expect(refusals(a)[0].reason).toBe('malformed');
    expect(host.settings).toMatchObject({ bots: true, rotate: false });
    const open1 = await open(`${base}/?caps=lobby`);
    open1.send({ t: 'ready', ready: true });
    await waitFor(() => refusals(open1).length === 1);
    expect(refusals(open1)[0]).toEqual({ t: 'refused', of: 'ready', reason: 'no-lobby' });
  });

  it('a watcher is seated, with the roster telling everyone, when a seat frees up in the lobby; ownership passes when the owner leaves', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: true });
    const base = `ws://127.0.0.1:${server.port}`;
    const a = await open(`${base}/?create=1&caps=lobby`);
    const code = a.welcome!.room!.id;
    const others: Conn[] = [];
    for (let i = 0; i < 4; i++) others.push(await open(`${base}/?room=${code}&caps=lobby`));
    const watcher = others[3];
    expect(watcher.welcome!.you).toBeNull();
    a.ws.close();
    await waitFor(() => lastLobby(watcher)?.you === 'P1');
    await waitFor(() => (lastRoster(others[0])!.slots.P1 as { who: string }).who === 'guest');
    expect(lastLobby(others[0])).toMatchObject({ owner: 'P2', youOwn: true });
  });
});
