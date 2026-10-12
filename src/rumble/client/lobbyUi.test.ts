/**
 * The lobby on screen (L3, reorganised in L4.2), with a stand-in DOM: the
 * room bar (Ready / Not ready, the owner's Start, Invite), the roster (each
 * seat's readiness, owner, you, bots and open seats, who waits), the
 * settings (the owner's to change, everyone's to see), the countdown, the
 * results card, the waiting chip, stepping aside; and the phone rules that
 * can be checked without a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LobbyMessage, MatchResults, SlotIdentity } from '../net/protocol';
import { LOBBY_CSS, createLobbyUi, seatLine, type LobbyUiActions } from './lobbyUi';
import { lobbyView, rosterSeats } from './lobbyView';
import { FakeEl, installFakeDom } from './testDom';

const ADA = 'a'.repeat(64);
const LOBBY: LobbyMessage = { t: 'lobby', phase: 'lobby', since: 0, deadline: null, transition: null, you: 'P1', owner: 'P1', youOwn: true, seated: ['P1', 'P2'], ready: [], watchers: [], forced: false, lineup: ['P1', 'P2', 'P3', 'P4'], settings: { bots: true, arena: 'floating-islands-classic', rotate: false }, canStart: true, need: 1, results: null };
const ROSTER: Record<string, SlotIdentity> = { P1: { who: 'nostr', pubkey: ADA }, P2: { who: 'guest' }, P3: { who: 'bot' }, P4: { who: 'bot' } };

let actions: LobbyUiActions & Record<string, ReturnType<typeof vi.fn>>;
let uninstall: () => void;
beforeEach(() => {
  uninstall = installFakeDom();
  actions = { ready: vi.fn(), start: vi.fn(), settings: vi.fn(), openRoom: vi.fn() } as never;
});
afterEach(() => uninstall());

const make = () => createLobbyUi(actions, { preview: () => Promise.resolve('data:image/svg+xml,x'), defaultLook: (seat) => ({ seed: seat.padEnd(64, '0'), algorithm: 1 }) });
const view = (lobby: Partial<LobbyMessage>, extra: { roster?: Record<string, SlotIdentity>; tick?: number; touch?: boolean } = {}) =>
  lobbyView({ lobby: { ...LOBBY, ...lobby }, roster: extra.roster ?? ROSTER, tick: extra.tick ?? 0, tickHz: 60, personName: () => 'Ada', blobbiNameOf: () => null, keys: !extra.touch });
const input = (lobby: Partial<LobbyMessage>, extra: { roster?: Record<string, SlotIdentity>; tick?: number; touch?: boolean } = {}) => ({ view: view(lobby, extra), touch: !!extra.touch });
const parts = (ui: ReturnType<typeof make>) => {
  const [count, results, wait] = ui.nodes as unknown as FakeEl[];
  return { bar: ui.bar as unknown as FakeEl, count, results, wait };
};
/** Nodes as the room sheet would hold them, in a box to read and click. */
const box = (nodes: Node[]) => {
  const b = new FakeEl('div');
  b.append(...(nodes as unknown as FakeEl[]));
  return b;
};

describe('the room bar (L4.2)', () => {
  it('Ready is the main action, reaching the server as a request; once ready it offers Not ready', () => {
    const ui = make();
    ui.show(input({}));
    const { bar } = parts(ui);
    expect(bar.style.display).toBe('flex');
    const ready = bar.button('Ready')!;
    expect(ready.className).toContain('go');
    expect(ready.attrs['aria-pressed']).toBe('false');
    ready.click();
    expect(actions.ready).toHaveBeenCalledWith(true);
    ui.show(input({ ready: ['P1'] }));
    const not = parts(ui).bar.button('Not ready')!;
    expect(not.attrs['aria-pressed']).toBe('true');
    not.click();
    expect(actions.ready).toHaveBeenLastCalledWith(false);
  });

  it('a keyboard page shows R beside Ready; a touch page does not', () => {
    const ui = make();
    ui.show(input({}));
    expect(parts(ui).bar.button('Ready')!.textContent).toBe('ReadyR');
    expect(parts(ui).bar.button('Ready')!.attrs['aria-keyshortcuts']).toBe('R');
    ui.show(input({}, { touch: true }));
    expect(parts(ui).bar.button('Ready')!.textContent).toBe('Ready');
  });

  it('the owner has Start (disabled with its reason below the minimum); another person has none; Invite opens the invitations', () => {
    const ui = make();
    ui.show(input({}));
    parts(ui).bar.button('Start now')!.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
    ui.show(input({ canStart: false, seated: ['P1'], need: 2, settings: { ...LOBBY.settings, bots: false } }));
    const start = parts(ui).bar.button('Start now')!;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe('2 players needed');
    start.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
    ui.show(input({ you: 'P2', youOwn: false }));
    expect(parts(ui).bar.button('Start')).toBeUndefined();
    const inv = parts(ui).bar.buttons().find((b) => b.attrs['aria-label'] === 'Invite friends')!;
    inv.click();
    expect(actions.openRoom).toHaveBeenCalledWith('invite');
  });

  it('a watcher has no Ready; in a match and in the results the bar is gone', () => {
    const ui = make();
    ui.show(input({ you: null, youOwn: false }));
    expect(parts(ui).bar.button('Ready')).toBeUndefined();
    ui.show(input({ phase: 'playing' }));
    expect(parts(ui).bar.style.display).toBe('none');
  });
});

