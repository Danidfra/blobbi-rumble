/**
 * The social lobby's simulation (L4): the match's own movement on Blobbi
 * Plaza (walk, run, turn, jump and land as a match fighter does), no
 * punch, grab or score, the fence, the respawn, avatars coming and going,
 * a continuing tick, and a world that is gone when it is disposed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { LOBBY_SPACE, PLAZA, isSocialSpace, plazaSpot, spaceById } from '../arena/lobbySpace';
import { ARENAS, CLASSIC, arenaById } from '../arena/arenas';
import { RUMBLE_BODY } from '../profile';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch } from './match';
import type { HavokInstance } from './physics';
import { SocialSpace, socialIntent } from './social';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const SEATS = ['P1', 'P2', 'P3', 'P4'];
const DT = 1 / 60;
const run = (s: SocialSpace, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    each?.();
    s.step(DT);
  }
};
const at = (s: SocialSpace, id: string) => s.snapshot().fighters.find((f) => f.id === id)!;

describe('the plaza as data (L4)', () => {
  it('is a space, not an arena: never chosen, listed or rotated to; found by the view', () => {
    expect(ARENAS.map((a) => a.id)).not.toContain(LOBBY_SPACE.id);
    expect(arenaById(LOBBY_SPACE.id)).toBeNull();
    expect(spaceById(LOBBY_SPACE.id)).toBe(LOBBY_SPACE);
    expect(spaceById(CLASSIC.id)).toBe(CLASSIC);
    expect(isSocialSpace('blobbi-plaza')).toBe(true);
    expect(isSocialSpace(CLASSIC.id)).toBe(false);
    expect(LOBBY_SPACE.theme).toBe('social');
    expect(LOBBY_SPACE.sweeper).toBeNull();
    expect(LOBBY_SPACE.orbs).toEqual([]);
  });

  it('a fence higher than any jump on every side; the seats’ spots inside it, facing the middle', () => {
    const walls = LOBBY_SPACE.platforms.filter((p) => p.kind === 'wall');
    expect(walls).toHaveLength(4);
    const jumpHeight = RUMBLE_BODY.jumpSpeed ** 2 / (2 * RUMBLE_BODY.gravity);
    for (const w of walls) expect(w.y).toBeGreaterThan(jumpHeight + 0.5);
    for (let i = 0; i < 4; i++) {
      const p = plazaSpot(i);
      expect(Math.abs(p.x)).toBeLessThan(PLAZA.halfWidth - 1);
      expect(Math.abs(p.z)).toBeLessThan(PLAZA.halfDepth - 1);
      expect(Math.hypot(Math.sin(p.yaw) + p.x / Math.hypot(p.x, p.z), Math.cos(p.yaw) + p.z / Math.hypot(p.x, p.z))).toBeLessThan(1e-9);
    }
  });
});

describe('walking the plaza (L4)', () => {
  it('starts with the avatars asked for, on their seats’ spots, at rest, in play, scoring nothing', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1', 'P3'], startTick: 500, startTime: 8 });
    const snap = s.snapshot();
    expect(snap.arena).toBe('blobbi-plaza');
    expect(snap.players).toEqual(['P1', 'P3']);
    expect(snap.tick).toBe(500);
    expect(snap.time).toBe(8);
    expect(snap.phase).toBe('playing');
    expect(snap.orbs).toEqual([]);
    expect(snap.fighters[1].position.x).toBeCloseTo(plazaSpot(2).x, 5);
    expect(snap.fighters[1].position.z).toBeCloseTo(plazaSpot(2).z, 5);
    expect(snap.fighters.every((f) => f.alive && !f.eliminated && f.score === 0)).toBe(true);
    s.dispose();
  });

  it('walks and runs as a match fighter does: the same body, the same speeds, the same turning', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1'] });
    const m = createRumbleMatch({ havok, players: [{ id: 'P1' }, { id: 'P2' }] });
    m.debugPlace('P2', { x: 4, z: 2 });
    run(s, 0.5);
    for (let i = 0; i < 30; i++) m.step(DT);
    const s0 = at(s, 'P1').position;
    const m0 = m.snapshot().fighters[0].position;
    for (let i = 0; i < 60; i++) {
      s.setInput('P1', { x: 1, z: 0, run: true });
      m.setInput('P1', { x: 1, z: 0, run: true });
      s.step(DT);
      m.step(DT);
    }
    const sv = at(s, 'P1').velocity;
    const mv = m.snapshot().fighters[0].velocity;
    expect(Math.hypot(sv.x, sv.z)).toBeGreaterThan(RUMBLE_BODY.runSpeed * 0.9);
    expect(Math.hypot(sv.x, sv.z)).toBeCloseTo(Math.hypot(mv.x, mv.z), 1);
    expect(at(s, 'P1').position.x - s0.x).toBeCloseTo(m.snapshot().fighters[0].position.x - m0.x, 1);
    expect(Math.sin(at(s, 'P1').yaw)).toBeCloseTo(1, 1);
    s.dispose();
    m.dispose();
  });

  it('jumps and lands: up, down, and standing again; a jump asked between steps is never lost', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1'] });
    run(s, 0.5);
    const floor = at(s, 'P1').position.y;
    s.setInput('P1', { jump: true });
    s.setInput('P1', {});
    let top = floor;
    run(s, 1.2, () => (top = Math.max(top, at(s, 'P1').position.y)));
    expect(top - floor).toBeGreaterThan(0.4);
    expect(at(s, 'P1').position.y).toBeCloseTo(floor, 1);
    expect(at(s, 'P1').grounded).toBe(true);
    expect(at(s, 'P1').jumps).toBe(1);
    s.dispose();
  });

  it('punch, grab and throw never happen: requests are dropped, nobody is hit, held or tumbled', () => {
    expect(socialIntent({ x: 1, punch: true, grab: true, jump: true })).toEqual({ x: 1, z: 0, run: false, jump: true, punch: false, grab: false });
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1', 'P2'] });
    s.debugPlace('P2', { x: plazaSpot(0).x + 0.9, z: plazaSpot(0).z });
    run(s, 2, () => {
      s.setInput('P1', { x: 1, z: 0, punch: true, grab: true });
    });
    const snap = s.snapshot();
    for (const f of snap.fighters) {
      expect(f.hits).toBe(0);
      expect(f.combat.punchTime).toBe(-1);
      expect(f.combat.tumble).toBeLessThan(0);
      expect(f.holding).toBeNull();
      expect(f.heldBy).toBeNull();
    }
    s.dispose();
  });

  it('the fence holds: running at it for seconds, nobody leaves the plaza', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1'] });
    run(s, 6, () => s.setInput('P1', { x: 1, z: 0.3, run: true }));
    const p = at(s, 'P1').position;
    expect(p.x).toBeLessThan(PLAZA.halfWidth);
    expect(p.x).toBeGreaterThan(PLAZA.halfWidth - 1);
    expect(p.y).toBeGreaterThan(0);
    run(s, 4, () => s.setInput('P1', { x: 0, z: -1, run: true, jump: true }));
    expect(at(s, 'P1').position.z).toBeGreaterThan(-PLAZA.halfDepth);
    s.dispose();
  });

  it('below the fall line (dropped off by a bug), back on the seat’s spot after a short wait, in play', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1', 'P2'] });
    s.debugPlace('P2', { x: 20, y: 2, z: 0 });
    let lowest = 0;
    run(s, 3, () => (lowest = Math.min(lowest, at(s, 'P2').position.y)));
    expect(lowest).toBeLessThan(LOBBY_SPACE.fallY);
    const f = at(s, 'P2');
    expect(f.position.x).toBeCloseTo(plazaSpot(1).x, 1);
    expect(f.position.z).toBeCloseTo(plazaSpot(1).z, 1);
    expect(f.eliminated).toBe(false);
    expect(f.score).toBe(0);
    s.dispose();
  });

  it('avatars come and go without disturbing the others; ticks keep counting', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: ['P1'] });
    run(s, 0.5, () => s.setInput('P1', { x: 1, z: 0 }));
    const p1 = at(s, 'P1').position;
    const tick = s.tick;
    s.setLineup(['P1', 'P4', 'P2']);
    expect(s.snapshot().players).toEqual(['P1', 'P2', 'P4']);
    expect(at(s, 'P1').position).toEqual(p1);
    expect(at(s, 'P4').position.x).toBeCloseTo(plazaSpot(3).x, 5);
    s.setLineup(['P4']);
    expect(s.snapshot().players).toEqual(['P4']);
    s.setInput('P1', { x: 1 });
    s.step(DT);
    expect(s.tick).toBe(tick + 1);
    s.setLineup([]);
    s.step(DT);
    expect(s.snapshot().fighters).toEqual([]);
    s.dispose();
  });

  it('disposed, its world is gone', () => {
    const s = new SocialSpace({ havok, seats: SEATS, players: SEATS });
    const scene = s.world.scene;
    expect(scene.isDisposed).toBe(false);
    s.dispose();
    expect(scene.isDisposed).toBe(true);
  });
});
