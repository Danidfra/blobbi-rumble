/**
 * M11A/B as pure logic: the arena registry (four arenas, the classic one
 * exactly the old layout), selection and rotation, spawns and orbs standing
 * on floors, the general geometry over platforms at several heights, and
 * the dynamic pieces' state machine.
 */
import { describe, expect, it } from 'vitest';
import { ORBS } from '../tuning';
import { ARENA, spawnPoints } from './layout';
import { ARENAS, ARENA_IDS, CLASSIC, DEFAULT_ARENA, FACTORY, FROZEN, SKYFALL, arenaById, arenaSpawns, nextArena, type PieceRule } from './arenas';
import { extentOf, findLedge, inPlatform, onAnyFloor, platformUnder, rimDistanceOf } from './geometry';
import { FALL_DEPTH, createPieces, drop, pieceImpact, pieceSolid, resetPieces, tickPiece } from './pieces';

describe('the arena registry (M11A)', () => {
  it('holds four arenas with distinct ids, names and themes; the default is the classic island; an unknown id is nobody', () => {
    expect(ARENAS).toHaveLength(4);
    expect(new Set(ARENA_IDS).size).toBe(4);
    expect(ARENA_IDS).toEqual(['floating-islands-classic', 'floating-islands-skyfall', 'blobbi-factory', 'frozen-lake']);
    expect(DEFAULT_ARENA).toBe(CLASSIC.id);
    for (const a of ARENAS) {
      expect(arenaById(a.id)).toBe(a);
      expect(a.name.length).toBeGreaterThan(3);
      expect(a.description.length).toBeGreaterThan(10);
    }
    expect(arenaById('moon-base')).toBeNull();
    expect(arenaById(null)).toBeNull();
    expect(arenaById(undefined)).toBeNull();
  });

  it('the classic island is exactly the old layout: the three slabs at y = 0, the old spawns, orbs and sweeper, nothing dynamic', () => {
    expect(CLASSIC.platforms).toHaveLength(3);
    expect(CLASSIC.platforms.every((p) => p.y === 0 && p.kind === 'floor' && p.thickness === ARENA.thickness)).toBe(true);
    expect(CLASSIC.platforms[0]).toMatchObject({ x: 0, z: 0, halfWidth: ARENA.centre.halfWidth, halfDepth: ARENA.centre.halfDepth });
    expect(CLASSIC.orbs).toBe(ORBS.points);
    expect(CLASSIC.dynamics).toHaveLength(0);
    expect(CLASSIC.conveyors).toHaveLength(0);
    expect(CLASSIC.sweeper).not.toBeNull();
    for (const n of [2, 3, 4] as const) {
      const old = spawnPoints(n);
      const now = arenaSpawns(CLASSIC, n);
      now.forEach((s, i) => {
        expect(s.x).toBe(old[i].x);
        expect(s.z).toBe(old[i].z);
        expect(s.y).toBe(0);
      });
    }
  });

  it('every arena: spawns and orbs stand on a platform, spawns clear of each other, dynamics and conveyors name real platforms of the right kind', () => {
    for (const a of ARENAS) {
      for (const n of [2, 3, 4] as const) {
        const spawns = arenaSpawns(a, n);
        expect(spawns).toHaveLength(n);
        for (const s of spawns) {
          const under = platformUnder(a.platforms, s, 0.3);
          expect(under, `${a.id}: spawn ${s.x},${s.z} off the floor`).not.toBeNull();
          expect(s.y).toBe(under!.y);
        }
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(Math.hypot(spawns[i].x - spawns[j].x, spawns[i].z - spawns[j].z)).toBeGreaterThan(1.5);
      }
      for (const o of a.orbs) expect(onAnyFloor(a.platforms, o, 0.2), `${a.id}: orb ${o.x},${o.z}`).toBe(true);
      for (const d of a.dynamics) expect(a.platforms[d.platform]).toBeDefined();
      for (const c of a.conveyors) expect(a.platforms[c.platform]?.kind).toBe('conveyor');
      expect(a.fallY).toBeLessThan(Math.min(...a.platforms.map((p) => p.y)) - 1);
      expect(a.camera.maxRadius).toBeGreaterThan(5);
    }
    // No spawn stands on a piece that can fall (a round must start on solid ground).
    for (const a of ARENAS) for (const n of [2, 3, 4] as const) for (const s of arenaSpawns(a, n)) for (const d of a.dynamics) expect(inPlatform(a.platforms[d.platform], s, 0)).toBe(false);
  });

  it('a rotation never repeats the current arena, is deterministic in its number, and covers every other arena', () => {
    for (const a of ARENAS) {
      const seen = new Set<string>();
      for (let r = 0; r < 1; r += 0.05) {
        const n = nextArena(a.id, r);
        expect(n.id).not.toBe(a.id);
        seen.add(n.id);
      }
      expect(seen.size).toBe(3);
      expect(nextArena(a.id, 0.2)).toBe(nextArena(a.id, 0.2));
      expect(nextArena(a.id, 1)).toBeDefined();
    }
  });

  it('the four arenas differ in what makes them: Skyfall breaks and drops, the factory carries and sweeps, the lake is ice', () => {
    expect(SKYFALL.sweeper).toBeNull();
    expect(SKYFALL.dynamics.map((d) => d.rule.kind).sort()).toEqual(['breakable', 'breakable', 'falling', 'falling']);
    expect(SKYFALL.platforms.filter((p) => p.kind === 'bridge')).toHaveLength(2);
    expect(new Set(SKYFALL.platforms.map((p) => p.y)).size).toBeGreaterThan(3);
    expect(FACTORY.conveyors).toHaveLength(2);
    expect(FACTORY.conveyors[0].vx).toBe(-FACTORY.conveyors[1].vx);
    expect(FACTORY.sweeper).not.toBeNull();
    expect(FACTORY.sweeper!.pivot).not.toEqual(CLASSIC.sweeper!.pivot);
    expect(FROZEN.platforms.every((p) => p.kind === 'ice')).toBe(true);
    expect(FROZEN.iceFriction).toBeLessThan(CLASSIC.iceFriction);
    expect(FROZEN.dynamics.every((d) => d.rule.kind === 'falling' && d.rule.back > 0)).toBe(true);
  });
});

