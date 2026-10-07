/**
 * The authoritative match, in plain Node: no DOM, no canvas, no keyboard,
 * no visual Blobbi. Created with 2, 3 or 4 players named by stable ids,
 * driven by intents, advanced only by explicit steps, read through plain
 * snapshots and events, and played to the end.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { spawnPoints } from '../arena/layout';
import { runHeadless } from '../headless';
import { BLOBBI_GAMEPLAY_PROFILE } from '@blobbi-kit/3d';
import { GAMEPLAY_PROFILE, RUMBLE_BODY } from '../profile';
import { ORBS, ROUND, SWEEPER } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { MatchSnapshot } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const DT = 1 / 60;
const make = (ids: string[]) => createRumbleMatch({ havok, players: ids.map((id) => ({ id })) });
const steps = (m: RumbleMatch, n: number) => {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...m.step(DT));
  return events;
};
const fighter = (s: MatchSnapshot, id: string) => s.fighters.find((f) => f.id === id)!;
/** Put a fighter over the void beyond the north rim of the centre: it falls and is rung out. */
const overVoid = (m: RumbleMatch, id: string) => m.debugPlace(id, { x: 0, z: 6 });

describe('the authoritative match', () => {
  it('runs with no DOM, window or keyboard anywhere', () => {
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
    const m = make(['a', 'b']);
    steps(m, 10);
    expect(m.tick).toBe(10);
    m.dispose();
  });

  it('is created with 2, 3 or 4 players, each at its spawn, named by its id; anything else is refused', () => {
    for (const count of [2, 3, 4] as const) {
      const ids = ['zed', 'amy', 'kai', 'bo'].slice(0, count);
      const m = make(ids);
      const s = m.snapshot();
      expect(s.players).toEqual(ids);
      expect(s.fighters.map((f) => f.id)).toEqual(ids);
      spawnPoints(count).forEach((p, i) => {
        expect(s.fighters[i].position.x).toBeCloseTo(p.x);
        expect(s.fighters[i].position.z).toBeCloseTo(p.z);
        expect(s.fighters[i].yaw).toBeCloseTo(p.yaw);
      });
      expect(s.phase).toBe('playing');
      expect(s.round).toBe(1);
      m.dispose();
    }
    expect(() => make(['solo'])).toThrow();
    expect(() => make(['a', 'b', 'c', 'd', 'e'])).toThrow();
    expect(() => make(['a', 'a'])).toThrow();
    const m = make(['a', 'b']);
    expect(() => m.setInput('nobody', { x: 1 })).toThrow();
    m.dispose();
  });

  it('time passes only through step: nothing moves without one, and a step is exactly dt', () => {
    const m = make(['a', 'b']);
    steps(m, 30); // settle on the floor
    const before = m.snapshot();
    m.setInput('a', { x: 1 });
    expect(m.snapshot()).toEqual(before);
    m.step(DT);
    expect(m.tick).toBe(before.tick + 1);
    expect(m.time).toBeCloseTo(before.time + DT, 12);
    steps(m, 59);
    const after = m.snapshot();
    // A second of walking east: about a walk's worth of ground, and the other fighter, given nothing, stayed put.
    expect(fighter(after, 'a').position.x - fighter(before, 'a').position.x).toBeGreaterThan(RUMBLE_BODY.walkSpeed * 0.8);
    expect(Math.abs(fighter(after, 'b').position.x - fighter(before, 'b').position.x)).toBeLessThan(0.01);
    // The facing follows: a turned toward the east.
    expect(Math.sin(fighter(after, 'a').yaw)).toBeGreaterThan(0.99);
    m.dispose();
  });

  it('movement holds until replaced; an action is a request taken once by the next step, and dropped while it may not act', () => {
    const m = make(['a', 'b']);
    steps(m, 30);
    m.setInput('a', { punch: true });
    m.setInput('a', { punch: false });
    m.step(DT);
    // The press was not lost to the second intent, and it is a punch now.
    expect(fighter(m.snapshot(), 'a').combat.punchTime).toBeGreaterThanOrEqual(0);
    steps(m, 60);
    expect(fighter(m.snapshot(), 'a').combat.punchTime).toBe(-1);
    // Nothing new without a new request.
    expect(m.snapshot().fighters[0].combat.punchCooldown).toBe(0);
    // Intents from anywhere are cleaned: a direction longer than one is cut to one, junk to nothing.
    m.setInput('b', { x: 3, z: 4, run: 1 as unknown as boolean });
    m.setInput('a', { x: NaN, z: Infinity });
    steps(m, 60);
    const b = fighter(m.snapshot(), 'b');
    expect(Math.hypot(b.velocity.x, b.velocity.z)).toBeLessThan(RUMBLE_BODY.runSpeed * 1.05);
    expect(Number.isFinite(fighter(m.snapshot(), 'a').position.x)).toBe(true);
    m.dispose();
  });

  it('snapshots are plain data: they survive JSON unchanged and hold no functions, class instances or engine objects', () => {
    const m = make(['a', 'b', 'c', 'd']);
    steps(m, 20);
    const s = m.snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const walk = (v: unknown, path: string) => {
      if (v === null || ['number', 'string', 'boolean'].includes(typeof v)) return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      expect(typeof v, path).toBe('object');
      expect(Object.getPrototypeOf(v), path).toBe(Object.prototype);
      for (const [k, x] of Object.entries(v as object)) walk(x, `${path}.${k}`);
    };
    walk(s, 'snapshot');
    expect(s.fighters).toHaveLength(4);
    // A snapshot is a copy: changing it changes nothing in the match.
    s.fighters[0].position.x = 99;
    s.orbs[0].active = false;
    expect(m.snapshot().fighters[0].position.x).not.toBe(99);
    expect(m.snapshot().orbs[0].active).toBe(true);
    m.dispose();
  });

  it('a hold is reported by stable ids on both sides, and a third grab of the held body is refused', () => {
    const m = make(['zed', 'amy', 'kai']);
    m.debugPlace('amy', { x: 0, z: 0, yaw: Math.PI / 2 });
    m.debugPlace('zed', { x: 0.9, z: 0, yaw: -Math.PI / 2 });
    m.debugPlace('kai', { x: 1.8, z: 0, yaw: -Math.PI / 2 });
    steps(m, 5);
    m.setInput('amy', { grab: true });
    const events = steps(m, 1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'grab', who: 'amy', on: 'zed' }));
    let s = m.snapshot();
    expect(fighter(s, 'amy').holding).toBe('zed');
    expect(fighter(s, 'zed').heldBy).toBe('amy');
    expect(fighter(s, 'kai').holding).toBeNull();
    m.setInput('kai', { grab: true });
    steps(m, 1);
    s = m.snapshot();
    expect(fighter(s, 'zed').heldBy).toBe('amy');
    expect(fighter(s, 'kai').holding).toBeNull();
    expect(m.holdsConsistent()).toBe(true);
    // The throw ends it on both sides.
    m.setInput('amy', { grab: true });
    expect(steps(m, 1)).toContainEqual(expect.objectContaining({ kind: 'throw', who: 'amy', on: 'zed' }));
    s = m.snapshot();
    expect(fighter(s, 'amy').holding).toBeNull();
    expect(fighter(s, 'zed').heldBy).toBeNull();
    m.dispose();
  });

  it('decides a punch: who it lands on, and the reaction, named by id', () => {
    const m = make(['a', 'b', 'c']);
    m.debugPlace('a', { x: 0, z: 0, yaw: Math.PI / 2 });
    m.debugPlace('b', { x: 0.95, z: 0 });
    m.debugPlace('c', { x: 1.1, z: 0.1 });
    steps(m, 3);
    m.setInput('a', { punch: true });
    const events = steps(m, 10).filter((e) => e.kind === 'punch');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ who: 'a', on: 'b', reaction: 'hit' });
    expect(fighter(m.snapshot(), 'b').lastImpact).toBeGreaterThan(0);
    expect(fighter(m.snapshot(), 'c').lastImpact).toBe(0);
    m.dispose();
  });

  it('orbs: the state shows in the snapshot, the taker by id, the power on the fighter', () => {
    const m = make(['a', 'b']);
    const o = ORBS.points[0];
    m.debugPlace('b', { x: o.x, z: o.z });
    const events = steps(m, 2);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'orb', who: 'b', orb: 0 }));
    const s = m.snapshot();
    expect(s.orbs[0].active).toBe(false);
    expect(s.orbs[0].timer).toBeGreaterThan(ORBS.respawnDelay - 0.1);
    expect(s.orbs[1].active).toBe(true);
    expect(fighter(s, 'b').powerLevel).toBe(1);
    expect(fighter(s, 'a').powerLevel).toBe(0);
    m.dispose();
  });

  it('the sweeper: its angle advances with the steps and shows in the snapshot; its hit is the match\'s', () => {
    const m = make(['a', 'b']);
    expect(m.snapshot().sweeper.angle).toBe(0);
    steps(m, 60);
    expect(m.snapshot().sweeper.angle).toBeCloseTo(SWEEPER.angularSpeed * 60 * DT, 6);
    expect(m.snapshot().sweeper.angularSpeed).toBe(SWEEPER.angularSpeed);
    // Stand in the bar's path near the tip: struck within a turn.
    const r = 1.7;
    m.debugPlace('a', { x: SWEEPER.pivot.x + r * Math.cos(-2), z: SWEEPER.pivot.z + r * Math.sin(-2) });
    const hits = steps(m, 300).filter((e) => e.kind === 'sweeper');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].who).toBe('a');
    m.dispose();
  });

  it('a ring-out eliminates by id, the rest play on, and the last standing scores; four to one', () => {
    const m = make(['a', 'b', 'c', 'd']);
    const order = ['c', 'a', 'd'];
    for (const [k, id] of order.entries()) {
      overVoid(m, id);
      const events = steps(m, 90);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: id }));
      const s = m.snapshot();
      expect(fighter(s, id).eliminated).toBe(true);
      expect(fighter(s, id).alive).toBe(false);
      expect(s.fighters.filter((f) => f.alive)).toHaveLength(3 - k);
      if (k < 2) expect(s.phase).toBe('playing');
    }
    const s = m.snapshot();
    expect(s.phase).toBe('roundOver');
    expect(s.lastRoundWinner).toBe('b');
    expect(fighter(s, 'b').score).toBe(1);
    expect(s.fighters.filter((f) => f.score > 0).map((f) => f.id)).toEqual(['b']);
    m.dispose();
  });

  it('a new round puts everyone back: same ids, at the spawns, in play, no power, orbs back, sweeper at its start', () => {
    const m = make(['zed', 'amy']);
    const o = ORBS.points[0];
    m.debugPlace('amy', { x: o.x, z: o.z });
    steps(m, 2);
    overVoid(m, 'zed');
    const events = steps(m, 60 + Math.ceil(ROUND.resetDelay / DT) + 10);
    expect(events.map((e) => e.kind)).toContain('newRound');
    const s = m.snapshot();
    expect(s.round).toBe(2);
    expect(s.phase).toBe('playing');
    expect(s.players).toEqual(['zed', 'amy']);
    expect(fighter(s, 'amy').score).toBe(1);
    const spawns = spawnPoints(2);
    s.fighters.forEach((f, i) => {
      expect(f.eliminated).toBe(false);
      expect(f.alive).toBe(true);
      expect(f.powerLevel).toBe(0);
      expect(f.holding).toBeNull();
      expect(f.heldBy).toBeNull();
      expect(Math.hypot(f.position.x - spawns[i].x, f.position.z - spawns[i].z)).toBeLessThan(0.05);
    });
    expect(s.orbs.every((x) => x.active)).toBe(true);
    m.dispose();
  });

  it('first to the target wins the match, by id; a restart starts it again', () => {
    const m = make(['a', 'b']);
    for (let r = 0; r < ROUND.target; r++) {
      overVoid(m, 'a');
      steps(m, 60 + Math.ceil(ROUND.resetDelay / DT) + 10);
    }
    let s = m.snapshot();
    expect(s.phase).toBe('matchOver');
    expect(s.matchWinner).toBe('b');
    expect(fighter(s, 'b').score).toBe(ROUND.target);
    // Nothing more happens on its own.
    steps(m, 120);
    expect(m.snapshot().matchWinner).toBe('b');
    expect(m.restart()).toContainEqual(expect.objectContaining({ kind: 'newMatch' }));
    s = m.snapshot();
    expect(s.phase).toBe('playing');
    expect(s.matchWinner).toBeNull();
    expect(s.fighters.map((f) => f.score)).toEqual([0, 0]);
    expect(s.players).toEqual(['a', 'b']);
    m.dispose();
  });
});

