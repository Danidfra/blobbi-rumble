/**
 * Interface keys stay the interface's (L4.2): a field being typed in never
 * moves, jumps or punches, and a control the keyboard reached keeps the
 * keys it acts on (Space presses the button); a click never leaves a
 * button focused. L4.4A: only those keys: a focused button never silences
 * the rest of the game's keys, and a sheet closed with a pointer gives the
 * keyboard back to the game.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keyboard, NET_BINDINGS, interfaceKeeps } from '../control/input';
import { button, focusAfterClose, isTyping, isUiKey } from './dom';
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

describe('keys in the interface (L4.2, L4.4A)', () => {
  it('a field, a text area, a list or editable text: the game takes no key at all', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const k = keyboard();
      for (const code of ['Space', 'KeyW', 'KeyF', 'KeyG', 'Enter', 'ArrowUp']) k.down(code, target(tag));
      expect(k.kb.take(['Space', 'KeyF', 'KeyG', 'Enter'])).toBe(false);
      expect(k.kb.held.size).toBe(0);
      expect(k.prevented()).toBe(0);
    }
    const editable = keyboard();
    editable.down('Space', target('DIV', { isContentEditable: true }));
    editable.down('KeyW', target('DIV', { isContentEditable: true }));
    expect(editable.kb.take(['Space'])).toBe(false);
    expect(editable.kb.held.size).toBe(0);
  });

  it('a focused button or folding heading keeps Space and Enter (it is pressed, nobody jumps) and nothing else', () => {
    for (const tag of ['BUTTON', 'SUMMARY']) {
      const k = keyboard();
      k.down('Space', target(tag));
      k.down('Enter', target(tag));
      expect(k.kb.take(['Space', 'Enter'])).toBe(false);
      expect(k.prevented()).toBe(0);
      // The regression L4.4A fixes: with the sheet's button focused, the fighter still moves, punches and grabs.
      k.down('KeyW', target(tag));
      k.down('KeyD', target(tag));
      k.down('ShiftLeft', target(tag));
      k.down('KeyF', target(tag));
      k.down('KeyG', target(tag));
      expect([...k.kb.held].sort()).toEqual(['KeyD', 'KeyF', 'KeyG', 'KeyW', 'ShiftLeft']);
      expect(k.kb.take(['KeyF'])).toBe(true);
      expect(k.kb.take(['KeyG'])).toBe(true);
    }
  });

  it('a widget that moves with the arrows (a tab) keeps them; a plain button does not', () => {
    const tab = target('DIV', { getAttribute: (a: string) => (a === 'role' ? 'tab' : null) });
    expect(interfaceKeeps(tab as unknown as EventTarget, 'ArrowLeft')).toBe(true);
    expect(interfaceKeeps(tab as unknown as EventTarget, 'KeyW')).toBe(false);
    expect(interfaceKeeps(target('BUTTON') as unknown as EventTarget, 'ArrowLeft')).toBe(false);
    expect(interfaceKeeps(target('A') as unknown as EventTarget, 'Enter')).toBe(true);
    expect(interfaceKeeps(null, 'Space')).toBe(false);
  });

  it('the arena (the page itself) still plays', () => {
    const k = keyboard();
    k.down('Space', target('BODY'));
    expect(k.kb.take(['Space'])).toBe(true);
    expect(k.prevented()).toBe(1);
  });

  it('which key events belong to the interface: typing, or a key a reached control acts on', () => {
    const ev = (t: unknown, code = 'Space') => ({ target: t, code }) as unknown as KeyboardEvent;
    expect(isTyping(ev(target('INPUT')))).toBe(true);
    expect(isTyping(ev(target('SELECT')))).toBe(true);
    expect(isTyping(ev(target('BUTTON')))).toBe(false);
    expect(isUiKey(ev(target('BUTTON')))).toBe(true);
    expect(isUiKey(ev(target('BUTTON'), 'KeyR'))).toBe(false);
    expect(isUiKey(ev(target('INPUT'), 'KeyR'))).toBe(true);
    expect(isUiKey(ev(target('DIV', { getAttribute: (k: string) => (k === 'role' ? 'tab' : null) })))).toBe(true);
    expect(isUiKey(ev(target('CANVAS')))).toBe(false);
    expect(isUiKey(ev(null))).toBe(false);
  });

  it('closing a sheet: a pointer gives the keyboard back to the game, a keyboard user goes back to the opening button', () => {
    const base = { keyboardLast: false, openedByKeyboard: false, focusInside: false, insideByKeyboard: false, onTrigger: false };
    // Opened and closed with the pointer, a field or a heading clicked inside: the focus is let go (the game plays).
    expect(focusAfterClose({ ...base, focusInside: true })).toBe('release');
    // The ✕ or a press outside with the opening button somehow focused: let go too.
    expect(focusAfterClose({ ...base, onTrigger: true })).toBe('release');
    // Nothing of the interface focused: nothing to do.
    expect(focusAfterClose(base)).toBe('keep');
    // Opened from the keyboard and closed with Escape: back to the button that opened it.
    expect(focusAfterClose({ ...base, keyboardLast: true, openedByKeyboard: true })).toBe('trigger');
    // Opened with the mouse, Tabbed into, closed with Escape: back to the button.
    expect(focusAfterClose({ ...base, keyboardLast: true, focusInside: true, insideByKeyboard: true })).toBe('trigger');
    // Opened with the mouse, a field clicked, then Escape: the keyboard goes to the game, not the button (Space must jump).
    expect(focusAfterClose({ ...base, keyboardLast: true, focusInside: true })).toBe('release');
    // Opened from the keyboard but closed with a pointer: the game.
    expect(focusAfterClose({ ...base, openedByKeyboard: true, focusInside: true, insideByKeyboard: true })).toBe('release');
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