describe('geometry over platforms at several heights', () => {
  it('the highest platform under a point wins; the rim is the union’s outline; the extent spans everything', () => {
    const ps = FACTORY.platforms;
    expect(platformUnder(ps, { x: 0, z: 0 })?.name).toBe('crate');
    expect(platformUnder(ps, { x: 3, z: 0 })?.name).toBe('main floor');
    expect(platformUnder(ps, { x: 0, z: 2.3 })?.kind).toBe('conveyor');
    expect(platformUnder(ps, { x: 0, z: 20 })).toBeNull();
    expect(onAnyFloor(ps, { x: 6.25, z: 0 }, 0.5)).toBe(true);
    expect(onAnyFloor(ps, { x: 6.25, z: 2.1 }, 0.5)).toBe(false);
    const ext = extentOf(ps);
    expect(ext.halfWidth).toBeCloseTo(8.25, 5);
    expect(rimDistanceOf(ps, { x: 0, z: 0 })).toBeGreaterThan(3);
    expect(rimDistanceOf(ps, { x: 9, z: 0 })).toBe(0);
  });

  it('a ledge is found just beyond a platform’s edge within reach and height, pointing inward; not over the platform, not too far', () => {
    const ps = SKYFALL.platforms;
    // Beside the east island (y 0.5), a body whose feet are below its top.
    const l = findLedge(ps, { x: 8.6, y: 0.6, z: 3.9 }, 0.0, { reach: 0.6, minBelow: 0.2, maxBelow: 1.2 });
    expect(l).not.toBeNull();
    expect(ps[l!.platform].name).toBe('east island');
    expect(l!.y).toBe(0.5);
    expect(l!.inZ).toBe(-1);
    expect(l!.inX).toBe(0);
    expect(findLedge(ps, { x: 8.6, y: 0.6, z: 1 }, 0.0, { reach: 0.6, minBelow: 0.2, maxBelow: 1.2 })).toBeNull();
    expect(findLedge(ps, { x: 8.6, y: 0.6, z: 4.5 }, 0.0, { reach: 0.6, minBelow: 0.2, maxBelow: 1.2 })).toBeNull();
    // A platform below the feet is not a ledge to hang from.
    expect(findLedge(ps, { x: 8.6, y: 2, z: 3.9 }, 2, { reach: 0.6, minBelow: 0.2, maxBelow: 1.2 })).toBeNull();
  });
});

