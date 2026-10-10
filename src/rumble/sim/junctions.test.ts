/**
 * M12.1, physics regressions: no fighter is launched by the arena.
 *
 * The playtest's "launched extremely high when crossing junctions" was a
 * falling tile reset in the middle of its fall: swept back up 1.76 m in one
 * step, it kept that +106 m/s in Havok while at rest, and every fighter
 * touching it afterwards was hit by a floor rising at 100 m/s. These tests
 * pin the fix (a piece at rest has no velocity, a piece never sweeps up)
 * and the class of problem: every seam of every arena crossed at many
 * angles, walking and running, alone, against an opponent and carrying
 * one, then bot matches on all four arenas with no upward speed or step
 * that no rule explains.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ARENAS, FROZEN, type ArenaDef } from '../arena/arenas';
import type { Platform } from '../arena/geometry';
import { runHeadless } from '../headless';
import { LEDGE } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { FighterSnapshot } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const DT = 1 / 60;
const fighter = (m: RumbleMatch, id: string) => m.snapshot().fighters.find((f) => f.id === id)!;

/** Every place two platforms of the same height meet edge to edge: the middle of the shared edge, and the axis to cross it along. */
function seams(ps: readonly Platform[]) {
  const out: { x: number; z: number; across: { x: number; z: number }; y: number }[] = [];
  ps.forEach((a, i) =>
    ps.forEach((b, j) => {
      if (j <= i || Math.abs(a.y - b.y) > 1e-6) return;
      const ox = Math.min(a.x + a.halfWidth, b.x + b.halfWidth) - Math.max(a.x - a.halfWidth, b.x - b.halfWidth);
      const oz = Math.min(a.z + a.halfDepth, b.z + b.halfDepth) - Math.max(a.z - a.halfDepth, b.z - b.halfDepth);
      const mx = (Math.max(a.x - a.halfWidth, b.x - b.halfWidth) + Math.min(a.x + a.halfWidth, b.x + b.halfWidth)) / 2;
      const mz = (Math.max(a.z - a.halfDepth, b.z - b.halfDepth) + Math.min(a.z + a.halfDepth, b.z + b.halfDepth)) / 2;
      if (ox >= -1e-6 && ox < 0.6 && oz > 0.8) out.push({ x: mx, z: mz, across: { x: 1, z: 0 }, y: a.y });
      else if (oz >= -1e-6 && oz < 0.6 && ox > 0.8) out.push({ x: mx, z: mz, across: { x: 0, z: 1 }, y: a.y });
    }),
  );
  return out;
}

/** A match with two bystanders standing safely on the platform farthest from `away`, so a round stays on whatever the subject does, and nobody is in its way. */
function arenaMatch(arena: ArenaDef, away = { x: 0, z: 0 }) {
  const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], arena });
  const p = [...arena.platforms].filter((q) => q.halfWidth > 1 && q.halfDepth > 1).sort((q, r) => Math.hypot(r.x - away.x, r.z - away.z) - Math.hypot(q.x - away.x, q.z - away.z))[0];
  m.debugPlace('c', { x: p.x - 0.6, y: p.y, z: p.z });
  m.debugPlace('d', { x: p.x + 0.6, y: p.y, z: p.z });
  return m;
}

describe('dynamic pieces keep no velocity of their own at rest', () => {
  it('a Frozen Lake corner tile reset in the middle of its fall is at rest with no velocity, and walking across it launches nobody', () => {
    const m = arenaMatch(FROZEN);
    // Stand on the north-west corner tile until it arms, warns and is falling.
    m.debugPlace('a', { x: -3.6, z: 3.6 });
    m.debugPlace('b', { x: 0.8, z: 0 });
    let falling = false;
    for (let t = 0; t < 60 * 6 && !falling; t++) {
      m.step(DT);
      falling = m.debugPieces()[1] === 'falling';
    }
    expect(falling).toBe(true);
    for (let t = 0; t < 12; t++) m.step(DT);
    // The round resets with the tile part way down (the case that left it at +106 m/s).
    m.restart();
    for (let t = 0; t < 5; t++) m.step(DT);
    for (const v of m.debugPieceVelocities()) expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(1e-6);
    // Then a fighter runs over the tile's seams with the middle and the north tile, both ways.
    let maxVy = 0;
    for (const [from, dir] of [
      [{ x: -0.9, z: 3.6 }, { x: -1, z: 0 }],
      [{ x: -3.6, z: 0.9 }, { x: 0, z: 1 }],
      [{ x: -4.5, z: 3.6 }, { x: 1, z: 0 }],
    ] as const) {
      m.debugPlace('a', from);
      for (let t = 0; t < 90; t++) {
        m.setInput('a', { x: dir.x, z: dir.z, run: true });
        m.step(DT);
        maxVy = Math.max(maxVy, fighter(m, 'a').velocity.y);
      }
    }
    expect(maxVy).toBeLessThan(1);
    m.dispose();
  });

  it('a piece only ever sweeps down; at rest after a fall and its return, every piece of every arena has no velocity', () => {
    for (const arena of ARENAS.filter((a) => a.dynamics.length)) {
      const m = arenaMatch(arena);
      // Play long enough for pieces to arm, fall and (where they do) come back; reset part way through.
      m.debugPlace('a', { x: 0, z: 0 });
      m.debugPlace('b', { x: 1, z: 0 });
      for (let t = 0; t < 60 * 12; t++) m.step(DT);
      for (const [k, v] of m.debugPieceVelocities().entries()) {
        const phase = m.debugPieces()[k];
        if (phase === 'stable' || phase === 'warning') expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(1e-6);
        // Falling: down only, never up.
        expect(v.y).toBeLessThanOrEqual(1e-6);
      }
      m.restart();
      m.step(DT);
      for (const v of m.debugPieceVelocities()) expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(1e-6);
      m.dispose();
    }
  });
});

