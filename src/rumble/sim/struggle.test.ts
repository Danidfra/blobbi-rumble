/**
 * The grab struggle in the authoritative match: a held fighter that
 * reverses its movement breaks free, cleanly, with a small push apart and a
 * moment in which it cannot be grabbed again; a quick throw beats it, and so
 * does a throw on the very step the struggle would have finished; every
 * other end of a hold clears it; a held bot struggles too.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BotInput, botWorldFrom } from '../control/bot';
import { parseClientMessage } from '../net/protocol';
import { RUMBLE_BODY } from '../profile';
import { ROUND, STRUGGLE } from '../tuning';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { MatchEvent } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const DT = 1 / 60;
/** A holds B in the middle of the centre; C stands off to the side. */
function holding(): RumbleMatch {
  const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] });
  m.debugPlace('A', { x: -0.5, z: 0, yaw: Math.PI / 2 });
  m.debugPlace('B', { x: 0.4, z: 0, yaw: -Math.PI / 2 });
  m.debugPlace('C', { x: -2.5, z: -2.5 });
  m.step(DT);
  m.setInput('A', { grab: true });
  m.step(DT);
  return m;
}
const f = (m: RumbleMatch, id: string) => m.snapshot().fighters.find((x) => x.id === id)!;
/** B alternates left/right, a stroke every `frames` steps, for `seconds`; returns the events. Stops at an escape if `untilFree`. */
function struggle(m: RumbleMatch, seconds: number, frames = 12, untilFree = true, each?: (k: number) => void): MatchEvent[] {
  const events: MatchEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) {
    m.setInput('B', { x: Math.floor(k / frames) % 2 ? 1 : -1 });
    each?.(k);
    const e = m.step(DT);
    events.push(...e);
    if (untilFree && e.some((x) => x.kind === 'escape')) break;
  }
  return events;
}

describe('breaking free', () => {
  it('alternating breaks the hold in about a second and a quarter: both sides cleared, pushed apart, standing again', () => {
    const m = holding();
    expect(f(m, 'B').heldBy).toBe('A');
    const before = m.tick;
    const events = struggle(m, 3);
    const escape = events.find((e) => e.kind === 'escape');
    expect(escape).toMatchObject({ who: 'B', on: 'A' });
    const seconds = (escape!.tick - before) / 60;
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.7);
    let s = m.snapshot();
    const a = s.fighters[0];
    const b = s.fighters[1];
    expect(a.holding).toBeNull();
    expect(b.heldBy).toBeNull();
    expect(b.combat.struggle).toBe(0);
    expect(b.escapes).toBe(1);
    expect(b.combat.grabImmune).toBeGreaterThan(0);
    expect(m.holdsConsistent()).toBe(true);
    // A small push apart, not an attack: they separate, neither tumbles, B comes down and stands.
    m.setInput('B', {});
    for (let k = 0; k < 60; k++) m.step(DT);
    s = m.snapshot();
    const gap = Math.hypot(s.fighters[1].position.x - s.fighters[0].position.x, s.fighters[1].position.z - s.fighters[0].position.z);
    expect(gap).toBeGreaterThan(2 * RUMBLE_BODY.capsuleRadius);
    expect(gap).toBeLessThan(3.5);
    expect(s.fighters.every((x) => x.combat.tumble < 0 && !x.eliminated)).toBe(true);
    expect(s.fighters[1].grounded).toBe(true);
    m.dispose();
  });

  it('holding a direction, or doing nothing, never breaks free (the hold lasts until thrown or its time is up)', () => {
    const m = holding();
    for (let k = 0; k < 120; k++) {
      m.setInput('B', { x: -1 });
      m.step(DT);
    }
    expect(f(m, 'B').heldBy).toBe('A');
    expect(f(m, 'B').combat.struggle).toBe(0);
    m.dispose();
  });

  it('the holder cannot grab the freed fighter again during its immunity; afterwards it can', () => {
    const m = holding();
    struggle(m, 3);
    expect(f(m, 'B').heldBy).toBeNull();
    // A grabs at once, and keeps trying, walking after B: refused while the immunity lasts.
    let regrabbed = -1;
    for (let k = 0; k < 120 && regrabbed < 0; k++) {
      const s = m.snapshot();
      const dx = s.fighters[1].position.x - s.fighters[0].position.x;
      const dz = s.fighters[1].position.z - s.fighters[0].position.z;
      const d = Math.hypot(dx, dz) || 1;
      m.setInput('A', { x: dx / d, z: dz / d, grab: k % 6 === 0 });
      m.setInput('B', {});
      for (const e of m.step(DT)) if (e.kind === 'grab' && e.on === 'B') regrabbed = k / 60;
    }
    expect(regrabbed).toBeGreaterThanOrEqual(STRUGGLE.regrabImmunity - 1 / 60);
    m.dispose();
  });
});

