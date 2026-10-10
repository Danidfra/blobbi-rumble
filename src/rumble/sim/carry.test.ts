/**
 * M12.1: holds that stay put, throws that are the same for anyone, ledges
 * that catch predictably.
 *
 *   carry   a grab lifts the body smoothly (never faster than the spring's
 *           bounded catch-up) and settles on its anchor; a turning carrier
 *           keeps it there (the swing is fed forward); grabs, escapes,
 *           throws and drops over and over, on the move, leave consistent
 *           holds and finite, sensible bodies
 *   parity  a bot's throw and the same intents sent as a person's give the
 *           same impact and the same landing; the impact is the rule's
 *           (base plus the carrier's speed along the throw), whoever throws
 *   ledges  running off an edge catches it as walking off does; a body
 *           knocked down does not; the climb's path never cuts the corner
 *           and its drive is bounded
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FACTORY, SKYFALL } from '../arena/arenas';
import { anchorVelocity, holdAnchor } from '../combat/combat';
import { BotInput, botWorldFrom } from '../control/bot';
import { RUMBLE_BODY } from '../profile';
import { COMBAT, LEDGE } from '../tuning';
import { loadHavokNode } from './havokNode';
import { climbPoint, climbTarget, hangAnchor } from './ledge';
import { createRumbleMatch, type RumbleMatch } from './match';
import { runHeadless } from '../headless';
import type { HavokInstance } from './physics';
import type { PlayerIntent } from './intent';
import type { FighterSnapshot } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const DT = 1 / 60;
const get = (m: RumbleMatch, id: string) => m.snapshot().fighters.find((f) => f.id === id)!;
const feet = (f: FighterSnapshot) => ({ x: f.position.x, y: f.position.y - RUMBLE_BODY.capsuleCenterY, z: f.position.z });
const anchorError = (m: RumbleMatch, carrier: string, held: string) => {
  const a = get(m, carrier);
  const b = get(m, held);
  const at = holdAnchor(feet(a), a.combat.holdAngle);
  const fb = feet(b);
  return Math.hypot(fb.x - at.x, fb.y - at.y, fb.z - at.z);
};

/** a holds b, both standing on the classic island's centre, with c and d away so the round goes on. */
function holding(gap = 0.85): RumbleMatch {
  const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  m.debugPlace('c', { x: -6, z: -2 });
  m.debugPlace('d', { x: -6, z: 2 });
  m.debugPlace('a', { x: 0, z: 0, yaw: 0 });
  m.debugPlace('b', { x: 0, z: gap, yaw: Math.PI });
  m.step(DT);
  m.setInput('a', { grab: true });
  m.step(DT);
  return m;
}

