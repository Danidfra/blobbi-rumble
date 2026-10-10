/**
 * M12 through the authoritative host: a touch player is just a player.
 * The same play, once from keys and once from the stick and buttons, goes
 * over the same messages into the same match and moves the fighter the
 * same way; a touch player breaks a hold by tapping, at the server's capped
 * pace; and nothing a touch page could send asks for more than a key does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Keyboard, NET_BINDINGS, PlayerInput } from '../control/input';
import { TouchPad } from '../control/touch';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { STRUGGLE } from '../tuning';
import { RumbleHost } from './host';
import { inputMessage } from './protocol';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

/** A page's input for a player: a keyboard on a stand-in window, and a touch pad on a hand-moved clock. */
function page() {
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const target = { addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] ??= []).push(f) } as unknown as Window;
  const kb = new Keyboard([NET_BINDINGS], target);
  const clock = { t: 0 };
  const pad = new TouchPad(() => clock.t);
  pad.radius = 60;
  const input = new PlayerInput(kb, NET_BINDINGS);
  input.touch = pad;
  const key = (code: string, down: boolean) => handlers[down ? 'keydown' : 'keyup']?.forEach((f) => f({ code, repeat: false, target: null, preventDefault() {} }));
  return { input, pad, key, clock };
}

/** Two players in a host, both people (no bots); `drive(k)` is called before each tick and returns what P1's page sends. */
function run(frames: number, drive: (k: number, p: ReturnType<typeof page>) => void, setup?: (h: RumbleHost) => void) {
  const h = new RumbleHost({ havok, players: ['a', 'b'] });
  h.connect(1);
  h.connect(2);
  setup?.(h);
  const p = page();
  let seq = 0;
  for (let k = 0; k < frames; k++) {
    p.clock.t = k / 60;
    drive(k, p);
    const i = p.input.read(0);
    h.receive(1, JSON.stringify(inputMessage(++seq, i, i)));
    h.receive(2, JSON.stringify(inputMessage(seq, { x: 0, z: 0, run: false }, { jump: false, punch: false, grab: false })));
    h.tick();
  }
  const s = h.latest;
  h.dispose();
  return s;
}

describe('a touch player is a keyboard player to the server', () => {
  it('walk, run and jump from the stick and buttons move the fighter as the keys do', () => {
    const byKeys = run(90, (k, p) => {
      if (k === 0) p.key('KeyD', true);
      if (k === 30) p.key('ShiftLeft', true);
      if (k === 45) p.key('Space', true);
      if (k === 46) p.key('Space', false);
    });
    const byTouch = run(90, (k, p) => {
      // Within the walk band but at its top: a full walk, as D is (the stick's walk tops out just under the rim).
      if (k === 0) {
        p.pad.stickDown(1, 100, 300);
        p.pad.stickMove(1, 100 + 60 * 0.89, 300);
      }
      if (k === 30) p.pad.stickMove(1, 100 + 60, 300);
      if (k === 45) p.pad.buttonDown(2, 'jump', 'jump');
      if (k === 46) p.pad.up(2);
    });
    const a = byKeys.fighters.find((f) => f.id === 'a')!;
    const t = byTouch.fighters.find((f) => f.id === 'a')!;
    expect(a.jumps).toBe(1);
    expect(t.jumps).toBe(1);
    expect(t.position.x).toBeCloseTo(a.position.x, 1);
    expect(t.position.z).toBeCloseTo(a.position.z, 1);
    expect(t.position.x).toBeGreaterThan(1);
  });

  it('a held touch player breaks free by tapping, no sooner than the stroke cap allows', () => {
    let escapedAt = -1;
    const h = new RumbleHost({ havok, players: ['a', 'b'] });
    h.connect(1);
    h.connect(2);
    h.match.debugPlace('a', { x: 0.4, z: 0, yaw: -Math.PI / 2 });
    h.match.debugPlace('b', { x: -0.5, z: 0, yaw: Math.PI / 2 });
    h.tick();
    h.receive(2, JSON.stringify(inputMessage(1, { x: 0, z: 0, run: false }, { jump: false, punch: false, grab: true })));
    h.tick();
    expect(h.latest.fighters.find((f) => f.id === 'a')!.heldBy).toBe('b');
    const p = page();
    let seq = 0;
    let next = 0;
    for (let k = 0; k < 180 && escapedAt < 0; k++) {
      p.clock.t = k / 60;
      // Tapping as fast as a thumb can (20 a second): the cap decides, not the thumb.
      if (p.clock.t >= next) {
        p.pad.up(k);
        p.pad.buttonDown(k + 1, 'punch', 'struggle');
        next += 1 / 20;
      }
      const i = p.input.read(0);
      h.receive(1, JSON.stringify(inputMessage(++seq, i, i)));
      h.receive(2, JSON.stringify(inputMessage(seq + 1, { x: 0, z: 0, run: false }, { jump: false, punch: false, grab: false })));
      h.tick();
      if (!h.latest.fighters.find((f) => f.id === 'a')!.heldBy) escapedAt = k / 60;
    }
    h.dispose();
    expect(escapedAt).toBeGreaterThan(0);
    // Six counted strokes at no more than one per minInterval (after the slack credit): never quicker than that.
    expect(escapedAt).toBeGreaterThanOrEqual((STRUGGLE.strokes - STRUGGLE.credit) * STRUGGLE.minInterval - 1 / 60);
  });

  it('a forged message from a page (a direction longer than one) is cut to one by the server', () => {
    const fast = run(60, (_k, p) => p.key('KeyD', true));
    const h = new RumbleHost({ havok, players: ['a', 'b'] });
    h.connect(1);
    h.connect(2);
    for (let k = 0; k < 60; k++) {
      h.receive(1, JSON.stringify({ t: 'input', seq: k + 1, intent: { x: 25, z: 0, run: false } }));
      h.tick();
    }
    const forged = h.latest.fighters.find((f) => f.id === 'a')!;
    h.dispose();
    expect(forged.position.x).toBeCloseTo(fast.fighters.find((f) => f.id === 'a')!.position.x, 1);
  });
});