describe('crossing every seam of every arena', () => {
  /** Max upward speed and height over the seam's top of fighter 'a' crossing it: walk or run, at an angle, alone, against an opponent, or carrying one. */
  function cross(arena: ArenaDef, s: ReturnType<typeof seams>[number], angle: number, run: boolean, mode: 'alone' | 'opponent' | 'carrying') {
    const m = arenaMatch(arena, s);
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const d = { x: s.across.x * c - s.across.z * sn, z: s.across.z * c + s.across.x * sn };
    m.debugPlace('a', { x: s.x - d.x * 1.3, y: s.y, z: s.z - d.z * 1.3, yaw: Math.atan2(d.x, d.z) });
    if (mode === 'carrying') {
      m.debugPlace('b', { x: s.x - d.x * 0.45, y: s.y, z: s.z - d.z * 0.45, yaw: Math.atan2(-d.x, -d.z) });
      m.step(DT);
      m.setInput('a', { grab: true });
      m.step(DT);
    } else if (mode === 'opponent') m.debugPlace('b', { x: s.x + d.x * 1.0, y: s.y, z: s.z + d.z * 1.0 });
    else m.debugPlace('b', { x: arena.platforms[0].x, y: arena.platforms[0].y, z: arena.platforms[0].z });
    let maxVy = 0;
    let maxRise = 0;
    for (let t = 0; t < 100; t++) {
      m.setInput('a', { x: d.x, z: d.z, run });
      if (mode === 'opponent') m.setInput('b', { x: -d.x, z: -d.z, run: !run });
      const events = m.step(DT);
      // A hazard's blow (the sweeper, the factory arm) lifts by rule: past the seam test's concern.
      if (events.some((e) => e.kind === 'sweeper' && e.who === 'a')) break;
      const f = fighter(m, 'a');
      if (f.eliminated) break;
      maxVy = Math.max(maxVy, f.velocity.y);
      maxRise = Math.max(maxRise, f.position.y - 0.525 - s.y);
    }
    m.dispose();
    return { maxVy, maxRise };
  }

  for (const arena of ARENAS) {
    it(`${arena.name}: no seam lifts a fighter (8 angles, walk and run, alone, against an opponent, carrying)`, () => {
      // Seams inside a sweeper's circle are its: a solid bar that sweeps through (standing on it lifts, by rule).
      const sw = arena.sweeper;
      const list = seams(arena.platforms).filter((q) => !sw || Math.hypot(q.x - sw.pivot.x, q.z - sw.pivot.z) > sw.reach + 1.8);
      expect(list.length).toBeGreaterThan(0);
      let worstVy = 0;
      let worstRise = 0;
      for (const s of list) {
        for (const mode of ['alone', 'opponent', 'carrying'] as const) {
          for (let k = 0; k < 8; k++) {
            const r = cross(arena, s, ((k - 3.5) / 8) * (Math.PI * 0.9), k % 2 === 0, mode);
            worstVy = Math.max(worstVy, r.maxVy);
            worstRise = Math.max(worstRise, r.maxRise);
          }
        }
      }
      // No jump is pressed: a body crossing a flush seam stays on the floor (centimetres of contact noise at most).
      expect(worstVy).toBeLessThan(1.5);
      expect(worstRise).toBeLessThan(0.15);
    }, 120_000);
  }
});

describe('bot matches on every arena: nothing launched', () => {
  for (const arena of ARENAS) {
    it(`${arena.name}: no upward speed beyond what a rule gives (jump 4.6, a blow's lift, a bounded climb 6), no upward jump of position`, () => {
      let prev: FighterSnapshot[] | null = null;
      let maxVy = 0;
      let maxRise = 0;
      runHeadless({
        havok,
        arena,
        matches: 3,
        maxSeconds: 900,
        onStep: (_m, s, events) => {
          const reset = events.some((e) => e.kind === 'newRound' || e.kind === 'newMatch' || e.kind === 'match');
          if (prev && !reset)
            s.fighters.forEach((f, i) => {
              if (f.eliminated || prev![i].eliminated) return;
              maxVy = Math.max(maxVy, f.velocity.y);
              maxRise = Math.max(maxRise, f.position.y - prev![i].position.y);
            });
          prev = s.fighters;
        },
      });
      // Before M12.1, Frozen Lake reached 62 m/s (a rest tile at +106 m/s); the bounded climb is the fastest rise left.
      expect(maxVy).toBeLessThanOrEqual(LEDGE.climbMaxSpeed + 0.5);
      expect(maxRise).toBeLessThan(0.15);
    }, 300_000);
  }
});
