/**
 * Interface keys stay the interface's (L4.2): a field being typed in, or a
 * control the keyboard reached (Space presses the button), never moves,
 * jumps or punches; a click never leaves a button focused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keyboard, NET_BINDINGS } from '../control/input';
import { button, isTyping, isUiKey } from './dom';
import { FakeEl, installFakeDom } from './testDom';

let uninstall: () => void;
beforeEach(() => {
  uninstall = installFakeDom();
});
afterEach(() => uninstall());

const target = (tagName: string, extra: object = {}) => ({ tagName, isContentEditable: false, getAttribute: () => null, ...extra });

function keyboard() {
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const win = { addEventListener: (k: string, f: (e: unknown) => void) => (handlers[k] ??= []).push(f) } as unknown as Window;
  const kb = new Keyboard([NET_BINDINGS], win);
  let prevented = 0;
  const down = (code: string, t: unknown) => handlers.keydown?.forEach((f) => f({ code, repeat: false, target: t, preventDefault: () => prevented++ }));
  return { kb, down, prevented: () => prevented };
}

describe('keys in the interface (L4.2)', () => {
  it('a field, a text area, a list, a button or a folding heading with the keyboard: the game takes no key, and Space keeps its own meaning', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY']) {
      const k = keyboard();
      k.down('Space', target(tag));
      k.down('KeyW', target(tag));
      expect(k.kb.take(['Space'])).toBe(false);
      expect(k.kb.held.size).toBe(0);
      expect(k.prevented()).toBe(0);
    }
    const editable = keyboard();
    editable.down('Space', target('DIV', { isContentEditable: true }));
    expect(editable.kb.take(['Space'])).toBe(false);
  });

  it('the arena (the page itself) still plays', () => {
    const k = keyboard();
    k.down('Space', target('BODY'));
    expect(k.kb.take(['Space'])).toBe(true);
    expect(k.prevented()).toBe(1);
  });

  it('which key events belong to the interface: typing, or a reached control', () => {
    const ev = (t: unknown) => ({ target: t }) as unknown as Event;
    expect(isTyping(ev(target('INPUT')))).toBe(true);
    expect(isTyping(ev(target('SELECT')))).toBe(true);
    expect(isTyping(ev(target('BUTTON')))).toBe(false);
    expect(isUiKey(ev(target('BUTTON')))).toBe(true);
    expect(isUiKey(ev(target('DIV', { getAttribute: (k: string) => (k === 'role' ? 'tab' : null) })))).toBe(true);
    expect(isUiKey(ev(target('CANVAS')))).toBe(false);
    expect(isUiKey(ev(null))).toBe(false);
  });

  it('a button: the keyboard can reach it (Tab), a pointer never focuses it, and its click goes no further', () => {
    let clicked = 0;
    const b = button('Ready', () => clicked++) as unknown as FakeEl;
    expect(b.tabIndex).toBe(0);
    expect(b.type).toBe('button');
    let prevented = false;
    b.fire('mousedown', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    let stopped = false;
    b.fire('click', { stopPropagation: () => (stopped = true) });
    expect(stopped).toBe(true);
    expect(clicked).toBe(1);
  });
});
