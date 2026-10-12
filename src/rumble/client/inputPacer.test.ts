/**
 * L4.4A: when the page sends its input. At most one message per interval
 * whatever the display's rate; the camera's floating-point noise is no
 * change; a press is latched until a message carries it and counted for
 * every later message; nothing latched while not playing fires later.
 */
import { describe, expect, it } from 'vitest';
import { cameraRelative } from '../control/input';
import { INPUT_PACING, InputPacer, quantizeMove } from './inputPacer';

const P = INPUT_PACING;

/** A page loop at `fps` for `seconds`, holding one direction under a camera whose yaw carries float noise; returns the messages sent. */
function loop(fps: number, seconds: number, opts: { noise?: number; press?: (frame: number) => boolean } = {}) {
  const pacer = new InputPacer();
  const sent: { at: number; move: { x: number; z: number; run: boolean }; jump: boolean; presses: readonly number[] }[] = [];
  let r = 7;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const frames = Math.round(fps * seconds);
  for (let k = 0; k < frames; k++) {
    const now = (k * 1000) / fps;
    const yaw = 0.7853981633974483 + (rand() - 0.5) * (opts.noise ?? 1e-12);
    const w = cameraRelative(1, 0, yaw);
    if (opts.press?.(k)) pacer.press({ jump: true });
    const move = quantizeMove({ x: w.x, z: w.z, run: false });
    if (pacer.due(now, move)) {
      sent.push({ at: now, move, jump: pacer.pending.jump, presses: pacer.presses });
      pacer.sent(now, move);
    }
  }
  return sent;
}

describe('the input pacer (L4.4A)', () => {
  it('quantizes a direction: the camera’s float noise is no change, and no negative zero', () => {
    const a = cameraRelative(1, 0, 0.7853981633974483);
    const b = cameraRelative(1, 0, 0.7853981633974483 + 3e-13);
    expect(a.x === b.x && a.z === b.z).toBe(false);
    expect(quantizeMove({ ...a, run: false })).toEqual(quantizeMove({ ...b, run: false }));
    expect(Object.is(quantizeMove({ x: -0.0001, z: 0, run: false }).x, -0)).toBe(false);
    const q = quantizeMove({ x: 0.70710678, z: -0.70710678, run: true });
    expect(q).toEqual({ x: 0.707, z: -0.707, run: true });
  });

  it('holding one direction under a noisy camera: only keepalives, at any display rate', () => {
    for (const fps of [30, 60, 120, 144, 240]) {
      const sent = loop(fps, 10);
      // One at the start, then one per keepalive.
      expect(sent.length).toBeLessThanOrEqual(Math.ceil(10_000 / P.keepaliveMs) + 2);
    }
  });

  it('a direction changing every frame: never more than one message per interval, at any display rate', () => {
    for (const fps of [60, 120, 144, 165, 240, 360]) {
      const sent = loop(fps, 10, { noise: 0.5 });
      const perSecond = sent.length / 10;
      expect(perSecond).toBeLessThanOrEqual(1000 / P.minIntervalMs + 1);
      for (let i = 1; i < sent.length; i++) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(P.minIntervalMs - 1e-9);
      // Comfortably under the server's 120 a second, with room for pings and lobby messages.
      expect(perSecond).toBeLessThan(90);
    }
    // At 60 Hz every frame may still send (16.7 ms > the interval): no added delay on the common display.
    expect(loop(60, 10, { noise: 0.5 }).length).toBeGreaterThanOrEqual(599);
  });

  it('a press is never lost to the interval: it is latched until the next message, which carries it and its count', () => {
    for (const fps of [30, 60, 144, 240]) {
      // A press on every 7th frame: always some inside the interval after a message.
      const presses = new Set<number>();
      const sent = loop(fps, 5, { noise: 0.5, press: (k) => (k % 7 === 3 ? (presses.add(k), true) : false) });
      const counted = sent[sent.length - 1].presses[0];
      expect(counted).toBe(presses.size);
      // Every press reached a message flagged with it (two presses in one interval share one).
      expect(sent.filter((m) => m.jump).length).toBeGreaterThan(0);
      for (let i = 1; i < sent.length; i++) expect(sent[i].presses[0]).toBeGreaterThanOrEqual(sent[i - 1].presses[0]);
    }
  });

  it('a press goes out with the very next message, even with the movement unchanged', () => {
    const pacer = new InputPacer();
    const move = { x: 0, z: 0, run: false };
    expect(pacer.due(0, move)).toBe(true);
    pacer.sent(0, move);
    expect(pacer.due(50, move)).toBe(false);
    pacer.press({ punch: true, grab: true });
    expect(pacer.due(5, move)).toBe(false);
    expect(pacer.due(50, move)).toBe(true);
    expect(pacer.pending).toEqual({ jump: false, punch: true, grab: true });
    expect(pacer.presses).toEqual([0, 1, 1]);
    pacer.sent(50, move);
    expect(pacer.pending).toEqual({ jump: false, punch: false, grab: false });
    expect(pacer.presses).toEqual([0, 1, 1]);
  });

  it('nothing latched while not playing fires later; a new connection counts from zero', () => {
    const pacer = new InputPacer();
    pacer.press({ jump: true });
    pacer.drop();
    expect(pacer.pending.jump).toBe(false);
    expect(pacer.unsent({ x: 0, z: 0, run: false })).toBe(true);
    pacer.sent(0, { x: 0, z: 0, run: false });
    expect(pacer.unsent({ x: 0, z: 0, run: false })).toBe(false);
    pacer.reset();
    expect(pacer.presses).toEqual([0, 0, 0]);
    expect(pacer.due(0, { x: 0, z: 0, run: false })).toBe(true);
  });

  it('a backed-up socket gets nothing more queued; the press waits, counted, for when it drains', () => {
    const pacer = new InputPacer();
    const move = { x: 1, z: 0, run: false };
    pacer.sent(0, { x: 0, z: 0, run: false });
    pacer.press({ jump: true });
    expect(pacer.due(100, move, P.maxBacklog + 1)).toBe(false);
    expect(pacer.due(100, move, 0)).toBe(true);
    expect(pacer.presses[0]).toBe(1);
  });
});
