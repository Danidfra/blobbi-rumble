/**
 * L4.4A: a press makes it from the page to the match, at any display rate.
 * The page's loop (keys or stick, a camera whose yaw carries float noise,
 * frames that jitter and stall) runs on a virtual clock into the server's
 * own rate limit, the host and the match: no input is dropped by the rate
 * limit at 30 to 240 frames a second, and every jump pressed is jumped.
 * A message lost on the way loses no press (the counts carry it); a
 * replayed, repeated or reordered message makes none; several presses in
 * one message all act; and nothing acts out of play.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Keyboard, NET_BINDINGS, PlayerInput } from '../control/input';
import { TouchPad } from '../control/touch';
import { InputPacer, quantizeMove } from '../client/inputPacer';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { ROUND } from '../tuning';
import { RumbleHost } from './host';
import { LIFECYCLE } from './lifecycle';
import { PressCounter, inputMessage, parseClientMessage } from './protocol';
import { SERVER_LIMITS, bucket } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

interface Run {
  fps: number;
  seconds: number;
  mode: 'keys' | 'stick';
  /** The page sends as it did before L4.4A (every frame that looks changed, no pacing, no counts). */
  legacy?: boolean;
  /** Frame-time jitter, as a share of the frame. */
  jitter?: number;
  /** A frame stall of this many ms every few seconds (a hitch, a GC). */
  stallMs?: number;
  /** The link drops these messages before the server reads them (index of the input message). */
  lose?: (index: number, msg: { intent: { jump: boolean } }) => boolean;
}

/** The page → server → match path on a virtual clock; returns what was pressed, sent, dropped and done. */
function deliver(o: Run) {
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let now = 0;
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const win = { addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] ??= []).push(f) } as unknown as Window;
  const key = (code: string, down: boolean) => handlers[down ? 'keydown' : 'keyup']?.forEach((f) => f({ code, repeat: false, target: null, preventDefault() {} }));
  const kb = new Keyboard([NET_BINDINGS], win);
  const input = new PlayerInput(kb, NET_BINDINGS);
  const pad = new TouchPad(() => now / 1000);
  pad.radius = 60;
  input.touch = pad;
  const host = new RumbleHost({ havok, players: ['P1', 'P2'] });
  host.connect(1);
  host.connect(2);
  const allow = bucket(SERVER_LIMITS.maxMessagesPerSecond, () => now);
  const pacer = new InputPacer();
  const st = { presses: 0, messages: 0, inputs: 0, rateDropped: 0, lost: 0, jumps: 0 };
  let seq = 0;
  let legacySent = '';
  let legacyAt = -1e9;
  const legacy = { jump: false, punch: false, grab: false };
  const toServer = (m: object, isInput: boolean) => {
    st.messages += 1;
    if (isInput && o.lose?.(st.inputs++, m as { intent: { jump: boolean } })) {
      st.lost += 1;
      return;
    }
    if (!allow()) {
      st.rateDropped += 1;
      return;
    }
    host.receive(1, JSON.stringify(m));
  };
  let nextFrame = 0;
  let nextTick = 0;
  let nextPing = 1000;
  let nextPress = 900;
  let nextStall = 2500;
  let jumpsSeen = 0;
  if (o.mode === 'keys') key('KeyD', true);
  else pad.stickDown(7, 100, 300);
  let side = 1;
  const end = o.seconds * 1000;
  while (now < end) {
    now = Math.min(nextFrame, nextTick, nextPing, nextPress);
    if (now === nextPress) {
      st.presses += 1;
      if (o.mode === 'stick') {
        pad.buttonDown(100 + st.presses, 'jump', 'jump');
        pad.up(100 + st.presses);
      } else {
        key('Space', true);
        key('Space', false);
      }
      nextPress += 1000 + rand() * 300;
      // The last half second has no press (one would be cut off by the end of the run, not lost).
      if (nextPress > end - 500) nextPress = Infinity;
      continue;
    }
    if (now === nextPing) {
      toServer({ t: 'ping', id: 1, ct: now }, false);
      nextPing += 1000;
      continue;
    }
    if (now === nextTick) {
      host.tick();
      const f = host.latest.fighters.find((x) => x.id === 'P1')!;
      st.jumps += f.jumps - jumpsSeen;
      jumpsSeen = f.jumps;
      nextTick += 1000 / 60;
      continue;
    }
    // A frame: a slowly turning camera with float noise, the stick's thumb wandering, back and forth to stay on the island.
    const yaw = 0.6 + 0.2 * Math.sin(now / 1500) + (rand() - 0.5) * 1e-12;
    if (Math.floor(now / 1000) % 2 !== (side > 0 ? 0 : 1)) {
      side = -side;
      if (o.mode === 'keys') {
        key(side > 0 ? 'KeyA' : 'KeyD', false);
        key(side > 0 ? 'KeyD' : 'KeyA', true);
      }
    }
    if (o.mode === 'stick') pad.stickMove(7, 100 + side * 40 + rand() * 3, 300 + rand() * 3);
    const intent = input.read(yaw);
    if (o.legacy) {
      legacy.jump ||= intent.jump;
      legacy.punch ||= intent.punch;
      legacy.grab ||= intent.grab;
      const move = { x: intent.x, z: intent.z, run: intent.run };
      if (JSON.stringify(move) !== legacySent || legacy.jump || now - legacyAt > 200) {
        toServer(inputMessage(++seq, move, legacy), true);
        legacy.jump = legacy.punch = legacy.grab = false;
        legacySent = JSON.stringify(move);
        legacyAt = now;
      }
    } else {
      pacer.press(intent);
      const move = quantizeMove({ x: intent.x, z: intent.z, run: intent.run });
      if (pacer.due(now, move)) {
        toServer(inputMessage(++seq, move, pacer.pending, pacer.presses), true);
        pacer.sent(now, move);
      }
    }
    let frame = (1000 / o.fps) * (1 + (rand() - 0.5) * (o.jitter ?? 0.1));
    if (o.stallMs && now >= nextStall) {
      frame += o.stallMs;
      nextStall += 2500;
    }
    nextFrame += frame;
  }
  host.dispose();
  return { ...st, perSecond: st.messages / o.seconds };
}