describe('a whole match, headless', () => {
  it('four bots play a full match to a winner, then another on the same match, with every hold consistent and every number finite', () => {
    let inconsistent = 0;
    let nonFinite = 0;
    const r = runHeadless({
      havok,
      players: 4,
      matches: 2,
      maxSeconds: 900,
      onStep: (m, s) => {
        if (!m.holdsConsistent()) inconsistent++;
        for (const f of s.fighters) if (![f.position.x, f.position.y, f.position.z, f.velocity.x, f.velocity.y, f.velocity.z].every(Number.isFinite)) nonFinite++;
      },
    });
    expect(r.matches).toHaveLength(2);
    for (const result of r.matches) {
      expect(result.winner).not.toBeNull();
      expect(result.scores[result.winner!]).toBe(ROUND.target);
      expect(result.rounds).toBeGreaterThanOrEqual(ROUND.target);
    }
    expect(inconsistent).toBe(0);
    expect(nonFinite).toBe(0);
    expect(r.events.filter((e) => e.kind === 'match')).toHaveLength(2);
  });

  it('two and three players finish too', () => {
    for (const players of [2, 3] as const) {
      const r = runHeadless({ havok, players, maxSeconds: 900 });
      expect(r.matches[0].winner).not.toBeNull();
    }
  });

  it('is reproducible in one build on one machine: the same match played twice decides the same things', () => {
    const a = runHeadless({ havok, players: 4, maxSeconds: 40 });
    const b = runHeadless({ havok, players: 4, maxSeconds: 40 });
    expect(b.events).toEqual(a.events);
  });
});