describe('throws and every other end of a hold', () => {
  it('a quick throw beats the struggle: thrown before the threshold, the struggle is cleared with the hold', () => {
    const m = holding();
    const events = struggle(m, 0.6, 12, true, (k) => {
      if (k === 30) m.setInput('A', { grab: true });
    });
    expect(events.some((e) => e.kind === 'throw' && e.who === 'A')).toBe(true);
    expect(events.some((e) => e.kind === 'escape')).toBe(false);
    expect(f(m, 'B').heldBy).toBeNull();
    expect(f(m, 'B').combat.struggle).toBe(0);
    m.dispose();
  });

  it('on the very step the struggle would finish, a throw wins (attacks resolve first, the struggle after)', () => {
    const m = holding();
    // Struggle to one stroke short of free.
    const k0 = m.tick;
    let k = 0;
    while (f(m, 'B').combat.struggle < 1 - 1 / STRUGGLE.strokes - 1e-6) {
      m.setInput('B', { x: Math.floor(k / 12) % 2 ? 1 : -1 });
      m.step(DT);
      k++;
      expect(m.tick - k0).toBeLessThan(300);
    }
    // Hold the side until the next reversal is due, then reverse AND throw in the same step.
    const side = Math.floor((k - 1) / 12) % 2 ? 1 : -1;
    for (let w = 0; w < 12; w++) {
      m.setInput('B', { x: side });
      m.step(DT);
    }
    m.setInput('B', { x: -side });
    m.setInput('A', { grab: true });
    const events = m.step(DT);
    expect(events.map((e) => e.kind)).toContain('throw');
    expect(events.map((e) => e.kind)).not.toContain('escape');
    expect(f(m, 'B').combat.struggle).toBe(0);
    expect(f(m, 'B').escapes).toBe(0);
    m.dispose();
  });

  it('a punch on the carrier ends the hold and the struggle with it', () => {
    const m = holding();
    struggle(m, 0.5, 12, false);
    expect(f(m, 'B').combat.struggle).toBeGreaterThan(0);
    m.debugPlace('C', { x: -1.4, z: 0, yaw: Math.PI / 2 });
    m.step(DT);
    m.setInput('C', { punch: true });
    const events: MatchEvent[] = [];
    for (let k = 0; k < 10; k++) events.push(...m.step(DT));
    expect(events.some((e) => e.kind === 'interrupt')).toBe(true);
    expect(f(m, 'B').heldBy).toBeNull();
    expect(f(m, 'B').combat.struggle).toBe(0);
    expect(m.holdsConsistent()).toBe(true);
    m.dispose();
  });

  it('a round reset in the middle of a struggle leaves nothing behind', () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }] });
    m.debugPlace('A', { x: -0.5, z: 0, yaw: Math.PI / 2 });
    m.debugPlace('B', { x: 0.4, z: 0 });
    m.step(DT);
    m.setInput('A', { grab: true });
    m.step(DT);
    struggle(m, 0.5, 12, false);
    expect(f(m, 'B').combat.struggle).toBeGreaterThan(0);
    // The carrier walks off the arena with it: A is rung out, B wins the round, and the next round starts clean.
    m.debugPlace('A', { x: 0, z: 6 });
    for (let k = 0; k < 60 + Math.ceil(ROUND.resetDelay * 60) + 10; k++) m.step(DT);
    const s = m.snapshot();
    expect(s.round).toBe(2);
    for (const x of s.fighters) {
      expect(x.heldBy).toBeNull();
      expect(x.holding).toBeNull();
      expect(x.combat.struggle).toBe(0);
      expect(x.combat.grabImmune).toBe(0);
    }
    m.dispose();
  });
});