describe('the roster (L3, L4.2)', () => {
  it('every seat: its Blobbi, name, what it is, you, the owner, readiness; never an empty seat as a bot', () => {
    const ui = make();
    const seats = box(ui.players(view({ ready: ['P1'] }))).byClass('rs-seat');
    expect(seats.map((s) => s.textContent)).toEqual(['AdaNostrYou★ Owner✓ Ready', 'GuestGuestNot ready', 'BotPlays an empty seatBot', 'BotPlays an empty seatBot']);
    expect(seats[0].className).toContain('you');
    const off = box(ui.players(view({ settings: { ...LOBBY.settings, bots: false }, lineup: ['P1', 'P2'] }, { roster: { ...ROSTER, P3: { who: 'empty' }, P4: { who: 'empty' } } }))).byClass('rs-seat');
    expect(off[2].textContent).toBe('Open seatBots are offOpen');
    expect(off[2].className).toContain('empty');
    expect(off.slice(2).some((x) => x.textContent.includes('Bot '))).toBe(false);
  });

  it('names the people waiting for the next match, and tells a watcher they wait; the last match in a line', () => {
    const ui = make();
    const b = box(ui.players(view({ you: null, youOwn: false, watchers: [{ who: 'guest' }, { who: 'nostr', pubkey: ADA }] })));
    expect(b.textContent).toContain('Waiting for next match (2)');
    expect(b.textContent).toContain('Guest · Ada');
    expect(b.textContent).toContain('You are watching: you get a seat in the next lobby with one free.');
  });

  it('Quick Match’s seats: people and bots, no readiness', () => {
    const rows = rosterSeats(ROSTER, 'P2', () => 'Ada', () => 'Pip');
    expect(rows.map((r) => [r.kind, r.ready, r.you])).toEqual([
      ['person', 'none', false],
      ['person', 'none', true],
      ['bot', 'bot', false],
      ['bot', 'bot', false],
    ]);
    expect(seatLine(rows[0])).toBe('Pip');
    const seats = box(make().seats(rows)).byClass('rs-seat');
    expect(seats[1].textContent).toBe('GuestPipYou');
  });
});

describe('the room’s settings (L3, L4.2)', () => {
  it('the owner changes the arena, rotation and bots, and starts', () => {
    const ui = make();
    const b = box(ui.settings(view({})));
    // The two switches: rotate (Off lit), bots (On lit); clicking the lit side does nothing.
    const ons = b.buttons().filter((x) => x.textContent === 'On');
    const offs = b.buttons().filter((x) => x.textContent === 'Off');
    offs[1].click();
    expect(actions.settings).toHaveBeenCalledWith({ bots: false });
    ons[1].click();
    expect(actions.settings).toHaveBeenCalledTimes(1);
    ons[0].click();
    expect(actions.settings).toHaveBeenLastCalledWith({ rotate: true });
    b.button('Frozen Lake')!.click();
    expect(actions.settings).toHaveBeenLastCalledWith({ arena: 'frozen-lake' });
    expect(b.button('Floating Islands: Classic')!.attrs['aria-pressed']).toBe('true');
    b.button('Start now')!.click();
    expect(actions.start).toHaveBeenCalledTimes(1);
  });

  it('another person sees them but cannot change them, and is told who can', () => {
    const ui = make();
    const b = box(ui.settings(view({ you: 'P2', owner: 'P1', youOwn: false, settings: { bots: false, arena: 'frozen-lake', rotate: true } })));
    expect(b.button('Start')).toBeUndefined();
    expect(b.button('Frozen Lake')).toBeUndefined();
    expect(b.textContent).toContain('Frozen Lake');
    expect(b.textContent).toContain('Only the owner (★ Ada) can change these.');
    for (const x of b.buttons().filter((y) => y.textContent === 'On' || y.textContent === 'Off')) {
      expect(x.disabled).toBe(true);
      x.click();
    }
    expect(actions.settings).not.toHaveBeenCalled();
  });
});

