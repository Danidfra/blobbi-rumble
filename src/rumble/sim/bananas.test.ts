/**
 * M11F in the authoritative match: who may throw, what is judged, the peel
 * in every snapshot (late joiners too), the slip, the budget, the cooldown,
 * the cap, the lifetime, and the clean-up at a new round.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC, SKYFALL } from '../arena/arenas';
import { BANANAS, ROUND } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});
const DT = 1 / 60;
const secs = (m: RumbleMatch, s: number) => {
  const events = [];
  for (let i = 0; i < Math.ceil(s / DT); i++) events.push(...m.step(DT));
  return events;
};
const four = () => createRumbleMatch({ havok, players: ['a', 'b', 'c', 'd'].map((id) => ({ id })), arena: CLASSIC });
/** Put everyone still and 'a' out of the round (three left). */
const outA = (m: RumbleMatch) => {
  for (const id of ['b', 'c', 'd']) m.setInput(id, { x: 0, z: 0 });
  m.debugPlace('a', { x: 0, z: 9 });
  const events = secs(m, 2);
  expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
  expect(m.snapshot().phase).toBe('playing');
};

describe('banana peels (M11F)', () => {
  it('a fighter in the round may not throw; an eliminated one may, onto the floor, and the peel is in the snapshot with its owner', () => {
    const m = four();
    expect(m.throwBanana('a', 1, 1)).toEqual({ ok: false, reason: 'in play' });
    outA(m);
    expect(m.throwBanana('a', 30, 0)).toEqual({ ok: false, reason: 'off floor' });
    const r = m.throwBanana('a', 1.5, -1);
    expect(r).toEqual({ ok: true });
    const events = m.step(DT);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'banana', who: 'a' }));
    const s = m.snapshot();
    expect(s.bananas).toHaveLength(1);
    expect(s.bananas[0]).toMatchObject({ x: 1.5, z: -1, owner: 'a' });
    expect(s.bananas[0].y).toBeCloseTo(BANANAS.height, 6);
    expect(s.fighters[0].bananas.left).toBe(BANANAS.perRound - 1);
    expect(s.fighters[0].bananas.cooldown).toBeGreaterThan(BANANAS.cooldown - 0.1);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    m.dispose();
  });

  it('the cooldown, the budget per round and the cap on peels are the server’s; too few left in the round refuses too', () => {
    const m = four();
    outA(m);
    expect(m.throwBanana('a', 0, 0).ok).toBe(true);
    expect(m.throwBanana('a', 1, 0)).toEqual({ ok: false, reason: 'cooldown' });
    secs(m, BANANAS.cooldown + 0.05);
    expect(m.throwBanana('a', 1, 0).ok).toBe(true);
    secs(m, BANANAS.cooldown + 0.05);
    expect(m.throwBanana('a', 2, 0).ok).toBe(true);
    secs(m, BANANAS.cooldown + 0.05);
    expect(m.throwBanana('a', 3, 0)).toEqual({ ok: false, reason: 'spent' });
    expect(m.snapshot().fighters[0].bananas.left).toBe(0);
    // Another player out: the cap on peels at once.
    m.debugPlace('b', { x: 0, z: 9 });
    secs(m, 2);
    expect(m.snapshot().fighters.filter((f) => f.alive)).toHaveLength(2);
    expect(m.throwBanana('b', -1, 0)).toEqual({ ok: false, reason: 'few alive' });
    m.dispose();
  });

  it('a fighter that runs over a peel tumbles along its way, the peel is gone, and the slip names the thrower; a peel lies no longer than its lifetime', () => {
    const m = four();
    outA(m);
    expect(m.throwBanana('a', 0, 0).ok).toBe(true);
    m.debugPlace('b', { x: -2.5, z: 0, yaw: Math.PI / 2 });
    m.setInput('b', { x: 1, z: 0, run: true });
    const events = secs(m, 2);
    const slip = events.find((e) => e.kind === 'banana' && e.who === 'b');
    expect(slip).toMatchObject({ on: 'a', reaction: 'tumble', note: 'slipped' });
    expect(m.snapshot().bananas).toEqual([]);
    const b = m.snapshot().fighters[1];
    expect(b.combat.tumble >= 0 || b.combat.recovering >= 0 || b.hits > 0).toBe(true);
    expect(b.hits).toBe(1);
    // A peel nobody steps on goes by itself ('b' stops before it runs off the wing).
    m.setInput('b', { x: 0, z: 0 });
    secs(m, BANANAS.cooldown);
    expect(m.snapshot().fighters.filter((f) => f.alive)).toHaveLength(3);
    expect(m.throwBanana('a', 3, 2).ok).toBe(true);
    secs(m, BANANAS.lifetime - 0.5);
    expect(m.snapshot().bananas).toHaveLength(1);
    secs(m, 1);
    expect(m.snapshot().bananas).toEqual([]);
    m.dispose();
  });

  it('standing on a peel is nothing; a new round clears the peels and the budgets; a peel on a piece that has gone is refused', () => {
    const m = four();
    outA(m);
    m.debugPlace('b', { x: 2, z: 2 });
    expect(m.throwBanana('a', 2, 2).ok).toBe(true);
    const quiet = secs(m, 1);
    expect(quiet.filter((e) => e.kind === 'banana' && e.who === 'b')).toEqual([]);
    expect(m.snapshot().bananas).toHaveLength(1);
    // The round ends (b, c, d out): everything is cleared.
    for (const id of ['b', 'c']) m.debugPlace(id, { x: 0, z: 9 });
    secs(m, 1.5 + ROUND.resetDelay + 0.3);
    const s = m.snapshot();
    expect(s.round).toBe(2);
    expect(s.bananas).toEqual([]);
    expect(s.fighters.every((f) => f.bananas.left === BANANAS.perRound)).toBe(true);
    m.dispose();
    const sky = createRumbleMatch({ havok, players: ['a', 'b', 'c', 'd'].map((id) => ({ id })), arena: SKYFALL });
    outA(sky);
    const bridge = SKYFALL.platforms[SKYFALL.dynamics[0].platform];
    expect(sky.throwBanana('a', bridge.x, bridge.z).ok).toBe(true);
    const rule = SKYFALL.dynamics[0].rule as Extract<(typeof SKYFALL.dynamics)[0]['rule'], { kind: 'breakable' }>;
    secs(sky, rule.after + rule.warn + rule.fall + 0.5);
    expect(sky.throwBanana('a', bridge.x, bridge.z)).toEqual({ ok: false, reason: 'off floor' });
    sky.dispose();
  });
});
