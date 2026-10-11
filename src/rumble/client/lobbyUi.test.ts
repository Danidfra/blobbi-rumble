/**
 * The lobby on screen (L3), with a stand-in DOM: the card's seats and
 * pills, the owner's controls (and a guest's, disabled), Ready and Start
 * reaching their actions, the countdown, the results card, the waiting
 * chip, folding the card away, stepping aside for other cards; and the
 * phone layout rules that can be checked without a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LobbyMessage, MatchResults, SlotIdentity } from '../net/protocol';
import { LOBBY_CSS, createLobbyUi, type LobbyUiActions } from './lobbyUi';
import { lobbyView } from './lobbyView';

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
  alt = '';
  src = '';
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
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
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
  click() {
    if (this.disabled) return;
    for (const f of this.listeners.click ?? []) f({ preventDefault() {}, stopPropagation() {} });
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  buttons() {
    return this.all().filter((e) => e.tagName === 'button');
  }
  button(text: string) {
    return this.buttons().find((b) => b.textContent === text);
  }
  byClass(cls: string) {
    return this.all().filter((e) => e.className.split(' ').includes(cls));
  }
}

const ADA = 'a'.repeat(64);
const LOBBY: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1', 'P2'], ready: [], watchers: [], forced: false, lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: true, need: 1, results: null };
const ROSTER: Record<string, SlotIdentity> = { P1: { who: 'nostr', pubkey: ADA }, P2: { who: 'guest' }, P3: { who: 'bot' }, P4: { who: 'bot' } };

let actions: LobbyUiActions & Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (t: string) => new FakeNode(t),
  };
  actions = { ready: vi.fn(), start: vi.fn(), settings: vi.fn(), openSession: vi.fn(), copyLink: vi.fn() } as never;
});
afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

const make = () => createLobbyUi(actions, { preview: () => Promise.resolve('data:image/svg+xml,x'), defaultLook: (seat) => ({ seed: seat.padEnd(64, '0'), algorithm: 1 }) });
const input = (lobby: Partial<LobbyMessage>, extra: { roster?: Record<string, SlotIdentity>; tick?: number; touch?: boolean } = {}) => ({
  view: lobbyView({ lobby: { ...LOBBY, ...lobby }, roster: extra.roster ?? ROSTER, tick: extra.tick ?? 0, tickHz: 60, personName: () => 'Ada', blobbiNameOf: () => null, keys: !extra.touch }),
  room: 'A7F2',
  share: true,
  verified: true,
  touch: !!extra.touch,
});
const parts = (ui: ReturnType<typeof make>) => {
  const [card, count, results, wait] = ui.nodes as unknown as FakeEl[];
  return { card, count, results, wait };
};

describe('the lobby card (L3)', () => {
  it('shows the room, every seat with its readiness (person, bot), the owner and you', () => {
    const ui = make();
    ui.show(input({ ready: ['P1'] }));
    const { card } = parts(ui);
    expect(card.style.display).toBe('block');
    expect(card.textContent).toContain('A7F2');
    const seats = card.byClass('rs-seat');
    expect(seats.map((s) => s.textContent)).toEqual(['★ Adayou · ownerReady', 'Guestguest' + 'Not ready', 'Botplays the empty seatBot', 'Botplays the empty seatBot']);
    expect(seats[0].className).toContain('you');
  });

  it('labels an open seat as open (bots off), never as a bot', () => {
    const ui = make();
    ui.show(input({ settings: { ...LOBBY.settings, bots: false }, lineup: ['P1', 'P2'] }, { roster: { ...ROSTER, P3: { who: 'empty' }, P4: { who: 'empty' } } }));
    const seats = parts(ui).card.byClass('rs-seat');
    expect(seats[2].textContent).toBe('Open seatbots are offOpen');
    expect(seats[2].className).toContain('empty');
    expect(seats.slice(2).some((x) => x.textContent.includes('Bot'))).toBe(false);
  });

  it('Ready reaches the server as a request; once ready, it offers Not ready', () => {
    const ui = make();
    ui.show(input({}));
    parts(ui).card.button('Ready (R)')!.click();
    expect(actions.ready).toHaveBeenCalledWith(true);
    ui.show(input({ ready: ['P1'] }));
    parts(ui).card.button('Not ready (R)')!.click();
    expect(actions.ready).toHaveBeenLastCalledWith(false);
  });

  it('the owner changes bots, rotation and the arena, and starts; Start is disabled with its reason below the minimum', () => {
    const ui = make();
    ui.show(input({}));
    const { card } = parts(ui);
    // The two switches: bots (On lit), rotate (Off lit); clicking the lit side does nothing.
    const offs = card.buttons().filter((b) => b.textContent === 'Off');
    offs[0].click();
    expect(actions.settings).toHaveBeenCalledWith({ bots: false });
    card.buttons().filter((b) => b.textContent === 'On')[0].click();
    expect(actions.settings).toHaveBeenCalledTimes(1);
    card.buttons().filter((b) => b.textContent === 'On')[1].click();
    expect(actions.settings).toHaveBeenLastCalledWith({ rotate: true });
    card.button('Frozen Lake')!.click();
    expect(actions.settings).toHaveBeenLastCalledWith({ arena: 'frozen-lake' });
    card.button('Start now')!.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
    ui.show(input({ canStart: false, seated: ['P1'], need: 2, settings: { ...LOBBY.settings, bots: false } }));
    const start = parts(ui).card.button('Start now')!;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe('2 players needed');
    start.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
  });

  it('another person sees the settings but cannot change them, and has no Start', () => {
    const ui = make();
    ui.show(input({ you: 'P2', owner: 'P1', youOwn: false, settings: { bots: false, arena: 'frozen-lake', rotate: true } }));
    const { card } = parts(ui);
    expect(card.button('Start now')).toBeUndefined();
    expect(card.button('Frozen Lake')).toBeUndefined();
    expect(card.textContent).toContain('Arena: Frozen Lake · rotating between matches');
    for (const b of card.buttons().filter((x) => x.textContent === 'On' || x.textContent === 'Off')) {
      expect(b.disabled).toBe(true);
      b.click();
    }
    expect(actions.settings).not.toHaveBeenCalled();
  });

  it('invitations and the Blobbi picker stay in the session panel: the card opens it; Copy link copies', () => {
    const ui = make();
    ui.show(input({}));
    const { card } = parts(ui);
    card.button('Invite…')!.click();
    card.button('Choose Blobbi…')!.click();
    expect(actions.openSession).toHaveBeenCalledTimes(2);
    card.button('Copy link')!.click();
    expect(actions.copyLink).toHaveBeenCalledTimes(1);
  });

  it('names the people waiting for the next match, and tells a watcher they wait', () => {
    const ui = make();
    ui.show(input({ you: null, youOwn: false, watchers: [{ who: 'guest' }, { who: 'nostr', pubkey: ADA }] }));
    const { card } = parts(ui);
    expect(card.textContent).toContain('Waiting for next match (2)');
    expect(card.textContent).toContain('Guest · Ada');
    expect(card.textContent).toContain('You are watching: you get a seat in the next lobby with one free.');
    expect(card.button('Ready (R)')).toBeUndefined();
  });

  it('folds to its header to uncover the arena, and opens again', () => {
    const ui = make();
    ui.show(input({}));
    expect(ui.cardOpen).toBe(true);
    parts(ui).card.button('▾')!.click();
    ui.show(input({}));
    expect(ui.cardOpen).toBe(false);
    expect(parts(ui).card.className).toContain('folded');
    parts(ui).card.button('▸')!.click();
    ui.show(input({}));
    expect(ui.cardOpen).toBe(true);
  });

  it('touch: no key hints in the labels; folded by default (L4), the header still offering Ready and Start and saying who is ready', () => {
    const ui = make();
    ui.show(input({ ready: ['P2'] }, { touch: true }));
    const { card } = parts(ui);
    expect(card.className).toContain('folded');
    expect(ui.cardOpen).toBe(false);
    const hd = card.byClass('hd')[0];
    expect(hd.textContent).toContain('1/2 ready');
    hd.button('Ready')!.click();
    expect(actions.ready).toHaveBeenCalledWith(true);
    hd.button('Start now')!.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
    // Unfolded on demand.
    hd.button('▸')!.click();
    ui.show(input({ ready: ['P2'] }, { touch: true }));
    expect(ui.cardOpen).toBe(true);
  });

  it('a desktop starts unfolded (L4)', () => {
    const ui = make();
    ui.show(input({}));
    expect(ui.cardOpen).toBe(true);
    expect(parts(ui).card.className).not.toContain('folded');
  });
});

describe('the countdown, the results, watching (L3)', () => {
  it('a big countdown; settings and Start gone; cancelled, the lobby card is back as it was', () => {
    const ui = make();
    ui.show(input({ phase: 'countdown', deadline: 300, ready: ['P1', 'P2'] }, { tick: 120 }));
    const { card, count } = parts(ui);
    expect(count.style.display).toBe('block');
    expect(count.textContent).toBe('3Match starts');
    expect(card.textContent).toContain('Starting');
    expect(card.button('Start now')).toBeUndefined();
    expect(card.button('Frozen Lake')).toBeUndefined();
    expect(card.button('Not ready (R)')).toBeDefined();
    ui.show(input({ phase: 'lobby', ready: ['P1'] }));
    expect(count.style.display).toBe('none');
    expect(parts(ui).card.button('Start now')).toBeDefined();
    expect(parts(ui).card.button('Frozen Lake')).toBeDefined();
  });

  it('the results card: the winner, every fighter (human, bot, left) and the scores; then it goes', () => {
    const results: MatchResults = { winner: 'P1', reason: 'won', arena: 'floating-islands-classic', fighters: [{ id: 'P1', who: { who: 'nostr', pubkey: ADA }, score: 3 }, { id: 'P2', who: { who: 'empty' }, score: 1 }, { id: 'P3', who: { who: 'bot' }, score: 2 }] };
    const ui = make();
    ui.show(input({ phase: 'results', deadline: 300, results }, { tick: 0 }));
    const { card, results: box } = parts(ui);
    expect(card.style.display).toBe('none');
    expect(box.style.display).toBe('block');
    expect(ui.resultsOpen).toBe(true);
    expect(box.textContent).toContain('Ada wins!');
    expect(box.byClass('row').map((r) => r.textContent)).toEqual(['🏆Ada (you)Human3', 'BotBot2', 'Left the matchLeft1']);
    expect(box.textContent).toContain('Back to the lobby in 5 s');
    ui.show(input({ phase: 'lobby', results }));
    expect(box.style.display).toBe('none');
    expect(parts(ui).card.textContent).toContain('Last match: Ada won');
  });

  it('watching a match: only the chip, "Waiting for next match"; playing: nothing', () => {
    const ui = make();
    ui.show(input({ phase: 'playing', you: null, youOwn: false }));
    const { card, wait } = parts(ui);
    expect(wait.style.display).toBe('block');
    expect(wait.textContent).toBe('Waiting for next match');
    expect(card.style.display).toBe('none');
    ui.show(input({ phase: 'playing' }));
    expect(wait.style.display).toBe('none');
  });

  it('steps aside entirely (another card is up, or not a lobby room)', () => {
    const ui = make();
    ui.show(input({}));
    ui.show(null);
    const { card, count, results, wait } = parts(ui);
    expect([card, count, results, wait].map((e) => e.style.display)).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('on a phone (L3)', () => {
  it('keeps clear of the notch and the home bar, fits a phone on its side, and gives fingers big targets', () => {
    expect(LOBBY_CSS).toMatch(/\.rs-lobby \{[^}]*env\(safe-area-inset-right/);
    expect(LOBBY_CSS).toMatch(/\.rs-lobby \{[^}]*max-height: calc\(100dvh - env\(safe-area-inset-top/);
    expect(LOBBY_CSS).toMatch(/@media \(max-height: 520px\) \{[^@]*\.rs-lobby \{[^}]*width: min\(300px, 44vw\)/);
    expect(LOBBY_CSS).toMatch(/@media \(pointer: coarse\) \{[^@]*min-height: 40px/);
    expect(LOBBY_CSS).toMatch(/\.rs-count \{[^}]*pointer-events: none/);
    expect(LOBBY_CSS).toMatch(/\.rs-wait \{[^}]*pointer-events: none/);
  });
});
