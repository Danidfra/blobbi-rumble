/**
 * THE MENU AND THE PLAZA CARD (L4.1). Part of the game's shell, drawn from
 * small pure models (tested on their own) with the shell's own DOM rules:
 * text only, buttons that never take focus (Space and Enter stay jump), a
 * code field that owns the keyboard only while it is focused.
 *
 *   the menu         a plain visit's first screen, before anything
 *                    connects: Enter Plaza (the primary way in), Quick Match
 *                    (straight into the open combat room), Create room, Join
 *                    room by its code; and who you play as
 *   the plaza card   in the public plaza: who you are (a display name, never
 *                    a key), the Blobbi you wear, Create room, Join room,
 *                    Quick Match, back to the menu. No ready, start, owner,
 *                    bots or rotation: those are a private room's. Folded on
 *                    a touch screen to its header (Quick Match kept in it)
 *
 * Invitations, the Blobbi picker and identity stay in the session panel;
 * "Choose…" opens it.
 */
import { normalizeRoomId } from '../net/roomId';
import { button, el } from './dom';

export interface PlazaUiActions {
  enterPlaza(): void;
  quickMatch(): void;
  createRoom(): void;
  joinRoom(code: string): void;
  toMenu(): void;
  /** Open the session panel (the Blobbi picker, identity, invitations). */
  openSession(): void;
  connectNostr(): void;
  /** A field took the keyboard: let go of every game key. */
  releaseKeys(): void;
}

/** Who the player is, as the menu and the card say it: a display name (never a key), or a guest. */
export interface Who {
  name: string | null;
  /** Connecting or proving now. */
  busy: boolean;
}

export interface MenuView {
  who: Who;
}

export interface PlazaView {
  who: Who;
  /** People on the plaza now (this player included), and how many it holds. */
  here: number;
  capacity: number;
  /** The Blobbi this player's fighter wears (its name), or null: the default Blobbi. */
  blobbi: string | null;
  touch: boolean;
}

/** L4.1: what the plaza card says about who you are and what you wear. Pure. */
export function plazaLines(v: PlazaView): { who: string; blobbi: string; here: string } {
  return {
    who: v.who.name ? `You: ${v.who.name}` : v.who.busy ? 'You: connecting Nostr…' : 'You: Guest',
    blobbi: v.blobbi ? `Blobbi: ${v.blobbi}` : 'Blobbi: the default one',
    here: `${v.here} of ${v.capacity} here`,
  };
}

export const PLAZA_CSS = `
  .rs-menu { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(380px, calc(100vw - 24px)); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px); overflow: auto; overscroll-behavior: contain; padding: 18px 20px; text-align: center; display: none; }
  .rs-menu h2 { margin: 0 0 2px; font-size: 22px; letter-spacing: 0.06em; }
  .rs-menu .tag { margin: 0 0 14px; color: #6b7082; font-size: 13px; }
  .rs-menu .big { display: block; width: 100%; margin: 6px 0; padding: 12px 14px; font-size: 16px; border-radius: 12px; text-align: left; }
  .rs-menu .big small { display: block; font-weight: 500; font-size: 12px; opacity: 0.8; }
  .rs-menu .more { display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
  .rs-menu .who { margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef1f6; font-size: 12px; color: #555a6e; }
  .rs-plaza { right: calc(env(safe-area-inset-right, 0px) + 10px); top: calc(env(safe-area-inset-top, 0px) + 50px); width: min(290px, calc(100vw - 20px)); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 64px); overflow: auto; overscroll-behavior: contain; padding: 10px 12px; display: none; }
  .rs-plaza .hd { display: flex; align-items: center; gap: 6px; }
  .rs-plaza .hd .ttl { font: 700 14px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; }
  .rs-plaza .hd .fold { margin-left: auto; }
  .rs-plaza.folded .body { display: none; }
  .rs-plaza.folded { width: auto; }
  .rs-plaza .line { margin: 4px 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-plaza .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .rs-plaza .acts .rs-btn { padding: 8px 8px; }
  @media (pointer: coarse) {
    .rs-menu .rs-btn, .rs-plaza .rs-btn { min-height: 40px; }
  }
  @media (max-width: 860px) {
    .rs-plaza { top: 108px; max-height: calc(100dvh - 120px); }
  }
  @media (max-height: 520px) {
    .rs-menu { padding: 10px 14px; }
    .rs-menu h2 { font-size: 18px; }
    .rs-menu .tag { margin-bottom: 6px; }
    .rs-menu .big { padding: 8px 12px; margin: 4px 0; font-size: 15px; }
    .rs-plaza { top: calc(env(safe-area-inset-top, 0px) + 44px); width: min(270px, 42vw); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 52px); padding: 8px 10px; }
  }
`;