describe('carrying', () => {
  it('a grab lifts the body no faster than the bounded catch-up, settles on the anchor and stays there', () => {
    for (const gap of [0.82, 0.95, 1.1]) {
      const m = holding(gap);
      expect(get(m, 'b').heldBy).toBe('a');
      let maxVy = 0;
      for (let t = 0; t < 40; t++) {
        m.step(DT);
        maxVy = Math.max(maxVy, get(m, 'b').velocity.y);
      }
      // The catch-up bound, plus a step's worth of the pull's velocity change.
      expect(maxVy).toBeLessThanOrEqual(COMBAT.holdCatchUp + COMBAT.holdMaxPull * DT + 1e-6);
      expect(anchorError(m, 'a', 'b')).toBeLessThan(0.03);
      m.dispose();
    }
  });

  it('a carrier turning steadily keeps the held body at its anchor (the swing is fed forward), and walking straight too', () => {
    const m = holding();
    for (let t = 0; t < 30; t++) m.step(DT);
    let worst = 0;
    // A slow circle: the facing, and so the hold, turns all the time (inside the hold's 2.5 s limit).
    for (let t = 0; t < 100; t++) {
      const a = t * 0.04;
      m.setInput('a', { x: Math.sin(a), z: Math.cos(a) });
      m.step(DT);
      if (t > 30) worst = Math.max(worst, anchorError(m, 'a', 'b'));
    }
    expect(worst).toBeLessThan(0.1);
    // Then straight on: settled.
    for (let t = 0; t < 20; t++) {
      m.setInput('a', { x: 1, z: 0 });
      m.step(DT);
    }
    expect(get(m, 'b').heldBy).toBe('a');
    expect(anchorError(m, 'a', 'b')).toBeLessThan(0.08);
    m.dispose();
  });

  it('the anchor velocity is the grabber’s plus the swing round it', () => {
    const v = anchorVelocity({ x: 1, y: 0.5, z: 0 }, 0, 2);
    // At angle 0 the anchor is ahead (+z); turning positive swings it toward +x.
    expect(v.x).toBeCloseTo(1 + COMBAT.holdDistance * 2, 9);
    expect(v.y).toBe(0.5);
    expect(v.z).toBeCloseTo(0, 9);
  });

  it('grabs, escapes, throws and drops, over and over, on the move: holds stay consistent and bodies stay sensible', () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    m.debugPlace('c', { x: -6, z: -2 });
    m.debugPlace('d', { x: -6, z: 2 });
    let grabs = 0;
    let escapes = 0;
    let throws = 0;
    for (let cycle = 0; cycle < 12; cycle++) {
      m.debugPlace('a', { x: 0, z: -1, yaw: 0 });
      m.debugPlace('b', { x: 0, z: -0.15, yaw: Math.PI });
      for (let t = 0; t < 40; t++) m.step(DT);
      m.setInput('a', { grab: true });
      const ev = m.step(DT);
      if (ev.some((e) => e.kind === 'grab')) grabs++;
      for (let t = 0; t < 150; t++) {
        const k = t + cycle * 7;
        m.setInput('a', { x: Math.sin(k / 9), z: Math.cos(k / 13), grab: cycle % 3 === 1 && t === 50 });
        // Some cycles b struggles (alternating), others it lets itself be carried.
        if (cycle % 3 === 0) m.setInput('b', { x: Math.floor(t / 6) % 2 ? 1 : -1, z: 0 });
        const events = m.step(DT);
        escapes += events.filter((e) => e.kind === 'escape').length;
        throws += events.filter((e) => e.kind === 'throw').length;
        expect(m.holdsConsistent()).toBe(true);
        for (const f of m.snapshot().fighters) {
          if (f.eliminated) continue;
          expect(Number.isFinite(f.position.x + f.position.y + f.position.z)).toBe(true);
          // Nobody is lifted above a held body's height plus a throw's arc.
          expect(f.position.y).toBeLessThan(2.4);
        }
      }
      m.setInput('b', { x: 0, z: 0 });
      m.setInput('a', { x: 0, z: 0 });
      if (get(m, 'b').eliminated || get(m, 'a').eliminated) m.restart();
    }
    expect(grabs).toBeGreaterThanOrEqual(8);
    expect(escapes).toBeGreaterThan(0);
    expect(throws).toBeGreaterThan(0);
    m.dispose();
  }, 60_000);
});