describe('high refresh rates (L4.4A, RC1)', () => {
  it('reproduces the old loss: sending every changed frame at 240 Hz overruns the server’s limit and loses jumps', () => {
    const r = deliver({ fps: 240, seconds: 20, mode: 'keys', legacy: true });
    expect(r.rateDropped).toBeGreaterThan(0);
    expect(r.jumps).toBeLessThan(r.presses);
  });

  it('keys at 30, 60, 120, 144 and 240 frames a second: nothing dropped by the rate limit, every jump jumped', () => {
    for (const fps of [30, 60, 120, 144, 240]) {
      const r = deliver({ fps, seconds: 20, mode: 'keys' });
      expect({ fps, rateDropped: r.rateDropped }).toEqual({ fps, rateDropped: 0 });
      expect(r.perSecond).toBeLessThan(90);
      expect({ fps, jumps: r.jumps }).toEqual({ fps, jumps: r.presses });
    }
  });

  it('the touch stick and Jump button at 60, 120 and 240 Hz: the same', () => {
    for (const fps of [60, 120, 240]) {
      const r = deliver({ fps, seconds: 20, mode: 'stick' });
      expect(r.rateDropped).toBe(0);
      expect({ fps, jumps: r.jumps }).toEqual({ fps, jumps: r.presses });
    }
  });

  it('heavy frame jitter and stalls (a hitch every 2.5 s): nothing dropped, every jump jumped', () => {
    for (const fps of [60, 144]) {
      const r = deliver({ fps, seconds: 20, mode: 'keys', jitter: 0.6, stallMs: 180 });
      expect(r.rateDropped).toBe(0);
      expect(r.jumps).toBe(r.presses);
    }
  });

  it('a link that loses every message carrying a jump flag still delivers every jump (the next message’s count carries it)', () => {
    const r = deliver({ fps: 144, seconds: 20, mode: 'keys', lose: (_i, m) => m.intent.jump });
    expect(r.lost).toBeGreaterThan(5);
    expect(r.jumps).toBe(r.presses);
  });
});