export function createPlazaUi(a: PlazaUiActions) {
  const menu = el('div', 'rs-card rs-menu');
  const card = el('div', 'rs-card rs-plaza');
  menu.style.display = card.style.display = 'none';
  let lastMenu = '';
  let lastCard = '';
  let folded: boolean | null = null;
  let joining = false;

  /** A room-code field and its Join, with what is wrong with the code. */
  const joinRow = () => {
    const row = el('div', 'more');
    const input = el('input', 'rs-input');
    input.maxLength = 6;
    input.placeholder = 'CODE';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.autocapitalize = 'characters';
    input.setAttribute('autocorrect', 'off');
    input.enterKeyHint = 'go';
    const err = el('div', 'rs-err');
    const go = () => {
      const id = normalizeRoomId(input.value);
      if (!id) {
        err.textContent = 'Room codes look like A7F2 (4 letters and numbers).';
        return;
      }
      err.textContent = '';
      a.joinRoom(id);
    };
    input.addEventListener('focus', () => a.releaseKeys());
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') input.blur();
    });
    row.append(input, button('Join', go, 'rs-btn go'));
    return [row, err];
  };

  const renderMenu = (v: MenuView) => {
    const enter = button('', a.enterPlaza, 'rs-btn go big');
    enter.append(document.createTextNode('Enter Plaza'), el('small', undefined, 'Walk around, meet other Blobbis, get ready'));
    const quick = button('', a.quickMatch, 'rs-btn big');
    quick.append(document.createTextNode('Quick Match'), el('small', undefined, 'Jump straight into a match'));
    const more = el('div', 'more');
    more.append(button('Create room', a.createRoom), button(joining ? 'Hide' : 'Join room', () => {
      joining = !joining;
      lastMenu = '';
    }));
    const who = el('div', 'who');
    if (v.who.name) who.append(document.createTextNode(`Playing as ${v.who.name}`));
    else if (v.who.busy) who.append(document.createTextNode('Connecting Nostr…'));
    else who.append(document.createTextNode('Playing as a guest · '), button('Connect Nostr', a.connectNostr));
    menu.replaceChildren(el('h2', undefined, 'BLOBBI RUMBLE'), el('div', 'tag', 'A party brawler for Blobbis'), enter, quick, more, ...(joining ? joinRow() : []), who);
  };

  const renderCard = (v: PlazaView) => {
    const lines = plazaLines(v);
    const hd = el('div', 'hd');
    hd.append(el('span', 'ttl', 'Blobbi Plaza'), el('span', 'rs-sub', lines.here));
    if (folded) hd.append(button('Quick Match', a.quickMatch, 'rs-btn go'));
    hd.append(button(folded ? '▸' : '▾', () => {
      folded = !folded;
      lastCard = '';
    }, 'rs-btn fold'));
    const body = el('div', 'body');
    const blobbi = el('div', 'line');
    blobbi.append(document.createTextNode(`${lines.blobbi} `), button('Choose…', a.openSession));
    body.append(el('div', 'line', lines.who), blobbi);
    const acts = el('div', 'acts');
    acts.append(button('Create room', a.createRoom), button(joining ? 'Hide' : 'Join room', () => {
      joining = !joining;
      lastCard = '';
    }), button('Quick Match', a.quickMatch, 'rs-btn go'), button('Menu', a.toMenu));
    body.append(acts, ...(joining ? joinRow() : []), el('div', 'rs-sub', 'Everyone here sees your name and your Blobbi.'));
    card.className = `rs-card rs-plaza${folded ? ' folded' : ''}`;
    card.replaceChildren(hd, body);
  };

  /** Whether a field of these cards has the keyboard (never rebuilt under someone typing). */
  const typing = () => {
    const active = (globalThis.document as Document | undefined)?.activeElement ?? null;
    return !!active && (menu.contains?.(active) || card.contains?.(active));
  };

  return {
    nodes: [menu, card] as const,
    get menuOpen() {
      return menu.style.display === 'block';
    },
    get cardOpen() {
      return card.style.display === 'block' && !folded;
    },
    /** The menu (null: hidden). */
    showMenu(v: MenuView | null) {
      const key = v ? JSON.stringify([v, joining]) : '';
      if (key !== lastMenu && !typing()) {
        lastMenu = key;
        if (v) renderMenu(v);
      }
      const d = v ? 'block' : 'none';
      if (menu.style.display !== d) {
        menu.style.display = d;
        if (!v) joining = false;
      }
    },
    /** The plaza card (null: hidden: not on the plaza, or another card is up). */
    showPlaza(v: PlazaView | null) {
      if (v && folded === null) folded = v.touch;
      const key = v ? JSON.stringify([v, folded, joining]) : '';
      if (key !== lastCard && !typing()) {
        lastCard = key;
        if (v) renderCard(v);
      }
      const d = v ? 'block' : 'none';
      if (card.style.display !== d) card.style.display = d;
    },
  };
}
