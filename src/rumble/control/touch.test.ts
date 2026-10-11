/**
 * M12 touch input as pure logic: the stick's direction, strength, dead zone
 * and run; fingers tracked apart (move and attack at once); every way a
 * finger can go (lift, cancel, focus lost) letting go; the buttons' roles
 * in each moment; and the touch intent being the keyboard's intent, so the
 * server sees one kind of player.
 */
import { describe, expect, it } from 'vitest';
import { parseClientMessage, inputMessage } from '../net/protocol';
import { IDLE_INTENT, sanitizeIntent } from '../sim/intent';
import type { FighterSnapshot } from '../sim/snapshot';
import { createCombatState } from '../combat/combat';
import { stepStruggle } from '../combat/struggle';
import { catchLedge, createLedgeState, tickLedge } from '../sim/ledge';
import { BANANAS, LEDGE, STRUGGLE } from '../tuning';
import { moveAim, wantsThrow } from './aim';
import { Keyboard, NET_BINDINGS, PlayerInput, cameraRelative, moveIntent } from './input';
import { STICK, dragBase, stickOutput } from './stick';
import { TOUCH, TouchPad, touchButtons, touchContext } from './touch';

const R = 60;
/** A clock the test moves by hand. */
const clock = () => {
  const c = { t: 0, now: () => c.t };
  return c;
};
/** A keyboard listening to a stand-in window (no browser): keys go in by `key`. */
function fakeKeyboard() {
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const target = { addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] ??= []).push(f) } as unknown as Window;
  const kb = new Keyboard([NET_BINDINGS], target);
  const fire = (k: string, e: object) => handlers[k]?.forEach((f) => f({ preventDefault() {}, target: null, repeat: false, ...e }));
  return { kb, key: (code: string, down: boolean) => fire(down ? 'keydown' : 'keyup', { code }), blur: () => fire('blur', {}) };
}

