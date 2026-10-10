/**
 * REMOTE INTERPOLATION: how a network client turns authoritative states
 * that arrive about 20 times a second, unevenly, into motion drawn every
 * frame. Presentation only: nothing here reaches the server or decides
 * anything; it blends what the server already decided.
 *
 *   states ──► buffer (by server time) ──► render time = server time now − delay ──► the two states around it, blended
 *
 * The client's estimate of "server time now" comes from the states'
 * own timestamps against their arrival: the least-delayed recent arrival
 * marks the clock, smoothed, and the render time sits `delay` behind it,
 * so ordinary jitter still finds a state on each side. Continuous things
 * blend (positions, orientations, facing, velocities, tilt, combat timers
 * that run, the sweeper's angle); discrete things (in or out, power,
 * score, holds, orbs, round and phase) are the earlier state's, exactly.
 * Across a discontinuity (a round reset, a ring-out's parking, a match
 * restart, a jump no body could make) nothing blends: the earlier state
 * holds until the render time reaches the later one. Past the newest
 * state, a very short extrapolation along the authoritative velocity, then
 * a freeze.
 */
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';

export const NET_VIEW = Object.freeze({
  /** Render this far behind the estimated server time, seconds (two state intervals at 20 Hz). */
  delay: 0.1,
  /** Extrapolate past the newest state at most this long, seconds; then hold it. */
  maxExtrapolate: 0.05,
  /** A body moving between two states faster than this, m/s, (plus `teleportSlack` metres) teleported: no blend. */
  teleportSpeed: 14,
  teleportSlack: 0.3,
  /** Keep this many seconds of states behind the render time. */
  keep: 1,
  /** The clock estimate: the window its least-delayed arrival is taken over, seconds; how fast the estimate follows (1/s); a jump bigger than `clockSnap` seconds is taken at once. */
  clockWindow: 2,
  clockFollow: 2,
  clockSnap: 0.25,
});
export type NetViewTuning = { readonly [K in keyof typeof NET_VIEW]: number };

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend two angles the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/** Spherical blend of two unit quaternions, the short way round. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka = 1 - t;
  let kb = t;
  if (cos < 0.9995) {
    const theta = Math.acos(Math.min(1, cos));
    const s = Math.sin(theta);
    ka = Math.sin((1 - t) * theta) / s;
    kb = Math.sin(t * theta) / s;
  }
  const q = { x: a.x * ka + bx * kb, y: a.y * ka + by * kb, z: a.z * ka + bz * kb, w: a.w * ka + bw * kb };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** Whether a whole state change is a reset (a new round or match): nothing blends across it. */
export const isReset = (a: MatchSnapshot, b: MatchSnapshot) => a.round !== b.round || (a.phase !== 'playing' && b.phase === 'playing') || b.tick <= a.tick;

/** Whether one fighter moved continuously from `a` to `b`, `gap` seconds apart. */
export function continuous(a: FighterSnapshot, b: FighterSnapshot, gap: number, t: NetViewTuning = NET_VIEW): boolean {
  if (a.eliminated !== b.eliminated || a.eliminated) return false;
  const d = Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z);
  return d <= t.teleportSpeed * gap + t.teleportSlack;
}

/** A timer that runs from `a` to `b` (both set, not restarted) blends; otherwise it is the earlier state's. */
const timer = (a: number, b: number, k: number) => (a >= 0 && b >= a ? lerp(a, b, k) : a);

function blendFighter(a: FighterSnapshot, b: FighterSnapshot, k: number): FighterSnapshot {
  const lp = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => ({ x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), z: lerp(p.z, q.z, k) });
  return {
    ...a,
    position: lp(a.position, b.position),
    velocity: lp(a.velocity, b.velocity),
    rotation: slerp(a.rotation, b.rotation, k),
    yaw: lerpAngle(a.yaw, b.yaw, k),
    tilt: lerp(a.tilt, b.tilt, k),
    combat: {
      ...a.combat,
      punchTime: timer(a.combat.punchTime, b.combat.punchTime, k),
      tumble: timer(a.combat.tumble, b.combat.tumble, k),
      recovering: timer(a.combat.recovering, b.combat.recovering, k),
      holdTime: timer(a.combat.holdTime, b.combat.holdTime, k),
      holdAngle: a.combat.holdTime >= 0 && b.combat.holdTime >= 0 ? lerpAngle(a.combat.holdAngle, b.combat.holdAngle, k) : a.combat.holdAngle,
    },
  };
}

/**
 * The match `k` of the way (0..1) from state `a` to state `b`: continuous
 * things blended, discrete things `a`'s. Across a reset, or for a fighter
 * that did not move continuously, `a` itself.
 */