describe('the countdown, the results, watching (L3, L4.2)', () => {
  it('a big countdown; Not ready stays in the bar (it cancels); cancelled, Start is back', () => {
    const ui = make();
    ui.show(input({ phase: 'countdown', deadline: 300, ready: ['P1', 'P2'] }, { tick: 120 }));
    const { bar, count } = parts(ui);
    expect(count.style.display).toBe('block');
    expect(count.textContent).toBe('3Match starts');
    expect(bar.button('Start')).toBeUndefined();
    expect(bar.button('Not ready')).toBeDefined();
    ui.show(input({ phase: 'lobby', ready: ['P1'] }));
    expect(count.style.display).toBe('none');
    expect(parts(ui).bar.button('Start now')).toBeDefined();
  });

  it('the results card: the winner and their Blobbi, every fighter (human, bot, left) with the score, the way back to the plaza; then it goes', () => {
    const results: MatchResults = { winner: 'P1', reason: 'won', arena: 'floating-islands-classic', fighters: [{ id: 'P1', who: { who: 'nostr', pubkey: ADA }, score: 3 }, { id: 'P2', who: { who: 'empty' }, score: 1 }, { id: 'P3', who: { who: 'bot' }, score: 2 }] };
    const ui = make();
    ui.show(input({ phase: 'results', deadline: 300, results }, { tick: 0 }));
    const { bar, results: card } = parts(ui);
    expect(bar.style.display).toBe('none');
    expect(card.style.display).toBe('block');
    expect(ui.resultsOpen).toBe(true);
    expect(card.attrs.role).toBe('dialog');
    expect(card.textContent).toContain('Ada wins!');
    expect(card.byClass('champ')).toHaveLength(1);
    expect(card.byClass('row').map((r) => r.textContent)).toEqual(['🏆Ada (you)Human●●●', '2BotBot●●○', '3Left the matchLeft●○○']);
    expect(card.byClass('row')[0].attrs['aria-label']).toBe('Ada (you), Human, 3 points, winner');
    expect(card.textContent).toContain('Back to the plaza in 5 s');
    ui.show(input({ phase: 'lobby', results }));
    expect(card.style.display).toBe('none');
    expect(box(ui.players(view({ phase: 'lobby', results }))).textContent).toContain('Last match: Ada won');
  });

  it('watching a match: only the chip, "Waiting for next match"; playing: nothing', () => {
    const ui = make();
    ui.show(input({ phase: 'playing', you: null, youOwn: false }));
    const { bar, wait } = parts(ui);
    expect(wait.style.display).toBe('block');
    expect(wait.textContent).toBe('Waiting for next match');
    expect(bar.style.display).toBe('none');
    ui.show(input({ phase: 'playing' }));
    expect(wait.style.display).toBe('none');
  });

  it('steps aside entirely (another card is up, or not a lobby room)', () => {
    const ui = make();
    ui.show(input({}));
    ui.show(null);
    const { bar, count, results, wait } = parts(ui);
    expect([bar, count, results, wait].map((e) => e.style.display)).toEqual(['none', 'none', 'none', 'none']);
  });
});

describe('on a phone (L3, L4.2)', () => {
  it('fits a phone on its side, gives fingers big targets, and never catches a touch with the countdown or the chip', () => {
    expect(LOBBY_CSS).toMatch(/@media \(pointer: coarse\) \{[^@]*\.rs-roombar \.rs-btn \{ min-height: 40px/);
    expect(LOBBY_CSS).toMatch(/@media \(max-height: 520px\) \{[^@]*\.rs-results \{[^}]*padding/);
    expect(LOBBY_CSS).toMatch(/\.rs-results \{[^}]*max-height: calc\(100dvh - var\(--rs-safe-t\)/);
    expect(LOBBY_CSS).toMatch(/\.rs-count \{[^}]*pointer-events: none/);
    expect(LOBBY_CSS).toMatch(/\.rs-wait \{[^}]*pointer-events: none/);
  });
});