describe('the stick', () => {
  it('points where the thumb is: right is +x, up the screen is +y (away from the camera)', () => {
    expect(stickOutput(R, 0, R)).toMatchObject({ x: 1, y: 0, run: true });
    expect(stickOutput(0, -R, R)).toMatchObject({ x: 0, y: 1, run: true });
    expect(stickOutput(-R, 0, R)).toMatchObject({ x: -1, y: 0 });
    const d = stickOutput(R, R, R);
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(d.y).toBeCloseTo(-Math.SQRT1_2, 3);
  });

  it('has a dead zone: a resting or trembling thumb is no movement', () => {
    for (const r of [0, 0.05, 0.1, STICK.deadZone - 0.01]) expect(stickOutput(r * R, 0, R)).toMatchObject({ x: 0, y: 0, magnitude: 0, run: false });
    expect(stickOutput((STICK.deadZone + 0.02) * R, 0, R).magnitude).toBeGreaterThan(0);
  });

  it('walks from a slow walk up to a full walk, runs only at the rim, and is never longer than one', () => {
    const just = stickOutput((STICK.deadZone + 0.001) * R, 0, R);
    expect(just.magnitude).toBeCloseTo(STICK.minWalk, 1);
    expect(just.run).toBe(false);
    let last = 0;
    for (let r = STICK.deadZone + 0.01; r < STICK.runAt; r += 0.05) {
      const o = stickOutput(r * R, 0, R);
      expect(o.magnitude).toBeGreaterThanOrEqual(last);
      expect(o.run).toBe(false);
      last = o.magnitude;
    }
    expect(stickOutput(STICK.runAt * R, 0, R)).toMatchObject({ magnitude: 1, run: true });
    // Far beyond the rim: still one, the same as a key.
    for (const a of [0, 0.7, 2.1, 4]) {
      const o = stickOutput(Math.cos(a) * 9 * R, Math.sin(a) * 9 * R, R);
      expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('is smooth in every direction (no snapping to eight), and quantised so a still thumb repeats the same numbers', () => {
    const seen = new Set<string>();
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 40) {
      const o = stickOutput(Math.cos(a) * R, -Math.sin(a) * R, R);
      expect(Math.atan2(o.y, o.x)).toBeCloseTo(Math.atan2(Math.sin(a), Math.cos(a)), 1);
      seen.add(`${o.x},${o.y}`);
    }
    expect(seen.size).toBeGreaterThan(40);
    const a = stickOutput(31.2, -20.4, R);
    const b = stickOutput(31.25, -20.41, R);
    expect(b).toEqual(a);
  });

  it('a response curve above one gives finer control at small deflections', () => {
    const mid = (STICK.deadZone + STICK.runAt) / 2;
    const linear = stickOutput(mid * R, 0, R).magnitude;
    const curved = stickOutput(mid * R, 0, R, { ...STICK, curve: 2 }).magnitude;
    expect(curved).toBeLessThan(linear);
  });

  it('ignores nonsense (no radius, non-finite offsets)', () => {
    expect(stickOutput(10, 10, 0).magnitude).toBe(0);
    expect(stickOutput(NaN, 10, R).magnitude).toBe(0);
    expect(stickOutput(Infinity, 0, R).magnitude).toBe(0);
  });

  it('a floating base follows a thumb that goes past the rim, and stays put within it', () => {
    expect(dragBase({ x: 0, y: 0 }, { x: 30, y: 0 }, R)).toEqual({ x: 0, y: 0 });
    const b = dragBase({ x: 0, y: 0 }, { x: 100, y: 0 }, R);
    expect(b.x).toBeCloseTo(40, 6);
    expect(b.y).toBeCloseTo(0, 6);
  });
});

describe('the touch pad', () => {
  it('the stick follows the finger that took it, from wherever it landed (floating), until that finger lifts', () => {
    const p = new TouchPad();
    p.radius = R;
    expect(p.stickDown(1, 200, 300)).toBe(true);
    p.stickMove(1, 200 + R, 300);
    expect(p.movement()).toMatchObject({ x: 1, y: 0, run: true });
    // A second finger in the stick's area does not steal it, and its moves do nothing.
    expect(p.stickDown(2, 100, 100)).toBe(false);
    p.stickMove(2, 0, 0);
    expect(p.movement().x).toBe(1);
    p.up(1);
    expect(p.movement()).toMatchObject({ x: 0, y: 0, magnitude: 0, run: false });
  });

  it('moves and attacks at once: a stick finger and a button finger are independent', () => {
    const p = new TouchPad();
    p.radius = R;
    p.stickDown(1, 100, 300);
    p.stickMove(1, 100, 300 - R);
    p.buttonDown(2, 'punch', 'punch');
    p.buttonDown(3, 'jump', 'jump');
    expect(p.fingers).toBe(3);
    expect(p.movement().y).toBe(1);
    expect(p.take('punch')).toBe(true);
    expect(p.take('jump')).toBe(true);
    // Lifting the punch finger leaves the stick alone.
    p.up(2);
    expect(p.isDown('punch')).toBe(false);
    expect(p.isDown('jump')).toBe(true);
    expect(p.movement().y).toBe(1);
  });

  it('a press fires once (no auto-repeat while held), and again only after another press', () => {
    const p = new TouchPad();
    p.buttonDown(5, 'punch', 'punch');
    expect(p.take('punch')).toBe(true);
    expect(p.take('punch')).toBe(false);
    expect(p.isDown('punch')).toBe(true);
    p.up(5);
    expect(p.isDown('punch')).toBe(false);
    p.buttonDown(6, 'punch', 'punch');
    expect(p.take('punch')).toBe(true);
  });

  it('a cancelled or lost finger lets go like a lifted one; releaseAll lets go of everything, unread presses too', () => {
    const p = new TouchPad();
    p.radius = R;
    p.stickDown(1, 0, 0);
    p.stickMove(1, R, 0);
    p.buttonDown(2, 'grab', 'grab');
    p.releaseAll();
    expect(p.fingers).toBe(0);
    expect(p.movement().magnitude).toBe(0);
    expect(p.take('grab')).toBe(false);
    expect(p.isDown('grab')).toBe(false);
    // An unknown finger lifting is harmless.
    p.up(99);
    expect(p.fingers).toBe(0);
  });

  it('a finger on the stick cannot also press a button', () => {
    const p = new TouchPad();
    p.stickDown(1, 0, 0);
    p.buttonDown(1, 'jump', 'jump');
    expect(p.take('jump')).toBe(false);
  });

  it('a struggle press is one stroke to one side, the next to the other; the stroke lasts a moment, over several server ticks', () => {
    const c = clock();
    const p = new TouchPad(c.now);
    p.buttonDown(1, 'punch', 'struggle');
    const first = p.movement().x;
    expect(Math.abs(first)).toBe(1);
    c.t += TOUCH.strokeTime / 2;
    expect(p.movement().x).toBe(first);
    expect(TOUCH.strokeTime).toBeGreaterThanOrEqual(3 / 60);
    c.t += TOUCH.strokeTime;
    expect(p.movement().magnitude).toBe(0);
    p.up(1);
    p.buttonDown(2, 'punch', 'struggle');
    expect(p.movement().x).toBe(-first);
    // No action is requested by a stroke.
    expect(p.take('punch')).toBe(false);
    p.releaseAll();
    expect(p.movement().magnitude).toBe(0);
  });
});

describe('the touch intent is the keyboard intent', () => {
  it('full deflection is exactly the key: the same intent, the same message, under any camera', () => {
    for (const yaw of [0, 0.4, Math.PI / 2, -2.2]) {
      const keys = moveIntent(new Set(['KeyD']), yaw, NET_BINDINGS);
      const stick = moveIntent(new Set(), yaw, NET_BINDINGS, {}, stickOutput(R * 0.7, 0, R * 0.7));
      expect(stick.x).toBeCloseTo(keys.x, 3);
      expect(stick.z).toBeCloseTo(keys.z, 3);
      const run = moveIntent(new Set(['KeyW', 'ShiftLeft']), yaw, NET_BINDINGS);
      const rim = moveIntent(new Set(), yaw, NET_BINDINGS, {}, stickOutput(0, -R, R));
      expect(rim.run).toBe(run.run);
      expect(rim.x).toBeCloseTo(run.x, 3);
      expect(rim.z).toBeCloseTo(run.z, 3);
    }
  });

  it('a thumb on the stick steers instead of the keys; no thumb leaves the keys', () => {
    const k = moveIntent(new Set(['KeyW']), 0, NET_BINDINGS, {}, { x: 0, y: 0, run: false });
    expect(k.z).toBe(1);
    const s = moveIntent(new Set(['KeyW']), 0, NET_BINDINGS, {}, { x: 1, y: 0, run: false });
    expect(s.x).toBe(1);
    expect(s.z).toBeCloseTo(0, 9);
    expect(cameraRelative(0, 1, 0)).toEqual({ x: 0, z: 1 });
  });

  it('PlayerInput merges both: presses from either, taken once; disabled, nothing passes but the presses are still consumed', () => {
    const { kb, key, blur } = fakeKeyboard();
    const input = new PlayerInput(kb, NET_BINDINGS);
    const pad = new TouchPad();
    pad.radius = R;
    input.touch = pad;
    pad.stickDown(1, 0, 0);
    pad.stickMove(1, 0, -R);
    pad.buttonDown(2, 'punch', 'punch');
    key('KeyG', true);
    const a = input.read(0);
    expect(a).toMatchObject({ punch: true, grab: true, jump: false, run: true });
    expect(a.z).toBeCloseTo(1, 6);
    const b = input.read(0);
    expect(b).toMatchObject({ punch: false, grab: false });
    pad.buttonDown(3, 'jump', 'jump');
    input.enabled = false;
    expect(input.read(0)).toEqual({ ...IDLE_INTENT });
    input.enabled = true;
    expect(input.read(0).jump).toBe(false);
    // Focus lost: the keyboard lets go; release() lets go of both.
    key('KeyW', true);
    blur();
    expect(kb.held.size).toBe(0);
    input.release();
    expect(input.read(0)).toMatchObject({ x: 0, z: 0, run: false });
  });

  it('the server reads a touch message as it reads a key message, and no touch can ask for more than a key', () => {
    const keyMsg = inputMessage(7, moveIntent(new Set(['KeyD']), 0.3, NET_BINDINGS), { jump: true, punch: false, grab: false });
    const touchMsg = inputMessage(7, moveIntent(new Set(), 0.3, NET_BINDINGS, {}, stickOutput(R * 0.95, 0, R * 0.95)), { jump: true, punch: false, grab: false });
    const k = parseClientMessage(JSON.stringify(keyMsg));
    const t = parseClientMessage(JSON.stringify(touchMsg));
    expect(k && t && k.t === 'input' && t.t === 'input').toBe(true);
    if (k?.t !== 'input' || t?.t !== 'input') return;
    expect(t.intent.x).toBeCloseTo(k.intent.x, 3);
    expect(t.intent.z).toBeCloseTo(k.intent.z, 3);
    // Whatever a page sends, the direction is at most one and the flags are booleans.
    const forged = parseClientMessage(JSON.stringify({ t: 'input', seq: 8, intent: { x: 40, z: -30, run: true } }));
    expect(forged?.t === 'input' && Math.hypot(forged.intent.x, forged.intent.z)).toBeCloseTo(1, 9);
    expect(Math.hypot(sanitizeIntent({ x: 3, z: 4 }).x, sanitizeIntent({ x: 3, z: 4 }).z)).toBeCloseTo(1, 9);
  });
});

describe('breaking free by touch', () => {
  /** Progress after `seconds` of a held fighter's struggle, fed one movement a 1/60 s step. */
  const progress = (seconds: number, move: (t: number) => { x: number; z: number }) => {
    const c = createCombatState();
    for (let k = 0; k < Math.round(seconds * 60); k++) stepStruggle(c, move(k / 60), 1 / 60);
    return c.struggle;
  };
  /** Tapping the break-free button `rate` times a second, through the pad (camera yaw 0). */
  const taps = (rate: number) => {
    const ck = clock();
    const pad = new TouchPad(ck.now);
    let next = 0;
    let id = 0;
    return (t: number) => {
      ck.t = t;
      if (t >= next) {
        pad.up(id);
        pad.buttonDown(++id, 'punch', 'struggle');
        next += 1 / rate;
      }
      const m = pad.movement();
      return moveIntent(new Set(), 0, NET_BINDINGS, {}, m);
    };
  };
  /** A keyboard player alternating A and D `rate` times a second (each key held half the beat). */
  const keys = (rate: number) => (t: number) => {
    const beat = Math.floor(t * rate);
    const on = t * rate - beat < 0.5;
    return on ? { x: beat % 2 ? 1 : -1, z: 0 } : { x: 0, z: 0 };
  };

  it('tapping breaks free as alternating keys do, at the same pace', () => {
    for (const rate of [4, 5, 6]) {
      const t = progress(1, taps(rate));
      const k = progress(1, keys(rate));
      expect(Math.abs(t - k)).toBeLessThanOrEqual(1 / STRUGGLE.strokes + 1e-9);
    }
    // A good rhythm escapes in about the time the keys take (six strokes).
    expect(progress(1.6, taps(5))).toBe(1);
  });

  it('tapping faster than the cap gains nothing over the cap: never faster than keys mashed just as fast', () => {
    const fast = progress(0.6, taps(30));
    const capped = progress(0.6, keys(30));
    const cap = Math.min(1, ((0.6 / STRUGGLE.minInterval + STRUGGLE.credit) / STRUGGLE.strokes));
    expect(fast).toBeLessThanOrEqual(cap + 1e-9);
    expect(fast).toBeLessThanOrEqual(Math.max(capped, cap) + 1e-9);
  });

  it('wiggling the stick left-right counts too (it is the same movement)', () => {
    const ck = clock();
    const pad = new TouchPad(ck.now);
    pad.radius = R;
    pad.stickDown(1, 0, 0);
    let side = 1;
    const wiggle = (t: number) => {
      const beat = Math.floor(t * 5);
      side = beat % 2 ? 1 : -1;
      // The thumb travels across: the base trails it, so the reversal is always a full stroke.
      pad.stickMove(1, (pad.stickView?.base.x ?? 0) + side * R, 0);
      return moveIntent(new Set(), 0, NET_BINDINGS, {}, pad.movement());
    };
    expect(progress(1.6, wiggle)).toBe(1);
  });
});

describe('ledge and banana by touch', () => {
  const ledge = { platform: 0, x: 2, y: 0, z: -4, inX: 0, inZ: 1 };
  it('Climb is the jump: a hanging fighter climbs; Let go is the grab: it lets go', () => {
    const faces = touchButtons('ledge');
    expect(faces.jump).toMatchObject({ role: 'jump', label: 'Climb' });
    expect(faces.grab).toMatchObject({ role: 'grab', label: 'Let go' });
    const pad = new TouchPad();
    const { kb } = fakeKeyboard();
    const input = new PlayerInput(kb, NET_BINDINGS);
    input.touch = pad;
    const s = createLedgeState();
    catchLedge(s, ledge);
    pad.buttonDown(1, 'jump', faces.jump.role);
    expect(tickLedge(s, 1 / 60, input.read(0))).toBe('climbing');
    const s2 = createLedgeState();
    catchLedge(s2, ledge);
    pad.buttonDown(2, 'grab', faces.grab.role);
    expect(tickLedge(s2, 1 / 60, input.read(0))).toBe('let go');
  });

  it('the stick toward the wall keeps hanging; held away (down the screen, with the wall ahead) lets go, as the keys do', () => {
    const pad = new TouchPad();
    pad.radius = R;
    const { kb } = fakeKeyboard();
    const input = new PlayerInput(kb, NET_BINDINGS);
    input.touch = pad;
    const s = createLedgeState();
    catchLedge(s, ledge);
    pad.stickDown(1, 0, 0);
    pad.stickMove(1, 0, -R);
    for (let k = 0; k < 60; k++) expect(tickLedge(s, 1 / 60, input.read(0))).toBe('hanging');
    pad.stickMove(1, 0, R);
    let out = 'hanging';
    for (let k = 0; k < Math.ceil((LEDGE.awayHold + 0.1) * 60) && out === 'hanging'; k++) out = tickLedge(s, 1 / 60, input.read(0));
    expect(out).toBe('let go');
  });

  it('out of the round the stick moves the aim no faster than the keys, and Throw asks only when a peel could go', () => {
    const clamp = (p: { x: number; z: number }) => ({ x: Math.max(-5, Math.min(5, p.x)), z: Math.max(-5, Math.min(5, p.z)) });
    const byKey = moveAim({ x: 0, z: 0 }, moveIntent(new Set(['KeyD']), 0, NET_BINDINGS), 1, clamp);
    const byStick = moveAim({ x: 0, z: 0 }, moveIntent(new Set(), 0, NET_BINDINGS, {}, stickOutput(R, 0, R)), 1, clamp);
    expect(byStick.x).toBeCloseTo(byKey.x, 3);
    expect(byKey.x).toBeCloseTo(BANANAS.aimSpeed, 6);
    expect(moveAim({ x: 0, z: 0 }, { x: 50, z: 0 }, 1, clamp).x).toBeCloseTo(BANANAS.aimSpeed, 6);
    expect(moveAim({ x: 4, z: 0 }, { x: 1, z: 0 }, 1, clamp).x).toBe(5);
    const faces = touchButtons('out', { left: 2, cooldown: 0, allowed: true });
    expect(faces.punch).toMatchObject({ role: 'punch', label: 'Throw', active: true });
    expect(faces.jump.visible).toBe(false);
    expect(touchButtons('out', { left: 2, cooldown: 1.2, allowed: true }).punch.active).toBe(false);
    expect(touchButtons('out', { left: 0, cooldown: 0, allowed: true }).punch.active).toBe(false);
    expect(wantsThrow({ punch: true, grab: false }, { left: 1, cooldown: 0 })).toBe(true);
    expect(wantsThrow({ punch: true, grab: false }, { left: 0, cooldown: 0 })).toBe(false);
    expect(wantsThrow({ punch: false, grab: true }, { left: 2, cooldown: 0.5 })).toBe(false);
    expect(wantsThrow({ punch: false, grab: false }, { left: 2, cooldown: 0 })).toBe(false);
  });
});

describe('the buttons in each moment', () => {
  const fighter = (patch: Partial<FighterSnapshot>): FighterSnapshot => ({ eliminated: false, heldBy: null, holding: null, ledge: null, ...patch }) as FighterSnapshot;
  it('reads the moment from the fighter and the phase', () => {
    expect(touchContext(null, 'playing')).toBe('waiting');
    expect(touchContext(fighter({}), 'roundOver')).toBe('waiting');
    expect(touchContext(fighter({}), 'playing')).toBe('fight');
    expect(touchContext(fighter({ holding: 'P2' }), 'playing')).toBe('holding');
    expect(touchContext(fighter({ heldBy: 'P2' }), 'playing')).toBe('held');
    expect(touchContext(fighter({ ledge: { phase: 'hang', x: 0, y: 0, z: 0, inX: 0, inZ: 1, grip: 1 } }), 'playing')).toBe('ledge');
    expect(touchContext(fighter({ eliminated: true }), 'playing')).toBe('out');
    expect(touchContext(fighter({ ledge: { phase: 'climb', x: 0, y: 0, z: 0, inX: 0, inZ: 1, grip: 1 } }), 'playing')).toBe('climbing');
    expect(touchButtons('climbing').jump).toMatchObject({ label: 'Climbing…', active: false });
  });

  it('grab and throw are one button (as G is one key); held, the big button breaks free; no moment invents an action', () => {
    expect(touchButtons('fight')).toMatchObject({ punch: { role: 'punch' }, jump: { role: 'jump' }, grab: { role: 'grab', label: 'Grab' } });
    expect(touchButtons('holding').grab).toMatchObject({ role: 'grab', label: 'Throw' });
    expect(touchButtons('held').punch).toMatchObject({ role: 'struggle', label: 'Break free', active: true });
    for (const ctx of ['fight', 'holding', 'held', 'ledge', 'climbing', 'out', 'waiting'] as const) {
      for (const f of Object.values(touchButtons(ctx, { left: 1, cooldown: 0, allowed: true }))) expect(['jump', 'punch', 'grab', 'struggle']).toContain(f.role);
    }
  });
});

describe('touch on the plaza (L4)', () => {
  const me = { eliminated: false, heldBy: null, ledge: null, holding: null } as unknown as FighterSnapshot;
  it('a fighter on the plaza has the walking context; a watcher waits', () => {
    expect(touchContext(me, 'playing', true)).toBe('social');
    expect(touchContext(null, 'playing', true)).toBe('waiting');
    expect(touchContext(me, 'playing')).toBe('fight');
  });
  it('Jump only: the combat buttons are not shown at all', () => {
    const b = touchButtons('social');
    expect(b.jump).toMatchObject({ role: 'jump', visible: true, active: true });
    expect(b.punch.visible).toBe(false);
    expect(b.grab.visible).toBe(false);
  });
});
