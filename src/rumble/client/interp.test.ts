/**
 * Remote interpolation, as plain numbers: the buffer orders and refuses
 * states, the render time sits behind the server's, continuous things blend
 * (positions, quaternions, angles, running timers), discrete things never
 * do, resets and teleports snap, and extrapolation is short and bounded.
 */
import { describe, expect, it } from 'vitest';
import type { FighterSnapshot, MatchSnapshot } from '../sim/snapshot';
import { continuous, extrapolate, interpolate, lerpAngle, NET_VIEW, slerp, SnapshotBuffer } from './interp';

const fighter = (id: string, x: number, z = 0, extra: Partial<FighterSnapshot> = {}): FighterSnapshot => ({
  id,
  position: { x, y: 0.525, z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  upright: true,
  yaw: 0,
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true,
  alive: true,
  eliminated: false,
  score: 0,
  powerLevel: 0,
  combat: { punchTime: -1, punchCooldown: 0, stun: 0, tumble: -1, recovering: -1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 },
  holding: null,
  heldBy: null,
  touching: null,
  tilt: 0,
  lastImpact: 0,
  hits: 0,
  jumps: 0,
  escapes: 0,
  ...extra,
});
const snap = (tick: number, fighters: FighterSnapshot[], extra: Partial<MatchSnapshot> = {}): MatchSnapshot => ({
  tick,
  time: tick / 60,
  players: fighters.map((f) => f.id),
  fighters,
  phase: 'playing',
  round: 1,
  roundTimer: 0,
  target: 3,
  lastRoundWinner: null,
  matchWinner: null,
  orbs: [{ x: 0, y: 0.6, z: 0, active: true, timer: 0 }],
  sweeper: { angle: 0, angularSpeed: 1.5 },
  ...extra,
});

describe('blending', () => {
  it('positions and velocities blend linearly; facing and the sweeper blend the short way round', () => {
    const a = snap(3, [fighter('A', 0, 0, { yaw: Math.PI - 0.1, velocity: { x: 1, y: 0, z: 0 } })], { sweeper: { angle: 2 * Math.PI - 0.1, angularSpeed: 1.5 } });
    const b = snap(6, [fighter('A', 0.2, 0.1, { yaw: -Math.PI + 0.1, velocity: { x: 3, y: 0, z: 0 } })], { sweeper: { angle: 0.1, angularSpeed: 1.5 } });
    const m = interpolate(a, b, 0.5);
    expect(m.fighters[0].position.x).toBeCloseTo(0.1);
    expect(m.fighters[0].position.z).toBeCloseTo(0.05);
    expect(m.fighters[0].velocity.x).toBeCloseTo(2);
    // Across ±π, not through 0.
    expect(Math.abs(Math.cos(m.fighters[0].yaw) + 1)).toBeLessThan(1e-9);
    expect(Math.sin(m.sweeper.angle)).toBeCloseTo(0);
    expect(Math.cos(m.sweeper.angle)).toBeCloseTo(1);
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0);
  });

  it('orientations blend spherically, unit length, the short way round', () => {
    const half = Math.SQRT1_2;
    const id = { x: 0, y: 0, z: 0, w: 1 };
    const quarter = { x: half, y: 0, z: 0, w: half }; // 90° about x
    const q = slerp(id, quarter, 0.5);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1);
    expect(2 * Math.acos(q.w)).toBeCloseTo(Math.PI / 4); // 45°
    // The same rotation written with the opposite sign blends the same way.
    const neg = slerp(id, { x: -half, y: 0, z: 0, w: -half }, 0.5);
    expect(Math.abs(neg.x)).toBeCloseTo(Math.abs(q.x));
    expect(slerp(quarter, quarter, 0.3)).toEqual(expect.objectContaining({ x: expect.closeTo(half), w: expect.closeTo(half) }));
  });

  it('discrete state is the earlier state\'s, exactly, never a fraction', () => {
    const a = snap(3, [fighter('A', 0, 0, { powerLevel: 1, score: 0, holding: null, alive: true, hits: 2 })], { orbs: [{ x: 0, y: 0.6, z: 0, active: true, timer: 0 }] });
    const b = snap(6, [fighter('A', 0.1, 0, { powerLevel: 2, score: 1, holding: 'B', alive: true, hits: 3 })], { orbs: [{ x: 0, y: 0.6, z: 0, active: false, timer: 5 }], phase: 'roundOver', lastRoundWinner: 'A' });
    const m = interpolate(a, b, 0.9);
    expect(m.fighters[0].powerLevel).toBe(1);
    expect(m.fighters[0].score).toBe(0);
    expect(m.fighters[0].holding).toBeNull();
    expect(m.fighters[0].hits).toBe(2);
    expect(m.orbs[0].active).toBe(true);
    expect(m.phase).toBe('playing');
    expect(m.lastRoundWinner).toBeNull();
    expect(m.fighters[0].position.x).toBeCloseTo(0.09);
  });

  it('a timer that runs blends; one that starts, stops or restarts is the earlier state\'s', () => {
    const a = snap(3, [fighter('A', 0, 0, { combat: { punchTime: 0.05, punchCooldown: 0.5, stun: 0, tumble: -1, recovering: -1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 } })]);
    const b = snap(6, [fighter('A', 0, 0, { combat: { punchTime: 0.1, punchCooldown: 0.45, stun: 0, tumble: 0.02, recovering: -1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 } })]);
    const m = interpolate(a, b, 0.5).fighters[0].combat;
    expect(m.punchTime).toBeCloseTo(0.075);
    expect(m.tumble).toBe(-1);
  });
});

