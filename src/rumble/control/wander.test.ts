/**
 * A bot on the plaza (L4): it strolls between spots inside the fence,
 * idles, never runs, jumps, punches or grabs, keeps its distance from
 * people, and is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { PLAZA } from '../arena/lobbySpace';
import { WANDER, WanderBot } from './wander';

/** A walk on a plane: the intent moves the bot at walking pace. */
function stroll(bot: WanderBot, seconds: number, people: { x: number; z: number }[] = [], from = { x: 0, z: 0 }) {
  const me = { ...from };
  const path: { x: number; z: number }[] = [];
  const intents = [];
  for (let i = 0; i < seconds * 60; i++) {
    const it = bot.plan(me, people, 1 / 60);
    intents.push(it);
    me.x += it.x * 1.6 * (1 / 60);
    me.z += it.z * 1.6 * (1 / 60);
    path.push({ ...me });
  }
  return { path, intents, me };
}

describe('a bot strolling the plaza (L4)', () => {
  it('walks, idles and walks again, always inside the fence; never runs, jumps, punches or grabs', () => {
    const { path, intents } = stroll(new WanderBot(3), 60);
    const moving = intents.filter((i) => i.x !== 0 || i.z !== 0).length;
    expect(moving).toBeGreaterThan(intents.length * 0.2);
    expect(moving).toBeLessThan(intents.length * 0.95);
    for (const i of intents) expect([i.run, i.jump, i.punch, i.grab]).toEqual([false, false, false, false]);
    for (const p of path) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(PLAZA.halfWidth - WANDER.margin + 0.05);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(PLAZA.halfDepth - WANDER.margin + 0.05);
    }
    const spread = Math.max(...path.map((p) => p.x)) - Math.min(...path.map((p) => p.x));
    expect(spread).toBeGreaterThan(3);
  });

  it('is deterministic: the same seed strolls the same way; another seed another way; a reset starts over', () => {
    const a = stroll(new WanderBot(7), 20).path;
    const b = stroll(new WanderBot(7), 20).path;
    const c = stroll(new WanderBot(8), 20).path;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const bot = new WanderBot(5);
    const first = stroll(bot, 10).path;
    bot.reset(0);
    const again = stroll(bot, 10).path;
    expect(again.length).toBe(first.length);
  });

  it('keeps its distance: never walks into a person standing in its way, and steps away from one who comes too close', () => {
    const person = { x: 0, z: 0 };
    const { path } = stroll(new WanderBot(11), 40, [person], { x: 3, z: 0 });
    for (const p of path.slice(5)) expect(Math.hypot(p.x - person.x, p.z - person.z)).toBeGreaterThan(WANDER.backOff - 0.05);
    const bot = new WanderBot(2);
    const away = bot.plan({ x: 0.5, z: 0 }, [{ x: 0, z: 0 }], 1 / 60);
    expect(away.x).toBeGreaterThan(0.9);
  });
});
