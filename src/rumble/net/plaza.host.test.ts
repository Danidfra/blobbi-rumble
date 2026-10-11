/**
 * The public plaza's host (L4.1): only ever the social plaza, eight seats
 * for people, no lifecycle, no match, no combat; up to two ambient bots
 * while few people are there, coming and going after a settle, never seats.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { AMBIENT, RumbleHost } from './host';
import { inputMessage } from './protocol';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const SEATS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
const plaza = () => new RumbleHost({ havok, lifecycle: 'plaza', players: SEATS });
const secs = (h: RumbleHost, s: number) => {
  for (let i = 0; i < Math.ceil(s * h.tickHz); i++) h.tick();
};
const settle = (h: RumbleHost) => secs(h, AMBIENT.settleSeconds + 0.1);
const bots = (h: RumbleHost) => h.state().snapshot.players.filter((id) => AMBIENT.ids.includes(id));

describe('the public plaza’s host (L4.1)', () => {
  it('is only the plaza: no lifecycle, no match, no lobby message; its space is the plaza', () => {
    const h = plaza();
    expect(h.isPlaza).toBe(true);
    expect(h.lobby).toBeNull();
    expect(() => h.match).toThrow();
    expect(h.arena.id).toBe('blobbi-plaza');
    h.connect(1);
    expect(h.lobbyFor(1)).toBeNull();
    expect(h.command(1, { t: 'ready', ready: true })).toBe('no-lobby');
    expect(h.command(1, { t: 'start' })).toBe('no-lobby');
    secs(h, 1);
    expect(h.state().snapshot.arena).toBe('blobbi-plaza');
    h.dispose();
  });

  it('eight people walk it together, each by their own inputs; nobody is hit, scored or out', () => {
    const h = plaza();
    for (let c = 1; c <= 8; c++) expect(h.connect(c).you).toBe(`P${c}`);
    h.tick();
    const start = h.state().snapshot.fighters.filter((f) => SEATS.includes(f.id)).map((f) => ({ ...f.position }));
    for (let k = 1; k <= 60; k++) {
      for (let c = 1; c <= 8; c++) h.receive(c, JSON.stringify(inputMessage(k, { x: c % 2 ? 1 : -1, z: 0.3, run: false }, { jump: false, punch: true, grab: true })));
      h.tick();
    }
    const s = h.state();
    const people = s.snapshot.fighters.filter((f) => SEATS.includes(f.id));
    expect(people).toHaveLength(8);
    people.forEach((f, i) => expect(Math.hypot(f.position.x - start[i].x, f.position.z - start[i].z)).toBeGreaterThan(0.5));
    expect(people.every((f) => f.hits === 0 && f.score === 0 && !f.eliminated && f.combat.punchTime === -1 && f.holding === null)).toBe(true);
    expect(Object.values(s.acks)).toHaveLength(8);
    h.dispose();
  });

  it('ambient bots: two for nobody or one person, one for two, none from three; after a settle; never seats, never in the roster', () => {
    const h = plaza();
    h.tick();
    expect(bots(h)).toEqual(['B1', 'B2']);
    h.connect(1);
    settle(h);
    expect(bots(h)).toHaveLength(2);
    h.connect(2);
    h.tick();
    // Not at once: the change settles first.
    expect(bots(h)).toHaveLength(2);
    settle(h);
    expect(bots(h)).toHaveLength(1);
    h.connect(3);
    settle(h);
    expect(bots(h)).toEqual([]);
    expect(Object.keys(h.roster().slots)).toEqual(SEATS);
    expect(JSON.stringify(h.roster())).not.toContain('B1');
    // People leave: the bots come back, one at a time.
    h.disconnect(3);
    h.disconnect(2);
    settle(h);
    expect(bots(h)).toHaveLength(1);
    settle(h);
    expect(bots(h)).toHaveLength(2);
    h.dispose();
  });

  it('a quick reload (gone and back within the settle) changes nothing for the bots', () => {
    const h = plaza();
    h.connect(1);
    h.connect(2);
    settle(h);
    expect(bots(h)).toHaveLength(1);
    h.disconnect(2);
    secs(h, 0.5);
    h.connect(3);
    settle(h);
    expect(bots(h)).toHaveLength(1);
    h.dispose();
  });

  it('ambient bots take no seat and no connection place: eight people still find eight seats; a ninth finds none', () => {
    const h = plaza();
    h.tick();
    expect(bots(h)).toHaveLength(2);
    for (let c = 1; c <= 8; c++) expect(h.connect(c).you).not.toBeNull();
    expect(h.connect(9).you).toBeNull();
    h.dispose();
  });

  it('ambient bots stroll (bots by control, wanderers by behaviour) and are not people', () => {
    const h = plaza();
    h.connect(1);
    h.tick();
    const before = h.state().snapshot.fighters.find((f) => f.id === 'B1')!.position;
    secs(h, 8);
    const s = h.state();
    expect(s.control).toMatchObject({ P1: 'human', B1: 'bot', B2: 'bot' });
    expect(s.acks.B1).toBeUndefined();
    const after = s.snapshot.fighters.find((f) => f.id === 'B1')!.position;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.5);
    h.dispose();
  });

  it('the bot that goes is the one furthest from anyone', () => {
    const h = plaza();
    h.connect(1);
    h.tick();
    // P1 stands right by B2's corner: B1 is the far one.
    h.plaza!.debugPlace('P1', { x: 5, z: 3.5 });
    h.plaza!.debugPlace('B1', { x: -5, z: -4 });
    h.plaza!.debugPlace('B2', { x: 4.5, z: 3 });
    h.tick();
    h.connect(2);
    settle(h);
    expect(bots(h)).toEqual(['B2']);
    h.dispose();
  });

  it('people joining and leaving never reset the others: positions carry on, ticks count up', () => {
    const h = plaza();
    h.connect(1);
    for (let k = 1; k <= 30; k++) {
      h.receive(1, JSON.stringify(inputMessage(k, { x: 1, z: 0, run: true }, { jump: false, punch: false, grab: false })));
      h.tick();
    }
    const p1 = h.state().snapshot.fighters.find((f) => f.id === 'P1')!.position;
    const tick = h.state().tick;
    h.connect(2);
    h.tick();
    h.disconnect(2);
    h.tick();
    const now = h.state().snapshot.fighters.find((f) => f.id === 'P1')!.position;
    expect(Math.hypot(now.x - p1.x, now.z - p1.z)).toBeLessThan(0.3);
    expect(h.state().tick).toBe(tick + 2);
    h.dispose();
  });
});
