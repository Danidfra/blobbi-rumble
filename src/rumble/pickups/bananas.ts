/**
 * BANANA PEELS (M11F), as pure state: what the eliminated may throw, what
 * the server accepts, where a peel lies, how long, and who slips on it.
 * The match owns the fighters and the floor; this decides.
 */
import type { Platform } from '../arena/geometry';
import { onAnyFloor, platformUnder } from '../arena/geometry';
import { BANANAS } from '../tuning';

export type BananaTuning = typeof BANANAS;

export interface Banana {
  x: number;
  y: number;
  z: number;
  /** The thrower's fighter index. */
  owner: number;
  /** Seconds on the floor. */
  age: number;
}

export interface Thrower {
  /** Throws made this round, and seconds since the last. */
  thrown: number;
  since: number;
}

export const createThrowers = (n: number): Thrower[] => Array.from({ length: n }, () => ({ thrown: 0, since: 99 }));

export function resetThrowers(ts: Thrower[]) {
  for (const t of ts) {
    t.thrown = 0;
    t.since = 99;
  }
}

export type ThrowRefusal = 'phase' | 'in play' | 'few alive' | 'cooldown' | 'spent' | 'crowded' | 'off floor' | 'bad target';

export interface ThrowContext {
  playing: boolean;
  /** Whether the thrower is out of the round. */
  eliminated: boolean;
  alive: number;
  platforms: readonly Platform[];
  /** A platform that cannot bear a peel now (a piece that is falling or gone). */
  unusable?: (platformIndex: number) => boolean;
}

/** Whether this throw is allowed, and the peel it makes if so. */
export function judgeThrow(t: Thrower, active: number, x: unknown, z: unknown, c: ThrowContext, tuning: BananaTuning = BANANAS): { ok: true; banana: Omit<Banana, 'owner'> } | { ok: false; reason: ThrowRefusal } {
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'bad target' };
  if (!c.playing) return { ok: false, reason: 'phase' };
  if (!c.eliminated) return { ok: false, reason: 'in play' };
  if (c.alive < tuning.minAlive) return { ok: false, reason: 'few alive' };
  if (t.thrown >= tuning.perRound) return { ok: false, reason: 'spent' };
  if (t.since < tuning.cooldown) return { ok: false, reason: 'cooldown' };
  if (active >= tuning.maxActive) return { ok: false, reason: 'crowded' };
  const p = { x, z };
  if (!onAnyFloor(c.platforms, p, 0.2)) return { ok: false, reason: 'off floor' };
  const under = platformUnder(c.platforms, p);
  const index = under ? c.platforms.indexOf(under) : -1;
  if (!under || c.unusable?.(index)) return { ok: false, reason: 'off floor' };
  return { ok: true, banana: { x, y: under.y + tuning.height, z, age: 0 } };
}

/** Peels age, and the oldest go when they have lain long enough; throwers' cooldowns run. Returns the indices removed. */
export function tickBananas(bananas: Banana[], throwers: Thrower[], dt: number, tuning: BananaTuning = BANANAS): number[] {
  for (const t of throwers) t.since += dt;
  const gone: number[] = [];
  for (let i = bananas.length - 1; i >= 0; i--) {
    bananas[i].age += dt;
    if (bananas[i].age >= tuning.lifetime) {
      bananas.splice(i, 1);
      gone.push(i);
    }
  }
  return gone;
}

export interface Walker {
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  /** Speed in the plane, m/s. */
  speed: number;
  /** Whether a slip could take it now: on its feet, free, grounded, in the round. */
  canSlip: boolean;
}

/** Which peel (index) each walker slips on, or -1: the first peel under its feet while it moves. */
export function slips(bananas: readonly Banana[], walkers: readonly (Walker | null)[], tuning: BananaTuning = BANANAS): number[] {
  const taken = new Set<number>();
  return walkers.map((w) => {
    if (!w || !w.canSlip || w.speed < tuning.minSpeed) return -1;
    for (let i = 0; i < bananas.length; i++) {
      if (taken.has(i)) continue;
      const b = bananas[i];
      if (Math.hypot(w.x - b.x, w.z - b.z) <= tuning.radius && Math.abs(w.y - (b.y - tuning.height)) < 0.4) {
        taken.add(i);
        return i;
      }
    }
    return -1;
  });
}
