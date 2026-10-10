/**
 * Rooms (M8B): short server-made codes; one authoritative host per room,
 * nothing shared; limits; the open room always there; private rooms kept
 * through a grace period and then disposed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { OPEN_ROOM, ROOM_ALPHABET, newRoomId, normalizeRoomId } from './roomId';
import { RoomManager } from './rooms';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

describe('room ids', () => {
  it('are four unambiguous characters, made by the server, unique among live rooms', () => {
    expect(ROOM_ALPHABET).not.toMatch(/[01OIL]/);
    const ids = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const id = newRoomId((x) => ids.has(x));
      expect(id).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    // A taken code is never handed out again; a hopeless generator says so instead of looping.
    let n = 0;
    expect(newRoomId((x) => x === '2222', () => (n++ < 4 ? 0 : 1))).toBe('3333');
    expect(() => newRoomId(() => true)).toThrow();
  });

  it('read forgivingly (case, spaces, dashes) and strictly (alphabet, length)', () => {
    expect(normalizeRoomId('a7f2')).toBe('A7F2');
    expect(normalizeRoomId(' a7-f2 ')).toBe('A7F2');
    expect(normalizeRoomId('open')).toBe(OPEN_ROOM);
    for (const bad of ['A7F', 'A7F22', 'A0F2', 'AIF2', 'A7F!', '../x', '', 'x'.repeat(40), null, 42, {}]) expect(normalizeRoomId(bad)).toBeNull();
  });
});

describe('the room manager', () => {
  it('always has the open room; creates private rooms up to the limit, each with its own match', () => {
    const m = new RoomManager({ havok, maxRooms: 3 });
    expect(m.open.id).toBe(OPEN_ROOM);
    const a = m.create()!;
    const b = m.create()!;
    expect(m.create()).toBeNull();
    expect(a.kind).toBe('private');
    expect(a.mode).toBe('casual');
    expect(a.host).not.toBe(b.host);
    expect(a.host.match).not.toBe(m.open.host.match);
    expect(m.get(a.id.toLowerCase())).toBe(a);
    expect(m.get('ZZZZ')).toBeNull();
    expect(m.get('nonsense')).toBeNull();
    m.dispose();
  });

  it('keeps an empty private room for the grace period, then disposes of it; never the open room', () => {
    let t = 0;
    const m = new RoomManager({ havok, graceMs: 1000, now: () => t });
    const a = m.create()!;
    m.enter(a, 1);
    m.enter(m.open, 2);
    m.leave(m.open, 2);
    m.leave(a, 1);
    t = 500;
    expect(m.reap()).toEqual([]);
    // Someone comes back within the grace period: kept.
    m.enter(a, 3);
    t = 5000;
    expect(m.reap()).toEqual([]);
    m.leave(a, 3);
    t = 5500;
    expect(m.reap()).toEqual([]);
    t = 6100;
    expect(m.reap()).toEqual([a.id]);
    expect(m.get(a.id)).toBeNull();
    expect(m.get(OPEN_ROOM)).toBe(m.open);
    // A room made and never entered goes too.
    const b = m.create()!;
    t = 8000;
    expect(m.reap()).toEqual([b.id]);
    m.dispose();
  });

  it('counts connections against the per-room limit', () => {
    const m = new RoomManager({ havok, perRoom: 2 });
    const a = m.create()!;
    m.enter(a, 1);
    expect(m.hasRoom(a)).toBe(true);
    m.enter(a, 2);
    expect(m.hasRoom(a)).toBe(false);
    m.leave(a, 1);
    expect(m.hasRoom(a)).toBe(true);
    m.dispose();
  });
});

describe('the public listing (M10B)', () => {
  it('the open room and listed code rooms, counts only, busiest first, bounded; unlisted rooms never appear', () => {
    const m = new RoomManager({ havok, maxRooms: 6 });
    const pub = m.create({ listed: true })!;
    const priv = m.create()!;
    const pub2 = m.create({ listed: true })!;
    expect(priv.listed).toBe(false);
    m.enter(pub2, 1);
    pub2.host.connect(1);
    m.enter(pub2, 2);
    pub2.host.connect(2);
    const rows = m.listing();
    expect(rows.map((r) => r.id)).toEqual(['OPEN', pub2.id, pub.id]);
    expect(rows.find((r) => r.id === pub2.id)).toMatchObject({ kind: 'private', players: 2, maxPlayers: 4, spectators: 0, maxConnections: m.perRoom, joinable: true });
    expect(rows.find((r) => r.id === 'OPEN')).toMatchObject({ kind: 'open', players: 0, joinable: true });
    expect(JSON.stringify(rows)).not.toContain(priv.id);
    expect(JSON.stringify(rows)).not.toMatch(/pubkey|nostr|conn/);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['age', 'id', 'joinable', 'kind', 'maxConnections', 'maxPlayers', 'phase', 'players', 'round', 'spectators']);
    // Full: not joinable; spectators counted.
    for (let c = 3; c <= m.perRoom; c++) {
      m.enter(pub2, c);
      pub2.host.connect(c);
    }
    const full = m.listing().find((r) => r.id === pub2.id)!;
    expect(full).toMatchObject({ players: 4, spectators: m.perRoom - 4, joinable: false });
    m.dispose();
  });
});
