/**
 * M12, the touch controls' page side: when a page offers them (never from
 * a user agent), when it asks to turn the phone, and, with a stand-in DOM,
 * that fingers on the stick and the buttons reach the pad, that a hidden
 * control lets go of everything, and that interruptions (cancel, focus
 * lost, the page hidden, the screen turned) leave nothing held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needsRotate, prefersTouch } from './touchControls';

describe('offering touch controls', () => {
  it('a finger as the main pointer, or ?touch=1; ?touch=0 never', () => {
    expect(prefersTouch('', true)).toBe(true);
    expect(prefersTouch('', false)).toBe(false);
    expect(prefersTouch('?touch=1', false)).toBe(true);
    expect(prefersTouch('?network=1&touch=0', true)).toBe(false);
  });

  it('asks to turn only a touch phone held upright, until the player plays on', () => {
    expect(needsRotate({ width: 390, height: 844, touch: true, dismissed: false })).toBe(true);
    expect(needsRotate({ width: 844, height: 390, touch: true, dismissed: false })).toBe(false);
    expect(needsRotate({ width: 390, height: 844, touch: false, dismissed: false })).toBe(false);
    expect(needsRotate({ width: 390, height: 844, touch: true, dismissed: true })).toBe(false);
    // A tablet upright is roomy enough.
    expect(needsRotate({ width: 820, height: 1180, touch: true, dismissed: false })).toBe(false);
  });
});

/** The least of a DOM the controls use: elements with listeners, classes and styles; a window and a document. */
class FakeEl {
  readonly children: FakeEl[] = [];
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  className = '';
  textContent = '';
  captured = new Set<number>();
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c);
      const want = on ?? !has;
      const set = new Set(this.className.split(' ').filter(Boolean));
      if (want) set.add(c);
      else set.delete(c);
      this.className = [...set].join(' ');
      return want;
    },
    contains: (c: string) => this.className.split(' ').includes(c),
  };
  constructor(readonly tagName: string) {}
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  append(...c: FakeEl[]) {
    this.children.push(...c);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: (e: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  fire(k: string, e: object = {}) {
    for (const f of this.listeners[k] ?? []) f({ preventDefault() {}, stopPropagation() {}, ...e });
  }
  find(cls: string): FakeEl | null {
    if (this.className.split(' ').includes(cls)) return this;
    for (const c of this.children) {
      const f = c.find(cls);
      if (f) return f;
    }
    return null;
  }
}

describe('the touch controls on a page', () => {
  const g = globalThis as Record<string, unknown>;
  let win: FakeEl;
  let doc: FakeEl & { head: FakeEl; body: FakeEl; hidden: boolean; createElement: (t: string) => FakeEl };
  beforeEach(() => {
    win = new FakeEl('window');
    Object.assign(win, { innerWidth: 844, innerHeight: 390 });
    doc = Object.assign(new FakeEl('document'), { head: new FakeEl('head'), body: new FakeEl('body'), hidden: false, createElement: (t: string) => new FakeEl(t.toUpperCase()) });
    g.window = win;
    g.document = doc;
  });
  afterEach(() => {
    delete g.window;
    delete g.document;
  });

  const make = async () => {
    const { TouchControls } = await import('./touchControls');
    const c = new TouchControls();
    const root = doc.body.children[0];
    return { c, zone: root.find('tc-zone')!, punch: root.find('punch')!, jump: root.find('jump')!, grab: root.find('grab')!, root };
  };

  it('stays hidden and deaf until shown; shown, a thumb on the stick moves and a finger on a button presses, at the same time', async () => {
    const { c, zone, punch } = await make();
    zone.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    expect(c.pad.fingers).toBe(0);
    c.update({ visible: true, context: 'fight' });
    zone.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    zone.fire('pointermove', { pointerId: 1, clientX: 100 + c.pad.radius, clientY: 300 });
    punch.fire('pointerdown', { pointerId: 2 });
    expect(c.pad.movement()).toMatchObject({ x: 1, run: true });
    expect(c.pad.take('punch')).toBe(true);
    expect(punch.classList.contains('down')).toBe(true);
    expect(zone.captured.has(1) && punch.captured.has(2)).toBe(true);
    punch.fire('pointerup', { pointerId: 2 });
    expect(punch.classList.contains('down')).toBe(false);
    expect(c.pad.movement().x).toBe(1);
  });

  it('a cancelled touch, a lost capture, focus lost, the page hidden, the screen turned: nothing stays held', async () => {
    const { c, zone, grab } = await make();
    c.update({ visible: true, context: 'fight' });
    const hold = () => {
      zone.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
      zone.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 0 });
      grab.fire('pointerdown', { pointerId: 2 });
      expect(c.pad.fingers).toBe(2);
    };
    hold();
    zone.fire('pointercancel', { pointerId: 1 });
    grab.fire('lostpointercapture', { pointerId: 2 });
    expect(c.pad.fingers).toBe(0);
    for (const [target, k] of [[win, 'blur'], [win, 'orientationchange']] as const) {
      hold();
      target.fire(k);
      expect(c.pad.fingers).toBe(0);
      expect(c.pad.movement().magnitude).toBe(0);
    }
    hold();
    doc.hidden = true;
    doc.fire('visibilitychange');
    expect(c.pad.fingers).toBe(0);
  });

  it('hidden (a panel opened, a spectator): everything is let go at once, unread presses too', async () => {
    const { c, zone, jump } = await make();
    c.update({ visible: true, context: 'fight' });
    zone.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
    zone.fire('pointermove', { pointerId: 1, clientX: 60, clientY: 0 });
    jump.fire('pointerdown', { pointerId: 2 });
    c.update({ visible: false, context: 'fight' });
    expect(c.pad.fingers).toBe(0);
    expect(c.pad.take('jump')).toBe(false);
  });

  it('the buttons’ words and roles follow the moment: Throw while holding, Climb and Let go on a ledge, Break free when held, a peel count when out', async () => {
    const { c, punch, jump, grab } = await make();
    c.update({ visible: true, context: 'holding' });
    expect(grab.children[0].textContent).toBe('Throw');
    c.update({ visible: true, context: 'ledge' });
    expect(jump.children[0].textContent).toBe('Climb');
    expect(grab.children[0].textContent).toBe('Let go');
    c.update({ visible: true, context: 'held' });
    expect(punch.children[0].textContent).toBe('Break free');
    punch.fire('pointerdown', { pointerId: 3 });
    expect(Math.abs(c.pad.movement().x)).toBe(1);
    expect(c.pad.take('punch')).toBe(false);
    c.update({ visible: true, context: 'out', peel: { left: 2, cooldown: 0, allowed: true } });
    expect(punch.children[0].textContent).toBe('Throw');
    expect(punch.children[1].textContent).toContain('2');
    expect(jump.classList.contains('hide')).toBe(true);
    // A hidden button does not answer.
    jump.fire('pointerdown', { pointerId: 4 });
    expect(c.pad.take('jump')).toBe(false);
    c.update({ visible: true, context: 'out', peel: { left: 2, cooldown: 1.24, allowed: true } });
    expect(punch.children[1].textContent).toBe('1.2 s');
    expect(punch.classList.contains('dim')).toBe(true);
  });

  it('the long-press menu and text selection never start on the controls', async () => {
    const { root } = await make();
    let prevented = 0;
    for (const k of ['contextmenu', 'selectstart']) for (const f of root.listeners[k] ?? []) f({ preventDefault: () => prevented++ });
    expect(prevented).toBe(2);
  });
});
