/**
 * M11A over the host and the socket: the arena a room is made with, said
 * in the welcome (for late joiners and spectators too) and in every state;
 * the classic island when nothing is chosen or the choice is unknown; a
 * rotation to another arena with each new match, deterministic in its
 * number; and the public listing naming each room's arena.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLASSIC, FACTORY, SKYFALL, nextArena } from '../arena/arenas';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { ROUND } from '../tuning';
import { NET, RumbleHost } from './host';
import type { RoomsMessage, ServerMessage, WelcomeMessage } from './protocol';
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
  messages: ServerMessage[];
  send: (m: unknown) => void;
}
const open = (url: string) =>
  new Promise<Conn>((resolve) => {
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
    ws.on('close', () => resolve(c));
    ws.on('error', () => {});
  });
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};


describe('the host’s arena (M11A)', () => {
  const ticks = (h: RumbleHost, seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * h.tickHz); i++) h.tick();
  };
  /** Play the match to its end: the connected player falls every round, so the bot wins. */
  const loseMatch = (h: RumbleHost) => {
    for (let r = 0; r < ROUND.target; r++) {
      const s = h.state().snapshot;
      const pos = s.fighters[0].position;
      h.match.debugPlace('a', { x: pos.x, y: h.match.arena.fallY + 0.5, z: pos.z });
      ticks(h, 1 + ROUND.resetDelay + 0.3);
    }
    expect(h.state().snapshot.phase).toBe('matchOver');
  };

  it('plays the classic island unless told, says its arena in the welcome and in every state, and never rotates by itself', () => {
    const h = new RumbleHost({ havok, players: ['a', 'b'] });
    expect(h.connect(1)).toMatchObject({ arena: { id: CLASSIC.id, rotate: false } });
    expect(h.state().snapshot.arena).toBe(CLASSIC.id);
    loseMatch(h);
    ticks(h, NET.nextMatchDelay + 0.2);
    expect(h.state().snapshot.phase).toBe('playing');
    expect(h.state().snapshot.arena).toBe(CLASSIC.id);
    h.dispose();
  });

  it('a chosen arena is the one played; a late joiner and a spectator are told the same arena the players see', () => {
    const h = new RumbleHost({ havok, players: ['a', 'b'] , arena: FACTORY });
    expect(h.connect(1).arena).toEqual({ id: FACTORY.id, rotate: false });
    ticks(h, 1);
    expect(h.connect(2).arena!.id).toBe(FACTORY.id);
    expect(h.connect(3).arena!.id).toBe(FACTORY.id);
    expect(h.slot(3)).toBeNull();
    expect(h.state().snapshot.arena).toBe(FACTORY.id);
    expect(h.state().snapshot.sweeper).not.toBeNull();
    h.dispose();
  });

  it('a rotating room moves to another arena with each new match, by its number, keeps everyone in it, and tells the next joiner the new arena', () => {
    const rolls = [0, 0.99, 0.5];
    let k = 0;
    const h = new RumbleHost({ havok, players: ['a', 'b'], arena: SKYFALL, rotate: true, random: () => rolls[k++ % rolls.length] });
    expect(h.connect(1).arena).toEqual({ id: SKYFALL.id, rotate: true });
    let current = SKYFALL;
    for (let m = 0; m < 3; m++) {
      loseMatch(h);
      expect(h.state().snapshot.arena).toBe(current.id);
      ticks(h, NET.nextMatchDelay + 0.2);
      const expected = nextArena(current.id, rolls[m]);
      const s = h.state().snapshot;
      expect(s.arena).toBe(expected.id);
      expect(s.phase).toBe('playing');
      expect(s.fighters.map((f) => f.score)).toEqual([0, 0]);
      expect(s.pieces).toHaveLength(expected.dynamics.length);
      expect(h.connect(10 + m).arena!.id).toBe(expected.id);
      h.disconnect(10 + m);
      current = expected;
    }
    expect(h.slot(1)).toBe('a');
    h.dispose();
  });
});

describe('the arena over the socket (M11A)', () => {
  it('a creation names its arena and rotation; a joiner is told them; an unknown arena is the classic island; the listing names arenas; nothing of the arena rides a snapshot but its id', async () => {
    server = await startRumbleServer({ havok, port: 0, manual: false });
    const base = `ws://127.0.0.1:${server.port}`;
    const host = await open(`${base}/?create=1&public=1&arena=${FACTORY.id}&rotate=1`);
    expect(host.welcome!.room).toMatchObject({ arena: FACTORY.id, rotate: true, listed: true });
    expect(host.welcome!.arena).toEqual({ id: FACTORY.id, rotate: true });
    const guest = await open(`${base}/?room=${host.welcome!.room!.id}`);
    expect(guest.welcome!.arena).toEqual({ id: FACTORY.id, rotate: true });
    await waitFor(() => guest.messages.some((m) => m.t === 'state'));
    const state = guest.messages.find((m) => m.t === 'state')!;
    expect(state.t === 'state' && state.snapshot.arena).toBe(FACTORY.id);
    expect(JSON.stringify(state)).not.toMatch(/platforms|halfWidth|conveyors/);
    const odd = await open(`${base}/?create=1&arena=moon-base`);
    expect(odd.welcome!.arena).toEqual({ id: CLASSIC.id, rotate: false });
    const plain = await open(`${base}/?create=1&arena=${SKYFALL.id}`);
    expect(plain.welcome!.arena).toEqual({ id: SKYFALL.id, rotate: false });
    const viewer = await open(base);
    viewer.send({ t: 'rooms' });
    await waitFor(() => viewer.messages.some((m) => m.t === 'rooms'));
    const rooms = viewer.messages.find((m): m is RoomsMessage => m.t === 'rooms')!;
    expect(rooms.rooms.find((r) => r.id === host.welcome!.room!.id)?.arena).toBe(FACTORY.id);
    expect(rooms.rooms.find((r) => r.id === 'OPEN')?.arena).toBe(CLASSIC.id);
  });
});

