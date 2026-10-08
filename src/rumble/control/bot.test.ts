/**
 * The local test bot, as plain numbers: what it goes for, when it strikes,
 * that it steers off the void and jumps the sweeper, that it does the same
 * thing given the same world, and that it plays with no more than a person
 * has (it only ever answers with an intent).
 */
import { describe, expect, it } from 'vitest';
import { onFloor } from '../arena/layout';
import { createCombatState, startTumble } from '../combat/combat';
import { createOrbs } from '../pickups/orbs';
import { BOT, SWEEPER } from '../tuning';
import { aroundPost, bestOrb, BotInput, clearOfPost, createBotMemory, nearestFighter, nextRandom, safeDirection, sweeperArrival, think, voidDirection, type BotFighter, type BotWorld } from './bot';

const east = { x: 1, z: 0 };
const west = { x: -1, z: 0 };
const body = (x: number, z = 0, facing = east): BotFighter => ({ at: { x, z }, facing, active: true, combat: createCombatState(), powerLevel: 0, holder: -1 });
const world = (fighters: BotFighter[], self = 0, orbs = createOrbs().map((o) => ({ ...o, active: false }))): BotWorld => ({ self, fighters, orbs, sweeperAngle: Math.PI / 2, grounded: true });
const frames = (m: ReturnType<typeof createBotMemory>, w: BotWorld, n: number) => {
  let out = think(m, w, 1 / 60);
  for (let i = 1; i < n; i++) out = think(m, w, 1 / 60);
  return out;
};