describe('throws: the same for a person and a bot', () => {
  /** a holds b near the classic island's east rim, facing out; the rest of the round goes on elsewhere. */
  const setup = () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    m.debugPlace('c', { x: -6, z: -2 });
    m.debugPlace('d', { x: -6, z: 2 });
    m.debugPlace('a', { x: 1.5, z: -3, yaw: Math.PI / 2 });
    m.debugPlace('b', { x: 2.35, z: -3, yaw: -Math.PI / 2 });
    m.step(DT);
    m.setInput('a', { grab: true });
    m.step(DT);
    return m;
  };

  it('a bot’s carry-and-throw, sent again as a person’s intents, lands the same throw in the same place', () => {
    const bot = new BotInput(3);
    const m = setup();
    expect(get(m, 'b').heldBy).toBe('a');
    const intents: PlayerIntent[] = [];
    let impact = -1;
    for (let t = 0; t < 400 && impact < 0; t++) {
      bot.plan(botWorldFrom(m.snapshot(), 'a'), DT);
      const i = bot.read();
      intents.push(i);
      m.setInput('a', i);
      const ev = m.step(DT);
      const th = ev.find((e) => e.kind === 'throw' && e.who === 'a');
      if (th) impact = th.impact!;
    }
    expect(impact).toBeGreaterThan(0);
    for (let t = 0; t < 30; t++) m.step(DT);
    const botLanding = get(m, 'b').position;

    const h = setup();
    let humanImpact = -1;
    for (const i of intents) {
      h.setInput('a', i);
      const th = h.step(DT).find((e) => e.kind === 'throw' && e.who === 'a');
      if (th) humanImpact = th.impact!;
    }
    for (let t = 0; t < 30; t++) h.step(DT);
    const humanLanding = get(h, 'b').position;
    expect(humanImpact).toBeCloseTo(impact, 6);
    expect(Math.hypot(humanLanding.x - botLanding.x, humanLanding.y - botLanding.y, humanLanding.z - botLanding.z)).toBeLessThan(0.01);
    m.dispose();
    h.dispose();
  });

  it('the impact is the rule’s for anyone: base when standing, base plus the carrier’s speed along the throw when walking it', () => {
    const still = setup();
    for (let t = 0; t < 30; t++) still.step(DT);
    still.setInput('a', { grab: true });
    const a = still.step(DT).find((e) => e.kind === 'throw')!;
    expect(a.impact).toBeCloseTo(COMBAT.throwBase, 1);

    const walking = setup();
    for (let t = 0; t < 30; t++) walking.step(DT);
    let along = 0;
    for (let t = 0; t < 40; t++) {
      walking.setInput('a', { x: 1, z: 0 });
      walking.step(DT);
      const f = get(walking, 'a');
      along = f.velocity.x * Math.sin(f.combat.holdAngle) + f.velocity.z * Math.cos(f.combat.holdAngle);
    }
    walking.setInput('a', { x: 1, z: 0, grab: true });
    const w = walking.step(DT).find((e) => e.kind === 'throw')!;
    expect(along).toBeGreaterThan(0.8);
    expect(w.impact).toBeGreaterThan(COMBAT.throwBase + 0.7);
    expect(w.impact).toBeLessThan(COMBAT.throwBase + COMBAT.throwGain * (RUMBLE_BODY.walkSpeed * COMBAT.carrySpeed) + 0.15);
    still.dispose();
    walking.dispose();
  });
});

