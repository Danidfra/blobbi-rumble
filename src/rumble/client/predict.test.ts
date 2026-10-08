/**
 * Local prediction and reconciliation, as plain numbers, against a stand-in
 * server that runs the same locomotion at 60 Hz and applies each input when
 * it "arrives": the prediction answers the keys at once, acknowledged input
 * leaves the history, replay lands on the server's account, small errors
 * are left alone, middling ones glide away, large ones snap, and the server
 * takes the fighter whenever it has it in hand.
 */
import { describe, expect, it } from 'vitest';
import { inputMessage, parseClientMessage } from '../net/protocol';
import { RUMBLE_BODY } from '../profile';
import type { PlayerIntent } from '../sim/intent';
import type { FighterSnapshot } from '../sim/snapshot';
import { advance, LocalPredictor, PREDICT, predictable, stepBody, type Body } from './predict';

const IDLE: PlayerIntent = { x: 0, z: 0, run: false, jump: false, punch: false, grab: false };
const east: PlayerIntent = { ...IDLE, x: 1 };
const allow = { powerLevel: 0, carrying: false };
const at = (x: number, z = 0): Body => ({ x, y: RUMBLE_BODY.capsuleCenterY, z, vx: 0, vy: 0, vz: 0, yaw: 0 });
const auth = (b: Body, extra: Partial<FighterSnapshot> = {}): FighterSnapshot => ({
  id: 'P1',
  position: { x: b.x, y: b.y, z: b.z },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  upright: true,
  yaw: b.yaw,
  velocity: { x: b.vx, y: b.vy, z: b.vz },
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

describe('the locomotion model', () => {
  it('walks and runs at the speeds the Havok match settles at, brakes to a stop, and jumps off the floor and lands', () => {
    let b = at(-3);
    for (let i = 0; i < 60; i++) b = stepBody(b, east, 1 / 60, allow).body;
    // The server's walker settles at 1.503 m/s (wanted 1.6, less floor friction and damping).
    expect(b.vx).toBeCloseTo(1.503, 2);
    for (let i = 0; i < 60; i++) b = stepBody(b, { ...east, run: true }, 1 / 60, allow).body;
    expect(b.vx).toBeCloseTo(3.087, 2);
    for (let i = 0; i < 30; i++) b = stepBody(b, IDLE, 1 / 60, allow).body;
    expect(Math.abs(b.vx)).toBeLessThan(0.01);
    const j = stepBody(b, { ...IDLE, jump: true }, 1 / 60, allow);
    expect(j.jumped).toBe(true);
    expect(j.body.vy).toBeCloseTo(4.323, 2);
    let air = j.body;
    let peak = air.y;
    for (let i = 0; i < 60; i++) {
      air = stepBody(air, IDLE, 1 / 60, allow).body;
      peak = Math.max(peak, air.y);
    }
    expect(peak).toBeGreaterThan(RUMBLE_BODY.capsuleCenterY + 0.6);
    expect(air.y).toBeCloseTo(RUMBLE_BODY.capsuleCenterY, 3);
  });

  it('carrying slows it and forbids the jump; power speeds it a little; off the floor it falls', () => {
    let carry = at(0);
    let free = at(0);
    for (let i = 0; i < 60; i++) {
      carry = stepBody(carry, east, 1 / 60, { powerLevel: 0, carrying: true }).body;
      free = stepBody(free, east, 1 / 60, allow).body;
    }
    expect(carry.vx).toBeLessThan(free.vx * 0.9);
    expect(stepBody(carry, { ...IDLE, jump: true }, 1 / 60, { powerLevel: 0, carrying: true }).jumped).toBe(false);
    let edge = at(3.9, 3.9);
    for (let i = 0; i < 60; i++) edge = stepBody(edge, { ...IDLE, z: 1, run: true }, 1 / 60, allow).body;
    expect(edge.y).toBeLessThan(0);
  });
});

/** A stand-in server: the same model at 60 Hz, applying each input `upTicks` after it was sent, acknowledging it. */
function scenario(upTicks: number, downTicks: number, inputs: (k: number) => PlayerIntent, frames: number, nudge?: (k: number, b: Body) => Body) {
  const p = new LocalPredictor();
  let server = at(-3);
  const sent: { seq: number; at: number; intent: PlayerIntent }[] = [];
  let applied = -1;
  let appliedTick = 0;
  const inbox: { at: number; state: FighterSnapshot; tick: number; ack: number; ackTick: number }[] = [];
  let seq = 0;
  let lastMove = '';
  const errors: number[] = [];
  let lastAuth = at(-3);
  for (let k = 0; k < frames; k++) {
    // Client frame k: read the keys, send on change, predict.
    const intent = inputs(k);
    const move = JSON.stringify([intent.x, intent.z, intent.run]);
    if (move !== lastMove || intent.jump) {
      seq++;
      sent.push({ seq, at: k, intent });
      lastMove = move;
    }
    p.frame(1 / 60, seq, intent);
    p.show(lastAuth);
    // Server tick k: take what has arrived, step, send a state every 3rd tick.
    for (const m of sent) if (m.at + upTicks === k && m.seq > applied) {
      applied = m.seq;
      appliedTick = k;
    }
    const current = sent.filter((m) => m.seq <= applied).at(-1)?.intent ?? IDLE;
    const jumpNow = current.jump && appliedTick === k;
    server = stepBody(server, { ...current, jump: jumpNow }, 1 / 60, allow).body;
    if (nudge) server = nudge(k, server);
    if (k % 3 === 0) inbox.push({ at: k + downTicks, state: auth(server), tick: k, ack: applied, ackTick: appliedTick });
    for (const msg of inbox.filter((m) => m.at === k)) {
      const r = p.reconcile(msg.state, msg.tick, 1 / 60, msg.ack, msg.ackTick, true);
      lastAuth = { x: msg.state.position.x, y: msg.state.position.y, z: msg.state.position.z, vx: 0, vy: 0, vz: 0, yaw: 0 };
      errors.push(r.error);
    }
  }
  return { p, errors, server };
}

describe('reconciliation', () => {
  it('answers the keys at once: the first frame of input moves the prediction, long before any state could', () => {
    const p = new LocalPredictor();
    p.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    p.frame(1 / 60, 1, east);
    expect(p.body!.vx).toBeGreaterThan(0.3);
  });

  it('acknowledged input leaves the history; what remains is what the server has not applied', () => {
    const p = new LocalPredictor();
    p.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    for (let s = 1; s <= 6; s++) p.frame(1 / 60, s, east);
    expect(p.history).toHaveLength(6);
    const r = p.reconcile(auth(at(0.05)), 10, 1 / 60, 3, 9, true);
    expect(p.history.map((f) => f.seq)).toEqual([3, 4, 5, 6]);
    expect(r.pending).toBe(3);
    // The history never outgrows its window.
    for (let i = 0; i < 1000; i++) p.frame(1 / 60, 7, east);
    expect(p.history.reduce((s, f) => s + f.dt, 0)).toBeLessThanOrEqual(PREDICT.history + 1 / 60);
  });

  it('with a round trip of 100 ms the replayed prediction lands within centimetres of the server, through walking, running, turning, stopping and a jump', () => {
    const inputs = (k: number): PlayerIntent => (k < 40 ? east : k < 80 ? { ...east, run: true } : k < 120 ? { ...IDLE, z: 1 } : k === 125 ? { ...IDLE, jump: true } : k < 160 ? IDLE : { ...IDLE, x: -0.7071, z: -0.7071 });
    const { errors, p } = scenario(3, 3, inputs, 220);
    // The same model on both ends: once running, the replay lands on the server exactly.
    expect(Math.max(...errors.slice(1))).toBeLessThan(0.005);
    expect(p.metrics.snapped).toBe(0);
  });

  it('a push the prediction cannot know (a body in the way) is corrected: middling errors glide away, never jerk', () => {
    // The server's body is held still from tick 60 to 100 (blocked); the client keeps walking into it.
    const { p, errors } = scenario(3, 3, () => east, 140, (k, b) => (k >= 60 && k < 100 ? { ...b, x: Math.min(b.x, -1.5), vx: Math.min(b.vx, 0) } : b));
    expect(Math.max(...errors)).toBeGreaterThan(PREDICT.smallError);
    expect(p.metrics.smoothed).toBeGreaterThan(0);
    expect(p.metrics.snapped).toBe(0);
    // While smoothing, the drawn position moves by no more than a normal frame's walk plus the correction's share.
    const q = new LocalPredictor();
    q.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    q.frame(1 / 60, 1, IDLE);
    const before = q.show(at(0));
    q.reconcile(auth(at(0.4)), 3, 1 / 60, 1, 1, true);
    const after = q.show(at(0));
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.01);
    for (let i = 0; i < 30; i++) q.frame(1 / 60, 1, IDLE);
    expect(q.show(at(0)).x).toBeCloseTo(0.4, 1);
  });

  it('small errors are left alone; large ones snap at once', () => {
    const p = new LocalPredictor();
    p.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    p.frame(1 / 60, 1, IDLE);
    expect(p.reconcile(auth(at(0.02)), 3, 1 / 60, 1, 1, true).kind).toBe('kept');
    expect(p.body!.x).toBeCloseTo(0, 3);
    const r = p.reconcile(auth(at(3)), 6, 1 / 60, 1, 1, true);
    expect(r.kind).toBe('snapped');
    expect(p.show(at(0)).x).toBeCloseTo(3, 2);
  });

  it('while the server has the fighter (tumble, stun, held, out, between rounds) nothing is predicted; it is drawn from authority, handed over smoothly', () => {
    const playing = (extra: Partial<FighterSnapshot>) => predictable(auth(at(0), extra), true);
    expect(playing({})).toBe(true);
    expect(playing({ combat: { punchTime: -1, punchCooldown: 0, stun: 0, tumble: 0.1, recovering: -1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 } })).toBe(false);
    expect(playing({ combat: { punchTime: -1, punchCooldown: 0, stun: 0, tumble: -1, recovering: 0.1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 } })).toBe(false);
    expect(playing({ combat: { punchTime: -1, punchCooldown: 0, stun: 0.2, tumble: -1, recovering: -1, holdTime: -1, holdAngle: 0, struggle: 0, grabImmune: 0 } })).toBe(false);
    expect(playing({ heldBy: 'P2' })).toBe(false);
    expect(playing({ eliminated: true })).toBe(false);
    expect(predictable(auth(at(0)), false)).toBe(false);
    // Carrying is still the player's locomotion.
    expect(playing({ holding: 'P2', combat: { punchTime: -1, punchCooldown: 0, stun: 0, tumble: -1, recovering: -1, holdTime: 0.3, holdAngle: 0, struggle: 0, grabImmune: 0 } })).toBe(true);

    const p = new LocalPredictor();
    p.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    for (let i = 0; i < 20; i++) {
      p.frame(1 / 60, 1, east);
      p.show(at(0));
    }
    const was = p.show(at(0));
    // Knocked down: the server has it now; the interpolated authority is somewhere else.
    expect(p.reconcile(auth(at(1)), 30, 1 / 60, 1, 1, false).kind).toBe('authority');
    expect(p.predicting).toBe(false);
    const first = p.show(at(1));
    expect(Math.abs(first.x - was.x)).toBeLessThan(0.05);
    for (let i = 0; i < 40; i++) p.frame(1 / 60, 1, east);
    expect(p.show(at(1)).x).toBeCloseTo(1, 1);
  });

  it('taking the fighter back from the server is a resume, not a prediction error: a round reset snaps to the spawn, a recovery glides', () => {
    const p = new LocalPredictor();
    p.reconcile(auth(at(0)), 0, 1 / 60, -1, 0, true);
    p.frame(1 / 60, 1, IDLE);
    p.show(at(0));
    // Rung out: the server has it (parked far below), drawn from authority.
    p.reconcile(auth({ ...at(0), y: -40 }), 30, 1 / 60, 1, 1, false);
    p.frame(1 / 60, 1, IDLE);
    p.show({ ...at(0), y: -40 });
    // The next round: back at the spawn, in the player's hands again: a snap, counted as a resume.
    const r = p.reconcile(auth(at(-2.2, -2.2)), 200, 1 / 60, 1, 1, true);
    expect(r.kind).toBe('resumed');
    expect(p.metrics.resumeSnaps).toBe(1);
    expect(p.metrics.snapped).toBe(0);
    expect(p.metrics.maxError).toBe(0);
    expect(p.show(at(-2.2, -2.2)).x).toBeCloseTo(-2.2, 3);
  });

  it('nothing predicted reaches the server: an input message carries the intent and its number, nothing else', () => {
    const m = inputMessage(7, { x: 0.6, z: 0.8, run: true }, { jump: true, punch: false, grab: false });
    expect(Object.keys(m).sort()).toEqual(['intent', 'seq', 't']);
    expect(Object.keys(m.intent).sort()).toEqual(['grab', 'jump', 'punch', 'run', 'x', 'z']);
    expect(parseClientMessage(JSON.stringify(m))).toEqual(m);
    // The predictor has no channel to the server at all: it only takes states and draws.
    expect(Object.getOwnPropertyNames(LocalPredictor.prototype).sort()).toEqual(['constructor', 'frame', 'predicting', 'reconcile', 'reset', 'show']);
  });

  it('advance splits a long frame into server-sized steps and fires a jump once', () => {
    const r = advance(at(0), { ...IDLE, jump: true }, 0.05, allow);
    expect(r.jumped).toBe(true);
    const once = stepBody(at(0), { ...IDLE, jump: true }, 1 / 60, allow).body;
    expect(r.body.vy).toBeLessThan(once.vy);
  });
});
