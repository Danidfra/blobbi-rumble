/**
 * Prediction against the real server host, in-process: the predicted
 * fighter's inputs go in as the wire's input messages, the host steps the
 * authoritative match, and every state message is reconciled exactly as
 * the browser client does. Whenever the server has the fighter in hand (a
 * grab, a throw's tumble, the sweeper's blow) the prediction stands down
 * and the fighter follows authority; when the server hands it back, the
 * prediction resumes from the server's account.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { RumbleHost } from '../net/host';
import { inputMessage, type StateMessage } from '../net/protocol';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { SWEEPER } from '../tuning';
import { LocalPredictor, predictable, type Body, type Reconciliation } from './predict';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

/** A predicted client of the host: one frame per tick, a state every third tick, delivered `lagTicks` later. */
function client(host: RumbleHost, conn: number, id: string, lagTicks = 6) {
  const p = new LocalPredictor();
  let seq = 0;
  const inbox: { at: number; m: StateMessage }[] = [];
  const kinds: Reconciliation['kind'][] = [];
  let lastAuth: Body | null = null;
  return {
    p,
    kinds,
    /** This tick's keys: sent (with the delay arriving up front for simplicity) and predicted. */
    frame(intent: { x?: number; z?: number; run?: boolean; jump?: boolean; punch?: boolean; grab?: boolean }) {
      seq++;
      const move = { x: intent.x ?? 0, z: intent.z ?? 0, run: !!intent.run };
      host.receive(conn, JSON.stringify(inputMessage(seq, move, { jump: !!intent.jump, punch: !!intent.punch, grab: !!intent.grab })));
      p.frame(1 / 60, seq, { ...move, jump: !!intent.jump, punch: false, grab: false });
      // Drawn every frame, as the client does (the authority stands in for the interpolated state).
      if (lastAuth) p.show(lastAuth);
    },
    afterTick() {
      const tick = host.latest.tick;
      if (tick % 3 === 0) inbox.push({ at: tick + lagTicks, m: JSON.parse(JSON.stringify(host.state())) });
      for (const { m } of inbox.filter((x) => x.at === tick)) {
        const f = m.snapshot.fighters[m.snapshot.players.indexOf(id)];
        const r = p.reconcile(f, m.tick, 1 / 60, m.acks[id] ?? -1, m.ackTicks[id] ?? m.tick, predictable(f, m.snapshot.phase === 'playing'));
        kinds.push(r.kind);
        lastAuth = { x: f.position.x, y: f.position.y, z: f.position.z, vx: f.velocity.x, vy: f.velocity.y, vz: f.velocity.z, yaw: f.yaw };
      }
    },
  };
}

describe('prediction against the authoritative host', () => {
  it('a grab and a throw take the fighter out of prediction; it resumes once the server hands it back', () => {
    const host = new RumbleHost({ havok });
    host.connect(1);
    host.connect(2);
    host.connect(3);
    host.connect(4);
    host.match.debugPlace('P1', { x: -1, z: 0, yaw: Math.PI / 2 });
    host.match.debugPlace('P2', { x: 0.3, z: 0, yaw: -Math.PI / 2 });
    host.match.debugPlace('P3', { x: -3, z: 3 });
    host.match.debugPlace('P4', { x: 3, z: -3 });
    const a = client(host, 1, 'P1');
    let seq2 = 0;
    const b = (intent: object) => host.receive(2, JSON.stringify({ t: 'input', seq: ++seq2, intent }));
    const phases: Record<string, Reconciliation['kind'][]> = { walk: [], held: [], thrown: [], after: [] };
    let phase = 'walk';
    for (let k = 0; k < 330; k++) {
      // P1 keeps walking east the whole time; P2 grabs it at tick 40, throws it at tick 100.
      a.frame({ x: 1 });
      if (k === 22) b({ grab: true });
      if (k === 100) b({ grab: true, x: -1 });
      host.tick();
      const before = a.kinds.length;
      a.afterTick();
      const f = host.latest.fighters[0];
      if (f.heldBy) phase = 'held';
      else if (phase === 'held') phase = 'thrown';
      else if (phase === 'thrown' && f.combat.tumble < 0 && f.combat.recovering < 0 && f.combat.stun <= 0) phase = 'after';
      phases[phase].push(...a.kinds.slice(before));
    }
    expect(phases.walk.filter((x) => x === 'kept' || x === 'smoothed' || x === 'none').length).toBeGreaterThanOrEqual(4);
    // Held and thrown: the server's, entirely (after the states already on their way when the grab happened: 100 ms of them).
    expect(phases.held.length).toBeGreaterThan(5);
    expect(phases.held.slice(2).every((x) => x === 'authority')).toBe(true);
    expect(phases.thrown.filter((x) => x === 'authority').length).toBeGreaterThan(3);
    // Handed back (if the throw did not ring it out): prediction resumes, then keeps.
    const out = host.latest.fighters[0].eliminated || host.latest.round > 1;
    if (!out) {
      expect(phases.after).toContain('resumed');
      expect(phases.after.at(-1)).not.toBe('authority');
    }
    expect(a.p.metrics.snapped).toBe(0);
    host.dispose();
  });

  it('the sweeper\'s blow is the server\'s: prediction stands down for the stun or tumble and resumes after', () => {
    const host = new RumbleHost({ havok });
    for (let c = 1; c <= 4; c++) host.connect(c);
    // In the bar's path near the tip, walking with it.
    const r = 1.75;
    host.match.debugPlace("P1", { x: SWEEPER.pivot.x - r, z: SWEEPER.pivot.z + 0.3 });
    host.match.debugPlace('P2', { x: -3, z: 3 });
    host.match.debugPlace('P3', { x: -3, z: -3 });
    host.match.debugPlace('P4', { x: 0, z: 3 });
    const a = client(host, 1, 'P1');
    let struck = -1;
    for (let k = 0; k < 300; k++) {
      a.frame({});
      host.tick();
      a.afterTick();
      if (struck < 0 && host.latest.fighters[0].hits > 0) struck = k;
    }
    expect(struck).toBeGreaterThanOrEqual(0);
    expect(a.kinds).toContain('authority');
    const firstAuthority = a.kinds.indexOf('authority');
    expect(a.kinds.slice(firstAuthority)).toContain('resumed');
    expect(a.p.metrics.snapped).toBe(0);
    host.dispose();
  });
});