describe('the dynamic pieces (M11B)', () => {
  const pad = SKYFALL.dynamics[2] as { platform: number; rule: Extract<PieceRule, { kind: 'falling' }> };
  const bridge = SKYFALL.dynamics[0];
  const DT = 1 / 60;
  const run = (p: ReturnType<typeof createPieces>[0], rule: PieceRule, seconds: number, loaded: boolean, t0 = 0) => {
    const entered: string[] = [];
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      const e = tickPiece(p, rule, DT, loaded, t0 + i * DT);
      if (e) entered.push(e);
    }
    return entered;
  };

  it('a falling pad: weight arms it, warning holds, then it falls over its time to FALL_DEPTH, is gone, and comes back', () => {
    const [p] = createPieces([pad]);
    expect(pieceSolid(p)).toBe(true);
    expect(run(p, pad.rule, pad.rule.arm - 0.1, true)).toEqual([]);
    expect(p.phase).toBe('stable');
    expect(run(p, pad.rule, 0.2, true)).toEqual(['warning']);
    expect(pieceSolid(p)).toBe(true);
    expect(drop(p, pad.rule)).toBe(0);
    expect(run(p, pad.rule, pad.rule.warn + 0.05, false)).toEqual(['falling']);
    expect(pieceSolid(p)).toBe(false);
    run(p, pad.rule, pad.rule.fall / 2, false);
    const mid = drop(p, pad.rule);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(FALL_DEPTH);
    expect(run(p, pad.rule, pad.rule.fall / 2 + 0.05, false)).toEqual(['gone']);
    expect(drop(p, pad.rule)).toBe(FALL_DEPTH);
    expect(run(p, pad.rule, pad.rule.back + 0.05, false)).toEqual(['stable']);
    expect(p.load).toBe(0);
    expect(drop(p, pad.rule)).toBe(0);
    expect(pieceSolid(p)).toBe(true);
  });

  it('weight drains while nobody stands on a pad: on and off never arms it', () => {
    const [p] = createPieces([pad]);
    for (let k = 0; k < 10; k++) {
      run(p, pad.rule, 0.3, true);
      run(p, pad.rule, 0.7, false);
    }
    expect(p.phase).toBe('stable');
  });

  it('a breakable bridge: heavy impacts over it arm it, or the round’s clock; it never comes back; a reset puts it back', () => {
    const [p] = createPieces([bridge]);
    const rule = bridge.rule as Extract<typeof bridge.rule, { kind: 'breakable' }>;
    for (let i = 0; i < rule.impacts - 1; i++) pieceImpact(p, rule);
    expect(run(p, rule, 1, true)).toEqual([]);
    pieceImpact(p, rule);
    expect(run(p, rule, 0.1, false)).toEqual(['warning']);
    pieceImpact(p, rule); // Not counted once arming.
    expect(run(p, rule, rule.warn + rule.fall + 0.1, false)).toEqual(['falling', 'gone']);
    expect(run(p, rule, 30, false)).toEqual([]);
    expect(p.phase).toBe('gone');
    resetPieces([p]);
    expect(p).toEqual({ phase: 'stable', t: 0, load: 0 });
    // The clock alone.
    expect(run(p, rule, rule.after + 0.1, false)).toEqual(['warning']);
  });

  it('a falling pad never counts impacts; a round reset forgets weight', () => {
    const [p] = createPieces([pad]);
    for (let i = 0; i < 10; i++) pieceImpact(p, pad.rule);
    expect(p.load).toBe(0);
    run(p, pad.rule, 1, true);
    expect(p.load).toBeGreaterThan(0.9);
    resetPieces([p]);
    expect(p.load).toBe(0);
  });
});
