/**
 * The menu and the plaza card (L4.1), with a stand-in DOM: the menu's ways
 * in (Enter Plaza first, Quick Match, Create room, Join room by a checked
 * code) and who you play as; the plaza card's lines (a name, never a key;
 * the Blobbi worn), its ways on, no private-room controls, folded on a
 * touch screen with Quick Match kept; and the phone layout rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAZA_CSS, createPlazaUi, plazaLines, type PlazaUiActions, type PlazaView } from './plazaUi';

class FakeNode {
  textContent: string;
  constructor(text = '') {
    this.textContent = text;
  }
}
class FakeEl {
  children: (FakeEl | FakeNode)[] = [];
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = '';
  disabled = false;
  title = '';
  type = '';
  tabIndex = 0;
  value = '';
  maxLength = 0;
  placeholder = '';
  autocomplete = '';
  spellcheck = true;
  autocapitalize = '';
  enterKeyHint = '';
  constructor(readonly tagName: string) {}
  set textContent(t: string) {
    this.children = t ? [new FakeNode(t)] : [];
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  append(...c: (FakeEl | FakeNode)[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | FakeNode)[]) {
    this.children = [...c];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: (e: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  fire(k: string, e: object = {}) {
    for (const f of this.listeners[k] ?? []) f({ preventDefault() {}, stopPropagation() {}, ...e });
  }
  click() {
    if (!this.disabled) this.fire('click');
  }
  contains(x: unknown): boolean {
    return x === this || this.all().includes(x as FakeEl);
  }
  blur() {}
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  buttons() {
    return this.all().filter((e) => e.tagName === 'button');
  }
  button(text: string) {
    return this.buttons().find((b) => b.textContent.startsWith(text));
  }
  input() {
    return this.all().find((e) => e.tagName === 'input');
  }
}

let actions: PlazaUiActions & Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeEl(tag), createTextNode: (t: string) => new FakeNode(t), activeElement: null };
  actions = { enterPlaza: vi.fn(), quickMatch: vi.fn(), createRoom: vi.fn(), joinRoom: vi.fn(), toMenu: vi.fn(), openSession: vi.fn(), connectNostr: vi.fn(), releaseKeys: vi.fn() } as never;
});
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});
const make = () => {
  const ui = createPlazaUi(actions);
  const [menu, card] = ui.nodes as unknown as FakeEl[];
  return { ui, menu, card };
};
const plaza = (over: Partial<PlazaView> = {}): PlazaView => ({ who: { name: null, busy: false }, here: 3, capacity: 8, blobbi: null, touch: false, ...over });

describe('the menu (L4.1)', () => {
  it('Enter Plaza first and foremost, then Quick Match; Create room; who you play as', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    expect(menu.style.display).toBe('block');
    expect(ui.menuOpen).toBe(true);
    const buttons = menu.buttons().map((b) => b.textContent);
    expect(buttons[0]).toMatch(/^Enter Plaza/);
    expect(buttons[1]).toMatch(/^Quick Match/);
    expect(menu.buttons()[0].className).toContain('go');
    menu.button('Enter Plaza')!.click();
    menu.button('Quick Match')!.click();
    menu.button('Create room')!.click();
    expect(actions.enterPlaza).toHaveBeenCalledTimes(1);
    expect(actions.quickMatch).toHaveBeenCalledTimes(1);
    expect(actions.createRoom).toHaveBeenCalledTimes(1);
    expect(menu.textContent).toContain('Playing as a guest');
    menu.button('Connect Nostr')!.click();
    expect(actions.connectNostr).toHaveBeenCalledTimes(1);
    ui.showMenu({ who: { name: 'Ada', busy: false } });
    expect(menu.textContent).toContain('Playing as Ada');
    ui.showMenu(null);
    expect(menu.style.display).toBe('none');
  });

  it('Join room opens a code field: a good code joins (as typed: lower case, dashes), a bad one says why; typing takes the keys from the game', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    menu.button('Join room')!.click();
    ui.showMenu({ who: { name: null, busy: false } });
    const input = menu.input()!;
    input.fire('focus');
    expect(actions.releaseKeys).toHaveBeenCalled();
    input.value = 'nope';
    menu.button('Join')!.click();
    expect(actions.joinRoom).not.toHaveBeenCalled();
    expect(menu.textContent).toContain('Room codes look like A7F2');
    input.value = 'a7-f2';
    input.fire('keydown', { key: 'Enter' });
    expect(actions.joinRoom).toHaveBeenCalledWith('A7F2');
  });
});

describe('the plaza card (L4.1)', () => {
  it('says who you are by name (never a key) and the Blobbi you wear, and how many are here', () => {
    expect(plazaLines(plaza({ who: { name: 'Ada', busy: false }, blobbi: 'Pip', here: 5 }))).toEqual({ who: 'You: Ada', blobbi: 'Blobbi: Pip', here: '5 of 8 here' });
    expect(plazaLines(plaza())).toEqual({ who: 'You: Guest', blobbi: 'Blobbi: the default one', here: '3 of 8 here' });
    expect(plazaLines(plaza({ who: { name: null, busy: true } })).who).toBe('You: connecting Nostr…');
    const { ui, card } = make();
    ui.showPlaza(plaza({ who: { name: 'Ada', busy: false }, blobbi: 'Pip' }));
    expect(card.textContent).toContain('You: Ada');
    expect(card.textContent).not.toMatch(/npub|[0-9a-f]{16}/);
    expect(card.textContent).toContain('Everyone here sees your name and your Blobbi.');
  });

  it('its ways on: Create room, Join room, Quick Match, Menu; Choose… opens the session panel (the Blobbi picker); nothing of a private room', () => {
    const { ui, card } = make();
    ui.showPlaza(plaza());
    card.button('Create room')!.click();
    card.button('Quick Match')!.click();
    card.button('Menu')!.click();
    card.button('Choose…')!.click();
    expect(actions.createRoom).toHaveBeenCalledTimes(1);
    expect(actions.quickMatch).toHaveBeenCalledTimes(1);
    expect(actions.toMenu).toHaveBeenCalledTimes(1);
    expect(actions.openSession).toHaveBeenCalledTimes(1);
    card.button('Join room')!.click();
    ui.showPlaza(plaza());
    card.input()!.value = 'B4CD';
    card.button('Join')!.click();
    expect(actions.joinRoom).toHaveBeenCalledWith('B4CD');
    for (const forbidden of ['Ready', 'Start', 'Bots', 'Rotate', 'owner']) expect(card.textContent).not.toContain(forbidden);
  });

  it('on a touch screen it starts folded, its header keeping Quick Match; unfolded on demand; a desktop starts open', () => {
    const touch = make();
    touch.ui.showPlaza(plaza({ touch: true }));
    expect(touch.card.className).toContain('folded');
    expect(touch.ui.cardOpen).toBe(false);
    touch.card.button('Quick Match')!.click();
    expect(actions.quickMatch).toHaveBeenCalledTimes(1);
    touch.card.button('▸')!.click();
    touch.ui.showPlaza(plaza({ touch: true }));
    expect(touch.ui.cardOpen).toBe(true);
    const desk = make();
    desk.ui.showPlaza(plaza());
    expect(desk.ui.cardOpen).toBe(true);
    desk.ui.showPlaza(null);
    expect(desk.card.style.display).toBe('none');
  });

  it('on a phone: clear of the notch and home bar, a narrow card on its side, big targets', () => {
    expect(PLAZA_CSS).toMatch(/\.rs-plaza \{[^}]*env\(safe-area-inset-right/);
    expect(PLAZA_CSS).toMatch(/\.rs-menu \{[^}]*max-height: calc\(100dvh - env\(safe-area-inset-top/);
    expect(PLAZA_CSS).toMatch(/@media \(max-height: 520px\) \{[^@]*\.rs-plaza \{[^}]*width: min\(270px, 42vw\)/);
    expect(PLAZA_CSS).toMatch(/@media \(pointer: coarse\) \{[^@]*min-height: 40px/);
  });
});
