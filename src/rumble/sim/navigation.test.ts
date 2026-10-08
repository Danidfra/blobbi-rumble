/**
 * The bots on the whole arena, in real Havok matches (M7D). Until M7D a bot
 * in the centre would not go onto a wing: its look-ahead read the seam
 * between the slabs as a rim, so it stalled short of it, flipping between
 * its goal and the middle (from 25 starts across the centre it reached a
 * target deep in either wing 0 times); coming back it panicked on the seam,
 * and in the right wing it walked into the sweeper's post and stayed there.
 * Each case here failed before.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { rimDistance } from '../arena/layout';
import { BotInput, botWorldFrom } from '../control/bot';
import { BOT, ORBS } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { MatchSnapshot } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

interface Run {
  /** Seconds until the bot came within 1.3 m of its target (-1: never). */
  reached: number;
  fell: boolean;
  /** The bot's x over the run, sampled. */
  xs: number[];
  m: RumbleMatch;
  last: MatchSnapshot;
}

/**
 * Bot A from `start`; B either held at `target` (a fighter to chase) or
 * driven by `b`. Orbs off unless `orbs` lists the ones left on.
 */
function run(start: { x: number; z: number }, opts: { target?: { x: number; z: number }; b?: (k: number) => object; orbs?: number[]; seconds?: number; until?: (s: MatchSnapshot) => boolean }): Run {
  const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }] });
  m.debugPlace('A', start);
  m.debugPlace('B', opts.target ?? { x: 0, z: 3.4 });
  const bot = new BotInput(2);
  const xs: number[] = [];
  let reached = -1;
  let fell = false;
  for (let k = 0; k < (opts.seconds ?? 10) * 60; k++) {
    const s = m.snapshot();
    const w = botWorldFrom(s, 'A');
    (w as { orbs: unknown }).orbs = s.orbs.map((o, i) => ({ ...o, active: o.active && (opts.orbs?.includes(i) ?? false) }));
    bot.plan(w, 1 / 60);
    m.setInput('A', bot.read());
    m.setInput('B', opts.b ? opts.b(k) : {});
    m.step(1 / 60);
    if (opts.target && !opts.b) m.debugPlace('B', opts.target);
    const n = m.snapshot();
    const a = n.fighters[0];
    const t = n.fighters[1];
    if (k % 15 === 0) xs.push(a.position.x);
    if (a.eliminated) {
      fell = true;
      break;
    }
    if (reached < 0 && !opts.orbs && Math.hypot(a.position.x - t.position.x, a.position.z - t.position.z) < 1.3) reached = k / 60;
    if (opts.until?.(n)) {
      reached = k / 60;
      break;
    }
    if (reached >= 0 && !opts.until) break;
  }
  return { reached, fell, xs, m, last: m.snapshot() };
}

describe('bots cross between the centre and the wings', () => {
  for (const [name, start, target] of [
    ['centre → left wing, middle', { x: 0, z: 0.5 }, { x: -6.6, z: 0 }],
    ['centre → left wing, far corner', { x: 2, z: -3.4 }, { x: -6.8, z: 2.5 }],
    ['centre → right wing, near corner', { x: 0, z: 0 }, { x: 7.0, z: -2.6 }],
    ['centre → right wing, far corner (round the post or the notch)', { x: -1, z: 3.5 }, { x: 7.0, z: 2.6 }],
    ['left wing → centre', { x: -6.6, z: 0.5 }, { x: 0.5, z: 0 }],
    ['right wing → centre, from behind the post', { x: 6.9, z: 0.1 }, { x: -0.5, z: 0 }],
  ] as const) {
    it(name, () => {
      const r = run(start, { target });
      expect(r.fell).toBe(false);
      expect(r.reached).toBeGreaterThanOrEqual(0);
      expect(r.reached).toBeLessThan(7);
      r.m.dispose();
    });
  }

  it('pursues a fighter that walks off the centre onto a wing', () => {
    // B walks west from the centre into the left wing and stops there; A starts behind it.
    const r = run({ x: 2, z: -1 }, { b: (k) => (k < 150 ? { x: -1 } : {}), target: { x: -1, z: 0.5 }, seconds: 10, until: (s) => s.fighters[1].position.x < -4.5 && Math.hypot(s.fighters[0].position.x - s.fighters[1].position.x, s.fighters[0].position.z - s.fighters[1].position.z) < 1.3 });
    expect(r.fell).toBe(false);
    expect(r.reached).toBeGreaterThan(0);
    expect(r.last.fighters[0].position.x).toBeLessThan(-3.5);
    r.m.dispose();
  });
});