describe('ledges', () => {
  /** a runs (or walks) south off Skyfall's centre at x 3 (no bridge, no step there). */
  const offTheEdge = (run: boolean, arena = SKYFALL, from = { x: 3, z: -3.6 }, dir = { x: 0, z: -1 }) => {
    const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], arena });
    m.debugPlace('b', { x: -3, z: 2 });
    m.debugPlace('c', { x: -2, z: 2 });
    m.debugPlace('a', { x: from.x, z: from.z, yaw: Math.atan2(dir.x, dir.z) });
    let caught = false;
    for (let t = 0; t < 150 && !caught; t++) {
      m.setInput('a', { x: dir.x, z: dir.z, run });
      m.step(DT);
      caught = !!get(m, 'a').ledge;
    }
    return { m, caught };
  };

  it('running off an edge catches it, as walking off does (M12.1: the hands reach far enough for a run)', () => {
    for (const run of [false, true]) {
      const r = offTheEdge(run);
      expect(r.caught).toBe(true);
      r.m.dispose();
    }
    // The factory's south edge too, running.
    const f = offTheEdge(true, FACTORY, { x: -3, z: -3.2 }, { x: 0, z: -1 });
    expect(f.caught).toBe(true);
    f.m.dispose();
  });

  it('a body knocked down over an edge does not catch it: falling stays a risk', () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], arena: SKYFALL });
    m.debugPlace('c', { x: -3, z: 2 });
    m.debugPlace('a', { x: 3, z: -3.9, yaw: 0 });
    m.debugPlace('b', { x: 3, z: -3.0, yaw: Math.PI });
    m.step(DT);
    // b punches a off the south edge, again and again until it goes.
    let caught = false;
    let out = false;
    for (let t = 0; t < 240 && !out; t++) {
      m.setInput('b', { x: 0, z: -0.3, punch: t % 20 === 0 });
      m.step(DT);
      const a = get(m, 'a');
      if (a.ledge && a.combat.tumble >= 0) caught = true;
      out = a.eliminated;
    }
    expect(caught).toBe(false);
    m.dispose();
  });

  it('the climb goes up clear of the wall, then in over the top: the capsule never cuts the platform', () => {
    const l = { platform: 0, x: 2, y: 0, z: -4, inX: 0, inZ: 1 };
    const r = RUMBLE_BODY.capsuleRadius;
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const c = climbPoint(l, u);
      const bottom = c.y - RUMBLE_BODY.capsuleCenterY;
      // Past the wall line (inside the platform's footprint, by the capsule's radius): the capsule's bottom is over the top.
      const inside = (c.z - l.z) * l.inZ > -r;
      if (inside) expect(bottom).toBeGreaterThanOrEqual(l.y - 1e-9);
    }
    expect(climbPoint(l, 0)).toEqual(hangAnchor(l));
    const end = climbPoint(l, 1);
    const target = climbTarget(l);
    expect(end.x).toBeCloseTo(target.x, 9);
    expect(end.y).toBeCloseTo(target.y, 9);
    expect(end.z).toBeCloseTo(target.z, 9);
  });

  it('a body that jumped catches only an edge it is going toward, never the one it leapt away from', () => {
    // A slow hop outward from the very edge of Skyfall's south side lands within reach of the edge behind: not caught.
    const hop = (jump: boolean) => {
      const m = createRumbleMatch({ havok, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], arena: SKYFALL });
      m.debugPlace('b', { x: -3, z: 2 });
      m.debugPlace('c', { x: -2, z: 2 });
      m.debugPlace('a', { x: 3, z: -4.3, yaw: Math.PI });
      for (let t = 0; t < 20; t++) m.step(DT);
      let caught = false;
      for (let t = 0; t < 120 && !caught; t++) {
        m.setInput('a', { x: 0, z: t < 40 ? -0.5 : 0, jump: jump && t === 0 });
        m.step(DT);
        caught = !!get(m, 'a').ledge;
      }
      expect(get(m, 'a').jumps).toBe(jump ? 1 : 0);
      m.dispose();
      return caught;
    };
    expect(hop(true)).toBe(false);
    // The same drift off the edge without the hop is caught (the edge it dropped from).
    expect(hop(false)).toBe(true);
  });

  it('bot-only Skyfall matches keep ending (no leap, catch, climb back loop across a broken bridge)', () => {
    const r = runHeadless({ havok, arena: SKYFALL, matches: 6, maxSeconds: 3000 });
    expect(r.matches.length).toBe(6);
    for (const x of r.matches) {
      expect(x.winner).not.toBeNull();
      expect(x.seconds).toBeLessThan(450);
    }
  }, 300_000);

  it('in the match a climb runs its course at a bounded speed and ends standing on top', () => {
    const { m, caught } = offTheEdge(false);
    expect(caught).toBe(true);
    m.setInput('a', { x: 0, z: 0 });
    for (let t = 0; t < 10; t++) m.step(DT);
    m.setInput('a', { jump: true });
    let maxSpeed = 0;
    let climbed = false;
    for (let t = 0; t < 60 && !climbed; t++) {
      const ev = m.step(DT);
      const a = get(m, 'a');
      maxSpeed = Math.max(maxSpeed, Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z));
      climbed = ev.some((e) => e.kind === 'ledge' && e.note === 'climbed');
    }
    expect(climbed).toBe(true);
    expect(maxSpeed).toBeLessThanOrEqual(LEDGE.climbMaxSpeed + 0.5);
    for (let t = 0; t < 20; t++) m.step(DT);
    const a = get(m, 'a');
    expect(a.grounded).toBe(true);
    expect(a.position.z).toBeGreaterThan(-4.5);
    m.dispose();
  });
});