describe('the boundary', () => {
  it('the gameplay body is the kit\'s profile, copied so the match does not import the renderer', () => {
    expect(GAMEPLAY_PROFILE).toEqual(Object.fromEntries(Object.keys(GAMEPLAY_PROFILE).map((k) => [k, (BLOBBI_GAMEPLAY_PROFILE as Record<string, number>)[k]])));
  });

  it('the match imports nothing of presentation, input devices or the browser', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Set<string>();
    const forbidden: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      if (/\b(document|window|requestAnimationFrame|addEventListener|KeyboardEvent)\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) forbidden.push(`${file}: browser global`);
      for (const [, spec] of src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        if (spec === '@blobbi-kit/3d' || spec.startsWith('@blobbi-kit')) forbidden.push(`${file} → ${spec}`);
        if (/Cameras|Lights|Materials|Engines\/engine$|Debug/.test(spec)) forbidden.push(`${file} → ${spec}`);
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec) + '.ts';
        if (/\/view\/|\/playground\/|control\/input|\/main|\/roster|camera/.test(target)) forbidden.push(`${file} → ${spec}`);
        visit(target);
      }
    };
    visit(resolve(here, 'match.ts'));
    expect(forbidden).toEqual([]);
    expect(seen.size).toBeGreaterThan(10);
  });
});