describe('bots reach the risky orbs', () => {
  it('the left orb, 0.6 m from the rim, from the centre across the seam', () => {
    // From the centre, with the other fighter far off in the opposite wing, so the orb is the bot's own choice.
    const r = run({ x: -2.5, z: -1 }, { orbs: [2], target: { x: 7.0, z: 2.6 }, seconds: 10, until: (s) => !s.orbs[2].active });
    expect(r.fell).toBe(false);
    expect(r.reached).toBeGreaterThan(0);
    expect(r.last.fighters[0].powerLevel).toBe(1);
    r.m.dispose();
  });

  it('the swept orb inside the sweeper\'s circle, from the centre (the bar may knock it about, never off)', () => {
    const r = run({ x: 2, z: 1 }, { orbs: [1], target: { x: -6.8, z: 2.5 }, seconds: 15, until: (s) => !s.orbs[1].active });
    expect(r.fell).toBe(false);
    expect(r.reached).toBeGreaterThan(0);
    expect(r.last.orbs[1].active).toBe(false);
    expect(Math.hypot(ORBS.points[1].x - 5.75, ORBS.points[1].z)).toBeLessThan(2);
    r.m.dispose();
  });
});

describe('carrying and the rim', () => {
  it('a bot carrying someone across the seam walks out to a real rim before it throws, and does not fall', () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }] });
    // At the left seam (the right one is in reach of the sweeper's bar at the start).
    m.debugPlace('A', { x: -3.4, z: 0.3, yaw: -Math.PI / 2 });
    m.debugPlace('B', { x: -4.3, z: 0.3, yaw: Math.PI / 2 });
    m.step(1 / 60);
    m.setInput('A', { grab: true });
    m.step(1 / 60);
    expect(m.snapshot().fighters[0].holding).toBe('B');
    const bot = new BotInput(2);
    let thrownAt: { x: number; z: number } | null = null;
    for (let k = 0; k < 240 && !thrownAt; k++) {
      const s = m.snapshot();
      bot.plan(botWorldFrom(s, 'A'), 1 / 60);
      m.setInput('A', bot.read());
      m.setInput('B', {});
      for (const e of m.step(1 / 60)) if (e.kind === 'throw') thrownAt = { x: s.fighters[0].position.x, z: s.fighters[0].position.z };
    }
    expect(thrownAt).not.toBeNull();
    // Before M7D the seam read as 0.3 m from the void: it threw on the spot. Now it carries out to where the void really is.
    expect(rimDistance(thrownAt!)).toBeLessThan(BOT.throwRim);
    // It started out of throwing range of any real void (the seam is not one): it had to carry first.
    expect(rimDistance({ x: -3.4, z: 0.3 })).toBeGreaterThan(BOT.throwRim);
    expect(Math.hypot(thrownAt!.x + 3.4, thrownAt!.z - 0.3)).toBeGreaterThan(0.2);
    for (let k = 0; k < 60; k++) m.step(1 / 60);
    expect(m.snapshot().fighters[0].eliminated).toBe(false);
    m.dispose();
  });

  it('edge avoidance still holds: chasing a target across the notch void, it goes round, never over', () => {
    for (const [start, target] of [
      [{ x: 3.4, z: 3.6 }, { x: 5.3, z: 2.4 }],
      [{ x: -3.4, z: -3.6 }, { x: -5.3, z: -2.4 }],
      [{ x: 5.5, z: 2.4 }, { x: 3.0, z: 3.6 }],
    ] as const) {
      const r = run(start, { target, seconds: 8 });
      expect(r.fell).toBe(false);
      expect(r.reached).toBeGreaterThanOrEqual(0);
      r.m.dispose();
    }
  });
});
