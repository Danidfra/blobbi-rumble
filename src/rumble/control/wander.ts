/**
 * A BOT ON THE PLAZA (L4): not the match's test opponent, just a Blobbi
 * strolling about the social lobby. It walks to a spot, idles a few
 * seconds, picks another; it never runs, never jumps, never punches or
 * grabs (the plaza would drop those anyway), and keeps its distance from
 * people: it does not walk into anyone, and steps away from someone who
 * comes too close. Deterministic: the same seed and the same world make
 * the same stroll (no `Math.random`, no clock). Pure: it reads positions,
 * returns an intent in world directions, exactly what a person's input is.
 */
import { insidePlaza } from '../arena/lobbySpace';
import type { Planar } from '../arena/layout';
import type { PlayerIntent } from '../sim/intent';

export const WANDER = Object.freeze({
  /** Close enough to the spot, metres. */
  arrive: 0.35,
  /** The idle between strolls, seconds (min, extra). */
  idle: 1.5,
  idleExtra: 3,
  /** The longest a stroll may take before it picks again (blocked by someone), seconds. */
  giveUp: 6,
  /** Spots stay this far inside the fence, metres. */
  margin: 1.2,
  /** Nobody closer than this, metres: it stops short of them, and steps away when they come closer still. */
  personal: 1.4,
  backOff: 0.9,
});

const STILL: PlayerIntent = Object.freeze({ x: 0, z: 0, run: false, jump: false, punch: false, grab: false });

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WanderBot {
  private next: () => number;
  private target: Planar | null = null;
  private wait: number;
  private walking = 0;

  constructor(private readonly seed: number) {
    this.next = rng(seed);
    this.wait = 0.5 + this.next() * 2;
  }

  /** Start over (a new lobby): the same seed, the same stroll. */
  reset(salt = 0) {
    this.next = rng(this.seed * 7919 + salt);
    this.target = null;
    this.wait = 0.5 + this.next() * 2;
    this.walking = 0;
  }

  /** The intent for this step, from where it stands and where the people are. */
  plan(me: Planar, people: readonly Planar[], dt: number): PlayerIntent {
    // Someone too close: step straight away from the nearest.
    let near: Planar | null = null;
    let nearD = Infinity;
    for (const p of people) {
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      if (d < nearD) {
        nearD = d;
        near = p;
      }
    }
    if (near && nearD < WANDER.backOff) {
      const len = nearD || 1;
      this.target = null;
      this.wait = WANDER.idle;
      return { ...STILL, x: (me.x - near.x) / len || 1, z: (me.z - near.z) / len };
    }
    if (!this.target) {
      this.wait -= dt;
      if (this.wait > 0) return STILL;
      this.target = insidePlaza({ x: (this.next() * 2 - 1) * 10, z: (this.next() * 2 - 1) * 10 }, WANDER.margin);
      this.walking = 0;
    }
    this.walking += dt;
    const dx = this.target.x - me.x;
    const dz = this.target.z - me.z;
    const dist = Math.hypot(dx, dz);
    // Arrived, given up, or about to walk into someone: idle a while.
    const blocked = !!near && nearD < WANDER.personal && (near.x - me.x) * dx + (near.z - me.z) * dz > 0;
    if (dist < WANDER.arrive || this.walking > WANDER.giveUp || blocked) {
      this.target = null;
      this.wait = WANDER.idle + this.next() * WANDER.idleExtra;
      return STILL;
    }
    return { ...STILL, x: dx / dist, z: dz / dist };
  }
}