describe('bots and the struggle', () => {
  /** B is a bot, held by A (who does nothing but hold, or throws at `throwAt` seconds). */
  function botHeld(throwAt: number | null, seconds: number) {
    const m = holding();
    const bot = new BotInput(5);
    const events: MatchEvent[] = [];
    const start = m.time;
    for (let k = 0; k < seconds * 60; k++) {
      const s = m.snapshot();
      bot.plan(botWorldFrom(s, 'B'), DT);
      m.setInput('B', bot.read());
      m.setInput('A', throwAt !== null && k === Math.round(throwAt * 60) ? { grab: true } : {});
      const e = m.step(DT);
      events.push(...e);
      if (e.some((x) => x.kind === 'escape' || x.kind === 'throw')) break;
    }
    return { m, events, start };
  }

  it('a held bot struggles free of a long hold in about two seconds, human-like', () => {
    const { m, events, start } = botHeld(null, 4);
    const escape = events.find((e) => e.kind === 'escape');
    expect(escape).toBeDefined();
    const seconds = escape!.t - start;
    expect(seconds).toBeGreaterThan(1.3);
    expect(seconds).toBeLessThan(2.8);
    m.dispose();
  });

  it('but not out of a quick throw', () => {
    const { m, events } = botHeld(0.6, 2);
    expect(events.some((e) => e.kind === 'throw')).toBe(true);
    expect(events.some((e) => e.kind === 'escape')).toBe(false);
    m.dispose();
  });

  /** The bot is A, the carrier, holding B at `at` (B in front, along +x); B struggles at a good pace. Returns the outcome. */
  function botCarries(at: { x: number; z: number }, strokeFrames = 12) {
    const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] });
    m.debugPlace('A', { ...at, yaw: Math.PI / 2 });
    m.debugPlace('B', { x: at.x + 0.9, z: at.z, yaw: -Math.PI / 2 });
    m.debugPlace('C', { x: -2.5, z: -2.5 });
    m.step(DT);
    m.setInput('A', { grab: true });
    m.step(DT);
    const bot = new BotInput(3);
    let outcome = '';
    for (let k = 0; k < 240 && !outcome; k++) {
      const s = m.snapshot();
      bot.plan(botWorldFrom(s, 'A'), DT);
      m.setInput('A', bot.read());
      m.setInput('B', k < 15 ? {} : { x: Math.floor((k - 15) / strokeFrames) % 2 ? 1 : -1 });
      for (const e of m.step(DT)) if (e.kind === 'throw' || e.kind === 'escape') outcome = e.kind;
    }
    m.dispose();
    return outcome;
  }

  it('a bot that grabs in the middle, and must carry, loses a victim struggling fast and well', () => {
    // Every rim is 4 m away: carrying into throwing range takes it over a second; a struggle at the cap takes about one.
    expect(botCarries({ x: -0.45, z: 0 }, 9)).toBe('escape');
  });

  it('near a rim, a bot whose victim wriggles hurries the throw instead of lining it up', () => {
    expect(botCarries({ x: -0.5, z: 2.7 })).toBe('throw');
  });
});

describe('authority', () => {
  it('no message can claim an escape or struggle progress: only the intent reaches the match', () => {
    for (const t of ['escape', 'struggle', 'breakFree', 'release']) expect(parseClientMessage(JSON.stringify({ t, progress: 1, id: 'B' }))).toBeNull();
    const m = parseClientMessage(JSON.stringify({ t: 'input', seq: 1, intent: { x: -1, struggle: 1, escaped: true } }));
    expect(m).toEqual({ t: 'input', seq: 1, intent: { x: -1, z: 0, run: false, jump: false, punch: false, grab: false } });
  });
});

describe('over the wire', () => {
  it('a networked victim breaks free by sending nothing but its movement intent; the server decides when', async () => {
    const { RumbleHost } = await import('../net/host');
    const { inputMessage } = await import('../net/protocol');
    const host = new RumbleHost({ havok });
    for (let c = 1; c <= 4; c++) host.connect(c);
    host.match.debugPlace('P1', { x: -0.5, z: 0, yaw: Math.PI / 2 });
    host.match.debugPlace('P2', { x: 0.4, z: 0, yaw: -Math.PI / 2 });
    host.match.debugPlace('P3', { x: -3, z: 3 });
    host.match.debugPlace('P4', { x: 3, z: -3 });
    host.tick();
    host.receive(1, JSON.stringify(inputMessage(1, { x: 0, z: 0, run: false }, { jump: false, punch: false, grab: true })));
    host.tick();
    expect(host.latest.fighters[1].heldBy).toBe('P1');
    let seq = 0;
    let freedAt = -1;
    for (let k = 0; k < 180 && freedAt < 0; k++) {
      // The victim's client sends its keys' movement on every change, as the real client does: left, right, left…
      if (k % 12 === 0) host.receive(2, JSON.stringify(inputMessage(++seq, { x: Math.floor(k / 12) % 2 ? 1 : -1, z: 0, run: false }, { jump: false, punch: false, grab: false })));
      host.tick();
      if (host.latest.fighters[1].heldBy === null) freedAt = k / 60;
      if (k % 3 === 0) expect(host.state().snapshot.fighters[1].combat.struggle).toBeLessThanOrEqual(1);
    }
    expect(freedAt).toBeGreaterThan(0.9);
    expect(host.latest.fighters[1].escapes).toBe(1);
    expect(host.latest.fighters[0].holding).toBeNull();
    host.dispose();
  });
});