describe('banana peels over the host and the socket (M11F)', () => {
  const ticks = (h: RumbleHost, seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * h.tickHz); i++) h.tick();
  };

  it('a throw from a player still in the round, a spectator or a malformed message is nothing; an out player’s lands, and every state (a late joiner’s first too) carries it', () => {
    const h = new RumbleHost({ havok, players: ['a', 'b', 'c', 'd'] });
    h.connect(1);
    h.connect(2);
    expect(h.slot(2)).toBe('b');
    // Bots drive 'c' and 'd'; freeze them by connecting (idle) humans would change the test; instead 'a' is put out.
    expect(h.receive(1, JSON.stringify({ t: 'throw', x: 0, z: 0 }))).toBeNull();
    ticks(h, 0.1);
    expect(h.state().snapshot.bananas).toEqual([]);
    const pos = h.state().snapshot.fighters[0].position;
    h.match.debugPlace('a', { x: pos.x, y: h.match.arena.fallY + 0.5, z: pos.z });
    ticks(h, 1);
    const s0 = h.state().snapshot;
    expect(s0.fighters[0].eliminated).toBe(true);
    expect(s0.phase).toBe('playing');
    // Malformed, out of range, and from a spectator: ignored.
    expect(h.receive(1, JSON.stringify({ t: 'throw', x: 'a', z: 0 }))).toBeNull();
    expect(h.receive(1, JSON.stringify({ t: 'throw', x: 500, z: 0 }))).toBeNull();
    for (let c = 3; c <= 5; c++) h.connect(c);
    expect(h.slot(5)).toBeNull();
    expect(h.receive(5, JSON.stringify({ t: 'throw', x: 0, z: 0 }))).toBeNull();
    ticks(h, 0.1);
    expect(h.state().snapshot.bananas).toEqual([]);
    // The out player's throw lands; the same again at once is refused by the cooldown.
    h.receive(1, JSON.stringify({ t: 'throw', x: 1.25, z: -0.5 }));
    h.receive(1, JSON.stringify({ t: 'throw', x: 2, z: 0 }));
    h.tick();
    const s1 = h.state().snapshot;
    expect(s1.bananas).toHaveLength(1);
    expect(s1.bananas[0]).toMatchObject({ x: 1.25, z: -0.5, owner: 'a' });
    expect(s1.fighters[0].bananas.left).toBe(2);
    // A late joiner's first state is the same state.
    h.connect(6);
    expect(h.state().snapshot.bananas).toHaveLength(1);
    expect(JSON.stringify(h.state())).toContain('"bananas"');
    h.dispose();
  });

  it('over the socket: a throw message from an out player shows in the next states for everyone in the room', async () => {
    const started = await startRumbleServer({ havok, port: 0, manual: false });
    try {
      const base = `ws://127.0.0.1:${started.port}`;
      const a = await open(`${base}/?create=1`);
      const room = a.welcome!.room!.id;
      const b = await open(`${base}/?room=${room}`);
      expect(a.welcome!.you).toBe('P1');
      const hostOf = started.rooms.get(room)!.host;
      await waitFor(() => a.messages.some((m) => m.t === 'state'));
      const pos = hostOf.state().snapshot.fighters[0].position;
      hostOf.match.debugPlace('P1', { x: pos.x, y: hostOf.match.arena.fallY + 0.5, z: pos.z });
      await waitFor(() => a.messages.some((m) => m.t === 'state' && m.snapshot.fighters[0].eliminated && m.snapshot.phase === 'playing'));
      a.send({ t: 'throw', x: 0.5, z: 0.5 });
      await waitFor(() => b.messages.some((m) => m.t === 'state' && m.snapshot.bananas.length === 1));
      const seen = b.messages.find((m) => m.t === 'state' && m.snapshot.bananas.length === 1)!;
      expect(seen.t === 'state' && seen.snapshot.bananas[0]).toMatchObject({ x: 0.5, z: 0.5, owner: 'P1' });
    } finally {
      await started.close();
    }
  });
});