describe('the test bot', () => {
  it('goes for the nearest other fighter in the round', () => {
    const w = world([body(0), body(3), body(-2), body(1.5)]);
    expect(nearestFighter(w)).toBe(3);
    w.fighters[3].active = false;
    expect(nearestFighter(w)).toBe(2);
    const intent = think(createBotMemory(1), w, 1 / 60);
    expect(intent.x).toBeLessThan(0);
  });

  it('from the symmetric spawns, a near-tie is settled by a seat order the bot draws, never always by the lowest index', () => {
    const corners = [body(-2.2, -2.2), body(2.2, -2.2), body(-2.2, 2.2), body(2.2, 2.2)];
    // P3 (back left) is as near to P1 as to P4: which one depends on the drawn offset, and both happen.
    const choices = new Set([0, 1, 2, 3].map((offset) => nearestFighter(world(corners, 2), offset)));
    expect(choices).toEqual(new Set([0, 3]));
    // The same offset, the same pick.
    expect(nearestFighter(world(corners, 2), 1)).toBe(nearestFighter(world(corners, 2), 1));
    // A real difference wins over any seat order.
    const nearer = [body(-2.2, -2.2), body(2.2, -2.2), body(-2.2, 2.2), body(1.9, 2.2)];
    for (const offset of [0, 1, 2, 3]) expect(nearestFighter(world(nearer, 2), offset)).toBe(3);
    // Over the bots and their draws, every fighter ends up somebody's first target.
    const targeted = new Set<number>();
    for (let seed = 1; seed <= 12; seed++)
      for (let self = 0; self < 4; self++) {
        const m = createBotMemory(seed * 4 + self);
        think(m, world(corners, self), 1 / 60);
        targeted.add(m.target);
      }
    expect(targeted).toEqual(new Set([0, 1, 2, 3]));
  });

  it('prefers a near orb to a far fight, and counts the sweeper and the rim against an orb', () => {
    const orbs = createOrbs();
    const w = world([body(-1.5, 0), body(-2.2, -3.0)], 0, orbs);
    const pick = bestOrb(w);
    expect(pick.orb).toBe(0);
    const m = createBotMemory(1);
    const intent = think(m, w, 1 / 60);
    expect(m.state).toBe('SEEK_ORB');
    expect(intent.x).toBeGreaterThan(0.9);
    // Standing in the right wing beside the swept orb, the sweeper still makes it cost more than its distance.
    const wing = world([body(4.5, -1.3), body(-3, 2)], 0, orbs);
    expect(bestOrb(wing).cost).toBeGreaterThan(Math.hypot(orbs[1].x - 4.5, orbs[1].z + 1.3) + BOT.orbSweeperCost - 1e-9);
    // At the power cap it no longer wants orbs.
    w.fighters[0].powerLevel = 6;
    expect(bestOrb(w).orb).toBe(-1);
  });

  it('punches a target in reach that it faces, then hesitates before the next attack', () => {
    const w = world([body(0, 0, east), body(0.95, 0, west)]);
    const m = createBotMemory(3);
    // Find the first frame it strikes; grabs are a share of openings, punches the rest.
    let first = null;
    for (let i = 0; i < 10 && !first; i++) {
      const it = think(m, w, 1 / 60);
      if (it.punch || it.grab) first = it;
    }
    expect(first).not.toBeNull();
    expect(m.state).toBe('ATTACK');
    expect(m.wait).toBeGreaterThanOrEqual(BOT.hesitation);
    // During the hesitation, no second attack.
    const again = think(m, w, 1 / 60);
    expect(again.punch || again.grab).toBe(false);
  });

  it('does not strike what it does not face, nor what is out of reach', () => {
    const behind = world([body(0, 0, east), body(-0.95, 0)]);
    const m = createBotMemory(3);
    for (let i = 0; i < 30; i++) {
      const it = think(m, behind, 1 / 60);
      expect(it.punch || it.grab).toBe(false);
    }
    const far = world([body(0, 0, east), body(1.4, 0)]);
    const m2 = createBotMemory(3);
    for (let i = 0; i < 30; i++) expect(think(m2, far, 1 / 60).punch).toBe(false);
  });

  it('grabs a share of its openings from a seeded sequence: the same seed, the same choices', () => {
    const run = (seed: number) => {
      const m = createBotMemory(seed);
      const picks: string[] = [];
      for (let k = 0; k < 40; k++) {
        m.wait = 0;
        const it = think(m, world([body(0, 0, east), body(0.95, 0, west)]), 1 / 60);
        picks.push(it.grab ? 'g' : it.punch ? 'p' : '-');
      }
      return picks.join('');
    };
    expect(run(7)).toBe(run(7));
    const s = run(7);
    const grabs = [...s].filter((c) => c === 'g').length;
    expect(grabs).toBeGreaterThan(2);
    expect(grabs).toBeLessThan(25);
    const m = createBotMemory(5);
    const xs = Array.from({ length: 200 }, () => nextRandom(m));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it('carries a held body toward the nearest void, then throws it', () => {
    const me = body(0, 2.5, { x: 0, z: 1 });
    me.combat.holding = 0.1;
    me.combat.victim = 1;
    const w = world([me, body(0, 3.4)]);
    const m = createBotMemory(1);
    const intent = think(m, w, 1 / 60);
    expect(m.state).toBe('CARRY');
    expect(intent.z).toBeGreaterThan(0);
    expect(voidDirection(me.at).z).toBeCloseTo(1);
    // Facing out, near the rim, after the shortest carry: the throw.
    const out = frames(m, w, Math.ceil(BOT.carryMin * 60) + 2);
    expect(out.grab).toBe(true);
    // And it never carries forever.
    const m2 = createBotMemory(1);
    const lost = world([{ ...me, at: { x: 0, z: 0 }, facing: { x: 1, z: 0 } }, body(0.9, 0)]);
    lost.fighters[0].combat.holding = 0.1;
    let thrown = false;
    for (let i = 0; i < (BOT.carryMax + 0.2) * 60 && !thrown; i++) thrown = think(m2, lost, 1 / 60).grab;
    expect(thrown).toBe(true);
  });

  it('turns away from the void: never walks straight over a rim, and heads back from one', () => {
    // At the north rim of the centre, a target beyond it: the step it takes stays on the floor.
    const at = { x: 0, z: 3.4 };
    const out = safeDirection(at, { x: 0, z: 1 }, BOT.lookAhead);
    expect(onFloor({ x: at.x + out.x, z: at.z + out.z })).toBe(true);
    expect(out.z).toBeLessThan(0);
    // Inside the floor, a safe direction is left alone.
    expect(safeDirection({ x: 0, z: 0 }, east, BOT.lookAhead)).toEqual(east);
    // Standing near the rim with nothing to do: back toward the middle.
    const m = createBotMemory(1);
    const intent = think(m, world([body(0, 3.7), body(0, -3)]), 1 / 60);
    expect(m.state).toBe('RECOVER');
    expect(intent.z).toBeLessThan(0);
  });

  it('down, stunned or held: whatever control is left goes toward the middle, and it attacks nothing', () => {
    const me = body(2, 0);
    startTumble(me.combat);
    const m = createBotMemory(1);
    const intent = think(m, world([me, body(2.9, 0)]), 1 / 60);
    expect(m.state).toBe('RECOVER');
    expect(intent.x).toBeLessThan(0);
    expect(intent.punch || intent.grab || intent.jump).toBe(false);
  });

  it('knows when the sweeper\'s leading face arrives, and jumps it just before', () => {
    const p = SWEEPER.pivot;
    // At angle 0 the bar lies along +x and its +x arm moves toward -z: a capsule at -z on that side is next.
    const r = 1.6;
    const at = { x: p.x + r * Math.cos(-0.5), z: p.z + r * Math.sin(-0.5) };
    const t0 = sweeperArrival(0, at);
    expect(t0).toBeGreaterThan(0);
    expect(t0).toBeLessThan(0.5 / SWEEPER.angularSpeed);
    // A moment later it is that much closer.
    expect(sweeperArrival(SWEEPER.angularSpeed * 0.1, at)).toBeCloseTo(t0 - 0.1, 5);
    // Out of reach: never.
    expect(sweeperArrival(0, { x: p.x + SWEEPER.reach + 1, z: p.z })).toBe(Infinity);
    // Inside the jump window it jumps; well before it, it does not.
    const angleFor = (t: number) => SWEEPER.angularSpeed * (t0 - t);
    const w = world([body(at.x, at.z), body(-3, 0)]);
    w.sweeperAngle = angleFor((BOT.jumpWindow.from + BOT.jumpWindow.to) / 2);
    expect(think(createBotMemory(1), w, 1 / 60).jump).toBe(true);
    w.sweeperAngle = angleFor(0.6);
    expect(think(createBotMemory(1), w, 1 / 60).jump).toBe(false);
    // Not from the air.
    w.sweeperAngle = angleFor((BOT.jumpWindow.from + BOT.jumpWindow.to) / 2);
    expect(think(createBotMemory(1), { ...w, grounded: false }, 1 / 60).jump).toBe(false);
  });

  it('an eliminated bot does nothing; as an intent source it fires its actions once, and nothing while disabled', () => {
    const w = world([body(0), body(0.95, 0, west)]);
    w.fighters[0].active = false;
    expect(think(createBotMemory(1), w, 1 / 60)).toMatchObject({ x: 0, z: 0, punch: false, grab: false, jump: false });
    const input = new BotInput(2);
    const live = world([body(0, 0, east), body(0.95, 0, west)]);
    let fired = null;
    for (let i = 0; i < 10 && !fired; i++) {
      input.plan(live, 1 / 60);
      const it = input.read();
      if (it.punch || it.grab) fired = it;
    }
    expect(fired).not.toBeNull();
    const after = input.read();
    expect(after.punch || after.grab).toBe(false);
    input.enabled = false;
    input.plan(live, 1 / 60);
    expect(input.read()).toMatchObject({ x: 0, z: 0, punch: false, grab: false });
  });

  it('rounds differ, and the same round goes the same way', () => {
    const a = new BotInput(3);
    const b = new BotInput(3);
    a.reset(2);
    b.reset(2);
    expect(a.memory).toEqual(b.memory);
    b.reset(3);
    expect(a.memory.rng).not.toBe(b.memory.rng);
  });

  it('looks ahead across the seams onto the wings and back, as onto any floor; real rims still turn it', () => {
    // Walking from the centre onto either wing, and back: straight on.
    for (const [at, dir] of [
      [{ x: 3.2, z: 0.5 }, east],
      [{ x: -3.2, z: -0.5 }, west],
      [{ x: 4.5, z: 1 }, west],
      [{ x: -4.5, z: 2 }, east],
    ] as const) expect(safeDirection(at, dir, BOT.lookAhead)).toEqual(dir);
    // Off the wing's far end, the front edge, the centre's side beyond the wing: turned away.
    expect(safeDirection({ x: 6.8, z: 0 }, east, BOT.lookAhead)).not.toEqual(east);
    expect(safeDirection({ x: 5.5, z: 2.4 }, { x: 0, z: 1 }, BOT.lookAhead).z).toBeLessThan(1);
    expect(safeDirection({ x: 3.6, z: 3.5 }, east, BOT.lookAhead)).not.toEqual(east);
  });

  it('steers round the sweeper\'s post instead of into it, on the side nearer its goal', () => {
    const p = SWEEPER.pivot;
    // Walking along the right wing's middle toward the centre, the post dead ahead.
    expect(clearOfPost({ x: p.x + 1.2, z: p.z }, west, BOT.lookAhead)).toBe(false);
    const turned = safeDirection({ x: p.x + 1.2, z: p.z + 0.05 }, west, BOT.lookAhead);
    expect(turned).not.toEqual(west);
    expect(clearOfPost({ x: p.x + 1.2, z: p.z + 0.05 }, turned, BOT.lookAhead)).toBe(true);
    // Pressed against it: slide round, still making way toward the goal.
    const slide = aroundPost({ x: p.x + 0.66, z: p.z - 0.05 }, west)!;
    expect(slide).not.toBeNull();
    expect(slide.x).toBeLessThan(0.5);
    expect(Math.abs(slide.z)).toBeGreaterThan(0.6);
    // Moving away from it, or far from it: the post is not in the way.
    expect(aroundPost({ x: p.x + 0.66, z: p.z }, east)).toBeNull();
    expect(aroundPost({ x: 0, z: 0 }, east)).toBeNull();
  });
});