export function interpolate(a: MatchSnapshot, b: MatchSnapshot, k: number, t: NetViewTuning = NET_VIEW): MatchSnapshot {
  if (k <= 0 || isReset(a, b)) return a;
  const gap = b.time - a.time;
  return {
    ...a,
    fighters: a.fighters.map((f, i) => (continuous(f, b.fighters[i], gap, t) ? blendFighter(f, b.fighters[i], k) : f)),
    sweeper: a.sweeper && b.sweeper ? { ...a.sweeper, angle: lerpAngle(a.sweeper.angle, b.sweeper.angle, k) } : b.sweeper,
    arena: b.arena,
    pieces: b.pieces,
    roundTime: b.roundTime,
  };
}

/** The match `dt` seconds past state `s`, extrapolated along its velocities (bodies in play only), the sweeper along its turn. */
export function extrapolate(s: MatchSnapshot, dt: number): MatchSnapshot {
  if (dt <= 0) return s;
  return {
    ...s,
    fighters: s.fighters.map((f) =>
      f.eliminated ? f : { ...f, position: { x: f.position.x + f.velocity.x * dt, y: f.position.y + (f.grounded ? 0 : f.velocity.y * dt), z: f.position.z + f.velocity.z * dt } },
    ),
    sweeper: s.sweeper ? { ...s.sweeper, angle: s.sweeper.angle + s.sweeper.angularSpeed * dt } : null,
  };
}

export interface Sample {
  snapshot: MatchSnapshot;
  /** The server time drawn, seconds. */
  renderTime: number;
  /** States held newer than the render time (2 or so is healthy; 0 means extrapolating or frozen). */
  ahead: number;
  /** How far past the newest state the render time is, seconds (0 while interpolating). */
  late: number;
  /** Whether this frame extrapolated. */
  extrapolated: boolean;
}

interface Entry {
  snapshot: MatchSnapshot;
  /** Server time minus arrival time: larger is less delayed. */
  lead: number;
  arrival: number;
}

/** The states a client holds, in server-time order, and the clock that says which moment to draw. */
export class SnapshotBuffer {
  private readonly entries: Entry[] = [];
  private offset: number | null = null;
  private lastSample = 0;

  constructor(private readonly t: NetViewTuning = NET_VIEW) {}

  get size() {
    return this.entries.length;
  }
  get newest(): MatchSnapshot | null {
    return this.entries.at(-1)?.snapshot ?? null;
  }
  /** The estimated server time minus the client clock, seconds. */
  get clockOffset() {
    return this.offset;
  }

  /** A state arrived at `arrival` (client seconds). Older or repeated ticks are refused: false. */
  push(s: MatchSnapshot, arrival: number): boolean {
    const last = this.entries.at(-1);
    if (last && s.tick <= last.snapshot.tick) return false;
    this.entries.push({ snapshot: s, lead: s.time - arrival, arrival });
    if (this.offset === null) this.offset = s.time - arrival;
    return true;
  }

  /** What to draw at client time `now` (seconds). */
  sample(now: number): Sample | null {
    const t = this.t;
    if (this.entries.length === 0) return null;
    // The clock: follow the least-delayed arrival of the last window, smoothly; take a big jump at once.
    let best = -Infinity;
    for (const e of this.entries) if (now - e.arrival <= t.clockWindow) best = Math.max(best, e.lead);
    if (best > -Infinity && this.offset !== null) {
      const d = best - this.offset;
      const dt = Math.max(0, Math.min(0.1, now - this.lastSample));
      this.offset = Math.abs(d) > t.clockSnap ? best : this.offset + d * Math.min(1, dt * t.clockFollow);
    }
    this.lastSample = now;
    const renderTime = now + (this.offset ?? 0) - t.delay;
    // Forget what is well behind the render time (keeping one before it).
    while (this.entries.length > 2 && this.entries[1].snapshot.time < renderTime - t.keep) this.entries.shift();
    const es = this.entries;
    let i = es.length - 1;
    while (i > 0 && es[i].snapshot.time > renderTime) i--;
    const a = es[i].snapshot;
    const ahead = es.length - 1 - i;
    if (a.time > renderTime) return { snapshot: a, renderTime, ahead: es.length, late: 0, extrapolated: false };
    if (i === es.length - 1) {
      const late = renderTime - a.time;
      return { snapshot: extrapolate(a, Math.min(late, t.maxExtrapolate)), renderTime, ahead: 0, late, extrapolated: late > 0 };
    }
    const b = es[i + 1].snapshot;
    const k = (renderTime - a.time) / (b.time - a.time);
    return { snapshot: interpolate(a, b, Math.max(0, Math.min(1, k)), t), renderTime, ahead, late: 0, extrapolated: false };
  }
}