describe('the press counts on the server (L4.4A)', () => {
  const at = (h: RumbleHost, id: string) => h.latest.fighters.find((f) => f.id === id)!;
  const twoPeople = () => {
    const h = new RumbleHost({ havok, players: ['P1', 'P2'] });
    h.connect(1);
    h.connect(2);
    for (let i = 0; i < 30; i++) h.tick();
    return h;
  };
  const msg = (seq: number, presses: [number, number, number], flags: Partial<{ jump: boolean; punch: boolean; grab: boolean }> = {}) =>
    JSON.stringify(inputMessage(seq, { x: 0, z: 0, run: false }, { jump: false, punch: false, grab: false, ...flags }, presses));

  it('the counts are checked: three non-negative whole numbers, or the message is refused; without them, as before', () => {
    expect(parseClientMessage(msg(1, [0, 1, 2]))).toMatchObject({ t: 'input', seq: 1, presses: [0, 1, 2] });
    for (const bad of ['[1,2]', '[1,2,3,4]', '[-1,0,0]', '[1.5,0,0]', '["1",0,0]', '{"0":1}', 'null', '[1e300,0,0]']) {
      expect(parseClientMessage(`{"t":"input","seq":1,"intent":{"x":0,"z":0},"presses":${bad}}`)).toBeNull();
    }
    expect(parseClientMessage('{"t":"input","seq":1,"intent":{"x":0,"z":0,"jump":true}}')).toEqual({ t: 'input', seq: 1, intent: { x: 0, z: 0, run: false, jump: true, punch: false, grab: false } });
  });

  it('a count that went up is one press, whatever it went up by; the first counts are the baseline; counts never go back', () => {
    const c = new PressCounter();
    expect(c.take([5, 5, 5])).toEqual({ jump: false, punch: false, grab: false });
    expect(c.take([6, 5, 5])).toEqual({ jump: true, punch: false, grab: false });
    expect(c.take([6, 5, 5])).toEqual({ jump: false, punch: false, grab: false });
    expect(c.take([6, 500, 5])).toEqual({ jump: false, punch: true, grab: false });
    expect(c.take([1, 1, 1])).toEqual({ jump: false, punch: false, grab: false });
    expect(c.take([7, 500, 5])).toEqual({ jump: true, punch: false, grab: false });
    expect(c.take(undefined)).toEqual({ jump: false, punch: false, grab: false });
  });

  it('a dropped message loses no press: the next one, without its flag, carries it by its count', () => {
    const h = twoPeople();
    h.receive(1, msg(1, [0, 0, 0]));
    h.tick();
    const before = at(h, 'P1').jumps;
    // Message 2 (jump flag, count 1) never arrives; message 3 has no flag but the count.
    h.receive(1, msg(3, [1, 0, 0]));
    h.tick();
    expect(at(h, 'P1').jumps).toBe(before + 1);
    h.dispose();
  });

  it('a replayed, repeated or older message makes no action', () => {
    const h = twoPeople();
    h.receive(1, msg(1, [0, 0, 0]));
    h.tick();
    const before = at(h, 'P1').jumps;
    h.receive(1, msg(2, [1, 0, 0], { jump: true }));
    for (let i = 0; i < 60; i++) h.tick();
    expect(at(h, 'P1').jumps).toBe(before + 1);
    // The same message again, and an older one: refused by the sequence (and by the count).
    h.receive(1, msg(2, [1, 0, 0], { jump: true }));
    h.receive(1, msg(1, [1, 0, 0], { jump: true }));
    // A newer message with the count unchanged (a keepalive) and no flag: nothing.
    h.receive(1, msg(3, [1, 0, 0]));
    for (let i = 0; i < 60; i++) h.tick();
    expect(at(h, 'P1').jumps).toBe(before + 1);
    h.dispose();
  });

  it('several presses in one message all act: a jump, and a punch (the grab is judged first, with nobody near it takes nobody)', () => {
    const h = twoPeople();
    h.receive(1, msg(1, [0, 0, 0]));
    h.tick();
    const jumps = at(h, 'P1').jumps;
    h.receive(1, msg(2, [1, 1, 1], { jump: true, punch: true, grab: true }));
    h.tick();
    const f = at(h, 'P1');
    expect(f.jumps).toBe(jumps + 1);
    expect(f.combat.punchTime).toBeGreaterThanOrEqual(0);
    h.dispose();
  });

  it('several messages in one server tick keep every press', () => {
    const h = twoPeople();
    h.receive(1, msg(1, [0, 0, 0]));
    h.tick();
    const jumps = at(h, 'P1').jumps;
    h.receive(1, msg(2, [1, 0, 0], { jump: true }));
    h.receive(1, msg(3, [1, 1, 0], { punch: true }));
    h.receive(1, msg(4, [1, 1, 0]));
    h.tick();
    expect(at(h, 'P1').jumps).toBe(jumps + 1);
    expect(at(h, 'P1').combat.punchTime).toBeGreaterThanOrEqual(0);
    h.dispose();
  });

  it('a page that pushes its counts up on every message gets one action per message, never more, and the limit still holds', () => {
    let now = 0;
    const allow = bucket(SERVER_LIMITS.maxMessagesPerSecond, () => now);
    let kept = 0;
    for (let i = 0; i < 1000; i++) {
      now = i;
      if (allow()) kept += 1;
    }
    // 1000 messages in one second: the bucket keeps its burst and its rate, whatever the messages carry.
    expect(kept).toBeLessThanOrEqual(SERVER_LIMITS.maxMessagesPerSecond * 2 + 1);
    const c = new PressCounter();
    c.take([0, 0, 0]);
    const acts = [c.take([100, 100, 100]), c.take([200, 200, 200])].map((a) => [a.jump, a.punch, a.grab].filter(Boolean).length);
    expect(acts).toEqual([3, 3]);
  });

  it('nothing acts out of play: a press during the results, or after leaving, makes no punch or jump', () => {
    const h = new RumbleHost({ havok, lifecycle: 'lobby', players: ['P1', 'P2'] });
    h.connect(1);
    expect(h.command(1, { t: 'ready', ready: true })).toBeNull();
    h.tick();
    for (let i = 0; i < Math.ceil((LIFECYCLE.departSeconds + LIFECYCLE.arriveSeconds + 0.1) * h.tickHz); i++) h.tick();
    expect(h.lobby!.phase).toBe('playing');
    // P1 loses every round, to the results.
    for (let r = 0; r < ROUND.target; r++) {
      const s = h.state().snapshot;
      const pos = s.fighters[s.players.indexOf('P1')].position;
      h.match.debugPlace('P1', { x: pos.x, y: h.match.arena.fallY + 0.5, z: pos.z });
      for (let i = 0; i < Math.ceil((1 + ROUND.resetDelay + 0.3) * h.tickHz); i++) h.tick();
    }
    expect(h.lobby!.phase).toBe('results');
    const jumps = h.state().snapshot.fighters[0].jumps;
    h.receive(1, msg(100, [5, 5, 5], { jump: true, punch: true, grab: true }));
    for (let i = 0; i < 10; i++) h.tick();
    const f = h.state().snapshot.fighters[0];
    expect(f.jumps).toBe(jumps);
    expect(f.combat.punchTime).toBe(-1);
    // Gone: its messages reach nothing.
    h.disconnect(1);
    expect(h.receive(1, msg(101, [6, 6, 6], { jump: true, punch: true }))).toBeNull();
    h.dispose();
  });
});
