/**
 * POWER ORBS, as pure state: each lives at a fixed point, is either there
 * or on its way back, and is taken by the fighter who comes within reach.
 * Positions are gameplay positions (capsule centres), never anything of a
 * Blobbi's look. The scene draws this; it decides nothing.
 */
import { ORBS } from '../tuning';

export type OrbTuning = typeof ORBS;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Orb {
  x: number;
  y: number;
  z: number;
  /** There to be taken. */
  active: boolean;
  /** Seconds until it returns, while not active. */
  timer: number;
}

export const createOrbs = (t: OrbTuning = ORBS): Orb[] => t.points.map((p) => ({ x: p.x, y: t.height, z: p.z, active: true, timer: 0 }));

/** All back in place, as at the start of a round. */
export function resetOrbs(orbs: Orb[]) {
  for (const o of orbs) {
    o.active = true;
    o.timer = 0;
  }
}

const dist = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Who takes which orb this frame: for each active orb within reach of
 * anyone, the NEAREST fighter takes it (the lower index on an exact tie),
 * so two arriving together never both collect. Returns, per orb, the
 * taker's index or -1, and marks the taken orbs as gone.
 */
export function collectOrbs(orbs: Orb[], fighters: readonly Point3[], t: OrbTuning = ORBS): number[] {
  return orbs.map((o) => {
    if (!o.active) return -1;
    let taker = -1;
    let best: number = t.collectRadius;
    fighters.forEach((f, i) => {
      const d = dist(o, f);
      if (d < best || (d === best && taker < 0 && d <= t.collectRadius)) {
        best = d;
        taker = i;
      }
    });
    if (taker < 0) return -1;
    o.active = false;
    o.timer = t.respawnDelay;
    return taker;
  });
}

/**
 * Advance the orbs that are away: when one's time is up it returns, unless
 * a fighter stands on its point, in which case it waits for the point to
 * clear (so it never lands in someone and awards itself). Returns the
 * indices of the orbs that came back this frame.
 */
export function tickOrbs(orbs: Orb[], dt: number, fighters: readonly Point3[], t: OrbTuning = ORBS): number[] {
  const back: number[] = [];
  orbs.forEach((o, i) => {
    if (o.active) return;
    o.timer = Math.max(0, o.timer - dt);
    if (o.timer > 0) return;
    const occupied = fighters.some((f) => Math.hypot(f.x - o.x, f.z - o.z) < t.occupiedRadius);
    if (occupied) return;
    o.active = true;
    back.push(i);
  });
  return back;
}
