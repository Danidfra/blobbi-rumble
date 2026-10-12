/**
 * The menu and the ways on (L4.1, redrawn in L4.2), with a stand-in DOM:
 * the menu's ways in (Enter Plaza first, Quick Match, Create room, Join room
 * by a checked code), who you play as (a name, never a key), the Blobbis on
 * it; the ways a sheet reuses (from the plaza, from elsewhere), with nothing
 * of a private room's; and the phone layout rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAZA_CSS, createPlazaUi, plazaLines, type PlazaUiActions, type PlazaView } from './plazaUi';
import { FakeEl, installFakeDom } from './testDom';

let actions: PlazaUiActions & Record<string, ReturnType<typeof vi.fn>>;
let uninstall: () => void;
beforeEach(() => {
  uninstall = installFakeDom();
  actions = { enterPlaza: vi.fn(), quickMatch: vi.fn(), createRoom: vi.fn(), joinRoom: vi.fn(), toMenu: vi.fn(), connectNostr: vi.fn(), releaseKeys: vi.fn() } as never;
});
afterEach(() => uninstall());
const preview = vi.fn(() => Promise.resolve('data:image/svg+xml,x'));
const make = () => {
  const ui = createPlazaUi(actions, { preview, mascots: [{ seed: 'a'.repeat(64), algorithm: 1 }, { seed: 'b'.repeat(64), algorithm: 1 }, { seed: 'c'.repeat(64), algorithm: 1 }] });
  const [menu] = ui.nodes as unknown as FakeEl[];
  return { ui, menu };
};
const plaza = (over: Partial<PlazaView> = {}): PlazaView => ({ who: { name: null, busy: false }, here: 3, capacity: 8, blobbi: null, touch: false, ...over });

describe('the menu (L4.1, L4.2)', () => {
  it('Enter Plaza first and foremost, then Quick Match; Create room; who you play as', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    expect(menu.style.display).toBe('flex');
    expect(ui.menuOpen).toBe(true);
    expect(menu.attrs.role).toBe('dialog');
    const buttons = menu.buttons();
    expect(buttons[0].textContent).toContain('Enter Plaza');
    expect(buttons[0].className).toContain('go');
    expect(buttons[1].textContent).toContain('Quick Match');
    expect(buttons[0].attrs['aria-label']).toBe('Enter Plaza: Walk around and meet other Blobbis');
    menu.button('Enter Plaza')!.click();
    menu.button('Quick Match')!.click();
    menu.button('Create room')!.click();
    expect(actions.enterPlaza).toHaveBeenCalledTimes(1);
    expect(actions.quickMatch).toHaveBeenCalledTimes(1);
    expect(actions.createRoom).toHaveBeenCalledTimes(1);
    expect(menu.textContent).toContain('Playing as a guest');
    menu.button('Connect Nostr')!.click();
    expect(actions.connectNostr).toHaveBeenCalledTimes(1);
    ui.showMenu({ who: { name: 'Ada', busy: false, pubkey: 'a'.repeat(64) } });
    expect(menu.textContent).toContain('Playing as Ada');
    expect(menu.textContent).not.toMatch(/npub|[0-9a-f]{16}/);
    ui.showMenu(null);
    expect(menu.style.display).toBe('none');
  });

  it('shows three Blobbis (drawn once, kept across redraws) and the game’s name', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    expect(menu.byClass('mascots')[0].children).toHaveLength(3);
    expect(menu.textContent).toContain('Blobbi Rumble');
    expect(preview).toHaveBeenCalledTimes(3);
  });

  it('Join room opens a code field in place: a good code joins (as typed: lower case, dashes), a bad one says why; typing takes the keys from the game', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    const join = menu.button('Join room')!;
    const row = menu.byClass('rs-join')[0];
    expect(row.className).not.toContain('on');
    join.click();
    expect(row.className).toContain('on');
    expect(join.attrs['aria-expanded']).toBe('true');
    // The field got the keyboard: the game let go of its keys.
    expect(actions.releaseKeys).toHaveBeenCalled();
    const input = menu.input()!;
    expect(input.attrs['aria-label']).toBe('Room code');
    input.value = 'nope';
    row.button('Join')!.click();
    expect(actions.joinRoom).not.toHaveBeenCalled();
    expect(menu.textContent).toContain('Room codes look like A7F2');
    input.value = 'a7-f2';
    input.fire('keydown', { key: 'Enter' });
    expect(actions.joinRoom).toHaveBeenCalledWith('A7F2');
  });

  it('is never rebuilt under someone typing a code', () => {
    const { ui, menu } = make();
    ui.showMenu({ who: { name: null, busy: false } });
    menu.button('Join room')!.click();
    const input = menu.input()!;
    input.focus();
    ui.showMenu({ who: { name: 'Ada', busy: false } });
    expect(menu.input()).toBe(input);
    input.blur();
    ui.showMenu({ who: { name: 'Ada', busy: false } });
    expect(menu.textContent).toContain('Playing as Ada');
  });
});

describe('the ways on, for the sheets (L4.2)', () => {
  it('from the plaza: Quick Match first, Create room, Join room; nothing of a private room', () => {
    const { ui } = make();
    const box = ui.ways('plaza') as unknown as FakeEl;
    expect(box.buttons()[0].textContent).toContain('Quick Match');
    expect(box.buttons()[0].className).toContain('go');
    box.button('Quick Match')!.click();
    box.button('Create room')!.click();
    box.button('Join room')!.click();
    box.input()!.value = 'B4CD';
    box.byClass('rs-join')[0].button('Join')!.click();
    expect(actions.quickMatch).toHaveBeenCalledTimes(1);
    expect(actions.createRoom).toHaveBeenCalledTimes(1);
    expect(actions.joinRoom).toHaveBeenCalledWith('B4CD');
    for (const forbidden of ['Ready', 'Start', 'Bots', 'Rotate', 'owner']) expect(box.textContent).not.toContain(forbidden);
  });

  it('from a room or a match: the plaza first, then Quick Match, Create, Join', () => {
    const { ui } = make();
    const box = ui.ways('elsewhere') as unknown as FakeEl;
    expect(box.buttons().map((b) => b.textContent)).toEqual(['🌸 Plaza', '⚡ Quick Match', '＋ Create room', '# Join room', 'Join']);
    box.button('Plaza')!.click();
    expect(actions.enterPlaza).toHaveBeenCalledTimes(1);
  });

  it('what the plaza says about you: a name (never a key), the Blobbi you wear, how many are here', () => {
    expect(plazaLines(plaza({ who: { name: 'Ada', busy: false }, blobbi: 'Pip', here: 5 }))).toEqual({ who: 'You: Ada', blobbi: 'Blobbi: Pip', here: '5 of 8 here' });
    expect(plazaLines(plaza())).toEqual({ who: 'You: Guest', blobbi: 'Blobbi: the default one', here: '3 of 8 here' });
    expect(plazaLines(plaza({ who: { name: null, busy: true } })).who).toBe('You: connecting Nostr…');
  });
});

describe('on a phone (L4.1, L4.2)', () => {
  it('the menu: clear of the notch and the home bar, side by side on a phone on its side, scrolling rather than overflowing', () => {
    expect(PLAZA_CSS).toMatch(/\.rs-menu \{[^}]*padding: calc\(var\(--rs-safe-t\)[^}]*var\(--rs-safe-r\)[^}]*var\(--rs-safe-b\)[^}]*var\(--rs-safe-l\)/);
    expect(PLAZA_CSS).toMatch(/\.rs-menu \{[^}]*overflow: auto/);
    expect(PLAZA_CSS).toMatch(/\.rs-menu \.box \{[^}]*grid-template-columns: 1fr 1fr/);
    expect(PLAZA_CSS).toMatch(/@media \(max-height: 520px\) \{[^@]*\.rs-menu \.big \{[^}]*min-height: 46px/);
    expect(PLAZA_CSS).toMatch(/@media \(max-width: 640px\) and \(min-height: 521px\) \{[^@]*grid-template-columns: 1fr;/);
  });
});