describe('discontinuities', () => {
  it('a round reset, a match restart and a ring-out\'s parking do not blend: the earlier state holds', () => {
    const playing = snap(300, [fighter('A', 3, 2)], { round: 2 });
    const reset = snap(303, [fighter('A', -2.2, -2.2)], { round: 3 });
    expect(interpolate(playing, reset, 0.7)).toBe(playing);
    const over = snap(303, [fighter('A', 3, 2)], { phase: 'matchOver' });
    const restart = snap(306, [fighter('A', -2.2, -2.2)], { phase: 'playing' });
    expect(interpolate(over, restart, 0.5)).toBe(over);
    const parked = snap(306, [fighter('A', 0, 0, { eliminated: true, position: { x: 0, y: -40, z: 0 } })]);
    expect(interpolate(playing, parked, 0.5).fighters[0].position.x).toBe(3);
  });

  it('a body that moved further than any body can between two states teleported: no blend', () => {
    const a = fighter('A', 0, 0);
    expect(continuous(a, fighter('A', 0.5, 0), 0.05)).toBe(true);
    expect(continuous(a, fighter('A', 1.2, 0), 0.05)).toBe(false);
    expect(continuous(a, fighter('A', 1.2, 0), 0.1)).toBe(true);
  });
});

describe('the buffer', () => {
  /** States 50 ms apart arriving `lag` ms after their server time, plus jitter. */
  const fill = (buf: SnapshotBuffer, n: number, lag = 0.03, jitter: (i: number) => number = () => 0) => {
    for (let i = 1; i <= n; i++) buf.push(snap(i * 3, [fighter('A', i * 0.1)]), (i * 3) / 60 + lag + jitter(i));
  };

  it('refuses stale and repeated states and keeps server-time order', () => {
    const buf = new SnapshotBuffer();
    expect(buf.push(snap(6, [fighter('A', 0)]), 1)).toBe(true);
    expect(buf.push(snap(3, [fighter('A', 0)]), 1.01)).toBe(false);
    expect(buf.push(snap(6, [fighter('A', 0)]), 1.02)).toBe(false);
    expect(buf.push(snap(9, [fighter('A', 0)]), 1.03)).toBe(true);
    expect(buf.newest?.tick).toBe(9);
  });

  it('draws the moment `delay` behind the server, between the two states around it, with states to spare', () => {
    const buf = new SnapshotBuffer();
    fill(buf, 20);
    const lastArrival = (20 * 3) / 60 + 0.03;
    const s = buf.sample(lastArrival)!;
    // Server time "now" is the newest state's time (arrivals all 30 ms late): render 100 ms before it.
    expect(s.renderTime).toBeCloseTo(1.0 - NET_VIEW.delay, 3);
    expect(s.extrapolated).toBe(false);
    expect(s.ahead).toBe(2);
    // x grows 0.1 per state (per 50 ms): at server time 0.9 it is 1.8.
    expect(s.snapshot.fighters[0].position.x).toBeCloseTo(1.8, 3);
    // A frame later, a little further, smoothly.
    const s2 = buf.sample(lastArrival + 1 / 60)!;
    expect(s2.snapshot.fighters[0].position.x).toBeCloseTo(1.8 + 0.1 / 3, 3);
  });

  it('jitter shorter than the delay still finds a state on each side', () => {
    const buf = new SnapshotBuffer();
    // ±30 ms of jitter on a 20 Hz stream.
    fill(buf, 40, 0.05, (i) => ((i * 7919) % 61) / 1000 - 0.03);
    let extrapolated = 0;
    for (let k = 0; k < 30; k++) if (buf.sample(1.5 + k / 60)!.extrapolated) extrapolated++;
    expect(extrapolated).toBe(0);
  });

  it('past the newest state it extrapolates briefly along the velocity, then holds', () => {
    const buf = new SnapshotBuffer();
    for (let i = 1; i <= 10; i++) buf.push(snap(i * 3, [fighter('A', i * 0.1, 0, { velocity: { x: 2, y: 0, z: 0 } })]), (i * 3) / 60);
    const newest = 1.0;
    // 30 ms past the newest state: extrapolated by 30 ms.
    const a = buf.sample(0.5 + NET_VIEW.delay + 0.03)!;
    expect(a.extrapolated).toBe(true);
    expect(a.snapshot.fighters[0].position.x).toBeCloseTo(newest + 2 * 0.03, 3);
    // Long past it: held at the bound, not run off into the void.
    const b = buf.sample(0.5 + NET_VIEW.delay + 0.5)!;
    expect(b.snapshot.fighters[0].position.x).toBeCloseTo(newest + 2 * NET_VIEW.maxExtrapolate, 3);
    const e = extrapolate(snap(3, [fighter('A', 0, 0, { eliminated: true, velocity: { x: 5, y: 0, z: 0 } })]), 0.05);
    expect(e.fighters[0].position.x).toBe(0);
  });

  it('forgets states well behind the render time', () => {
    const buf = new SnapshotBuffer();
    fill(buf, 100);
    buf.sample((100 * 3) / 60 + 0.03);
    expect(buf.size).toBeLessThan(30);
  });
});
