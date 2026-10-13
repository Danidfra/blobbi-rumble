/**
 * THE MENU AND THE WAYS ON (L4.1, redrawn in L4.2). Part of the game's
 * shell, drawn with its parts (`uiTheme.ts`) and DOM rules: text only, a
 * click never leaves a button focused (Space and Enter stay jump), a code
 * field that owns the keyboard only while it is focused.
 *
 *   the menu   a plain visit's first screen, before anything connects: the
 *              game's front door. Three Blobbis and the name; Enter Plaza
 *              (the one big way in), Quick Match, Create room, Join room by
 *              its code; who you play as, and Connect Nostr. On a phone on
 *              its side the two halves sit side by side.
 *   the ways   the same ways on, as one block the shell's sheets reuse: from
 *              the plaza (Quick Match, Create, Join), or from a room or a
 *              match (to the plaza as well). Join opens its code field in
 *              place; a bad code says why.
 *
 * The plaza's own indicator (its name and how many are there) is the
 * shell's place pill (`hud.ts`); its menu is the shell's place sheet.
 */
import { normalizeRoomId } from '../net/roomId';
import { avatar, button, el } from './dom';
import type { RumbleLook } from './rumbleForm';

export interface PlazaUiActions {
  enterPlaza(): void;
  quickMatch(): void;
  createRoom(): void;
  joinRoom(code: string): void;
  toMenu(): void;
  connectNostr(): void;
  confirmNostrServer(): void;
  cancelNostrServer(): void;
  /** A field took the keyboard: let go of every game key. */
  releaseKeys(): void;
}

/** Who the player is, as the menu and the sheets say it: a display name (never a key), or a guest. */
export interface Who {
  name: string | null;
  /** Connecting or proving now. */
  busy: boolean;
  /** A proven identity's key and picture, for its avatar only (never shown as text). */
  pubkey?: string | null;
  picture?: string;
  /** L4.5B: Connect was pressed on a server that is not built in: its host, while the player is asked. */
  confirm?: string;
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

/** L4.1: what the plaza says about who you are and what you wear. Pure. */
export function plazaLines(v: PlazaView): { who: string; blobbi: string; here: string } {
  return {
    who: v.who.name ? `You: ${v.who.name}` : v.who.busy ? 'You: connecting Nostr…' : 'You: Guest',
    blobbi: v.blobbi ? `Blobbi: ${v.blobbi}` : 'Blobbi: the default one',
    here: `${v.here} of ${v.capacity} here`,
  };
}

export interface PlazaUiDeps {
  /** A picture of a look (null: none can be drawn). */
  preview: (look: RumbleLook) => Promise<string | null>;
  /** The menu's three Blobbis. */
  mascots: RumbleLook[];
}

export const PLAZA_CSS = `
  .rs-menu { position: fixed; inset: 0; z-index: 5; display: none; align-items: center; justify-content: center; padding: calc(var(--rs-safe-t) + 56px) calc(var(--rs-safe-r) + 16px) calc(var(--rs-safe-b) + 16px) calc(var(--rs-safe-l) + 16px); overflow: auto; overscroll-behavior: contain; background: radial-gradient(circle at 18% 22%, rgba(255,159,191,0.30), transparent 34%), radial-gradient(circle at 82% 30%, rgba(143,124,240,0.24), transparent 36%), radial-gradient(circle at 60% 88%, rgba(143,224,176,0.30), transparent 38%), rgba(236,240,252,0.92); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .rs-menu .box { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; align-items: center; width: min(760px, 100%); padding: 26px 28px 20px; border-radius: 28px; background: var(--rs-card); box-shadow: var(--rs-shadow); }
  .rs-menu .hero { text-align: center; }
  .rs-menu .mascots { display: flex; justify-content: center; align-items: flex-end; height: 104px; margin-bottom: 8px; }
  .rs-menu .mascots .pic { width: 84px; height: 84px; margin: 0 -6px; display: flex; align-items: center; justify-content: center; }
  .rs-menu .mascots .pic:nth-child(2) { width: 104px; height: 104px; z-index: 1; }
  .rs-menu .mascots img { width: 100%; height: 100%; object-fit: contain; display: block; filter: drop-shadow(0 6px 10px rgba(52,46,98,0.18)); }
  .rs-menu h1 { margin: 0; font: 900 34px/1.05 var(--rs-font); letter-spacing: 0.01em; color: var(--rs-ink); }
  .rs-menu h1 span { color: #e0608e; }
  .rs-menu .tag { margin: 6px 0 0; color: var(--rs-sub); font-size: 14px; }
  .rs-menu .acts { display: flex; flex-direction: column; gap: 8px; }
  .rs-menu .big { display: flex; align-items: center; justify-content: flex-start; gap: 12px; width: 100%; min-height: 62px; padding: 10px 16px; border-radius: 18px; text-align: left; font-size: 17px; white-space: normal; }
  .rs-menu .big .ic { font-size: 24px; }
  .rs-menu .big small { display: block; margin-top: 2px; font: 600 12px var(--rs-font); opacity: 0.8; }
  .rs-menu .big.go { min-height: 72px; font-size: 19px; }
  .rs-menu .who { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; padding-top: 14px; border-top: 1.5px solid var(--rs-line); color: var(--rs-sub); font-size: 13px; }
  .rs-menu .who b { color: var(--rs-ink); }
  .rs-join { display: none; gap: 6px; align-items: center; margin-top: 2px; }
  .rs-join.on { display: flex; }
  .rs-join .rs-input { flex: 1; min-width: 0; }
  .rs-input { width: 100px; min-height: 36px; font: 800 16px ui-monospace, Menlo, monospace; letter-spacing: 0.14em; text-transform: uppercase; padding: 4px 10px; border: 1.5px solid var(--rs-line); border-radius: var(--rs-r-md); background: #fff; color: var(--rs-ink); }
  .rs-input:focus { border-color: var(--rs-lilac); outline: none; box-shadow: 0 0 0 3px var(--rs-lilac-soft); }
  .rs-ways { display: flex; flex-direction: column; gap: 6px; }
  .rs-ways .rs-btn.go { min-height: 44px; font-size: 15px; }
  @media (max-width: 640px) and (min-height: 521px) {
    .rs-menu .box { grid-template-columns: 1fr; gap: 16px; padding: 20px 18px 16px; }
    .rs-menu .mascots { height: 84px; }
    .rs-menu .mascots .pic { width: 66px; height: 66px; }
    .rs-menu .mascots .pic:nth-child(2) { width: 84px; height: 84px; }
    .rs-menu h1 { font-size: 28px; }
  }
  /* A phone on its side: the two halves side by side, everything in the short height without scrolling. */
  @media (max-height: 520px) {
    .rs-menu { padding: calc(var(--rs-safe-t) + 50px) calc(var(--rs-safe-r) + 12px) calc(var(--rs-safe-b) + 8px) calc(var(--rs-safe-l) + 12px); }
    .rs-menu .box { gap: 18px; padding: 14px 18px 10px; border-radius: 22px; width: min(720px, 100%); }
    .rs-menu .mascots { height: 70px; margin-bottom: 4px; }
    .rs-menu .mascots .pic { width: 56px; height: 56px; }
    .rs-menu .mascots .pic:nth-child(2) { width: 70px; height: 70px; }
    .rs-menu h1 { font-size: 24px; }
    .rs-menu .tag { font-size: 12px; }
    .rs-menu .acts { gap: 6px; }
    .rs-menu .big { min-height: 46px; padding: 6px 12px; font-size: 15px; }
    .rs-menu .big.go { min-height: 54px; font-size: 16px; }
    .rs-menu .big .ic { font-size: 20px; }
    .rs-menu .who { padding-top: 8px; font-size: 12px; }
  }
`;

export function createPlazaUi(a: PlazaUiActions, deps: PlazaUiDeps) {
  const menu = el('div', 'rs-ui rs-menu');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Blobbi Rumble');
  menu.style.display = 'none';
  let lastMenu = '';
  const pictures: (string | null)[] = deps.mascots.map(() => null);

  /** A room-code field and its Join, hidden until asked for, with what is wrong with the code. */
  const joinRow = () => {
    const row = el('div', 'rs-join');
    const input = el('input', 'rs-input');
    input.maxLength = 6;
    input.placeholder = 'CODE';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.autocapitalize = 'characters';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', 'Room code');
    input.enterKeyHint = 'go';
    const err = el('div', 'rs-err');
    err.setAttribute('role', 'alert');
    const go = () => {
      const id = normalizeRoomId(input.value);
      if (!id) {
        err.textContent = 'Room codes look like A7F2 (4 letters and numbers).';
        return;
      }
      err.textContent = '';
      input.blur?.();
      a.joinRoom(id);
    };
    input.addEventListener('focus', () => a.releaseKeys());
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') input.blur();
    });
    row.append(input, button('Join', go, 'rs-btn go'));
    /** The button that opens it: shows the field (and gives it the keyboard), or hides it again. */
    const toggle = button('# Join room', () => {
      const on = !row.className.includes(' on');
      row.className = `rs-join${on ? ' on' : ''}`;
      toggle.setAttribute('aria-expanded', String(on));
      if (on) input.focus?.();
      else err.textContent = '';
    });
    toggle.setAttribute('aria-expanded', 'false');
    return { toggle, row, err };
  };

  const big = (icon: string, label: string, sub: string, onClick: () => void, primary = false) => {
    const b = button('', onClick, `rs-btn big${primary ? ' go' : ''}`);
    const words = el('span');
    words.append(document.createTextNode(label), el('small', undefined, sub));
    b.append(el('span', 'ic', icon), words);
    b.setAttribute('aria-label', `${label}: ${sub}`);
    return b;
  };

  const renderMenu = (v: MenuView) => {
    const hero = el('div', 'hero');
    const mascots = el('div', 'mascots');
    deps.mascots.forEach((look, i) => {
      const box = el('span', 'pic');
      const put = (src: string | null) => {
        if (!src) return;
        const img = el('img');
        img.alt = '';
        img.src = src;
        box.replaceChildren(img);
      };
      if (pictures[i]) put(pictures[i]);
      else
        void deps.preview(look).then((src) => {
          pictures[i] = src;
          put(src);
        });
      mascots.append(box);
    });
    const title = el('h1');
    title.append(document.createTextNode('Blobbi '), el('span', undefined, 'Rumble'));
    hero.append(mascots, title, el('p', 'tag', 'Meet other Blobbis, then bounce them off the islands.'));
    const acts = el('div', 'acts');
    const join = joinRow();
    const more = el('div', 'rs-grid2');
    more.append(button('＋ Create room', a.createRoom), join.toggle);
    acts.append(big('🌸', 'Enter Plaza', 'Walk around and meet other Blobbis', a.enterPlaza, true), big('⚡', 'Quick Match', 'Jump straight into a match', a.quickMatch), more, join.row, join.err);
    const who = el('div', 'who');
    if (v.who.name) who.append(avatar(v.who.pubkey ?? null, v.who.picture, 22), document.createTextNode('Playing as '), el('b', undefined, v.who.name));
    else if (v.who.busy) who.append(document.createTextNode('Connecting Nostr…'));
    else if (v.who.confirm) who.append(document.createTextNode(`This game runs on ${v.who.confirm}. Connecting shows it your public Nostr identity.`), button('Connect', a.confirmNostrServer, 'rs-btn soft'), button('Stay a guest', a.cancelNostrServer, 'rs-btn soft'));
    else who.append(document.createTextNode('Playing as a guest'), button('Connect Nostr', a.connectNostr, 'rs-btn soft'));
    const box = el('div', 'box');
    box.append(hero, acts, who);
    menu.replaceChildren(box);
  };

  /** Whether a field of the menu has the keyboard (never rebuilt under someone typing). */
  const typing = () => {
    const active = (globalThis.document as Document | undefined)?.activeElement ?? null;
    return !!active && !!menu.contains?.(active);
  };

  return {
    nodes: [menu] as const,
    get menuOpen() {
      return menu.style.display === 'flex';
    },
    /** The menu (null: hidden). */
    showMenu(v: MenuView | null) {
      const key = v ? JSON.stringify(v) : '';
      if (key !== lastMenu && !typing()) {
        lastMenu = key;
        if (v) renderMenu(v);
      }
      const d = v ? 'flex' : 'none';
      if (menu.style.display !== d) menu.style.display = d;
    },
    /**
     * The ways on, for a sheet: from the plaza (Quick Match first), or from a room or a match (the plaza
     * first). The main menu is the sheet's own footer.
     */
    ways(from: 'plaza' | 'elsewhere'): HTMLElement {
      const box = el('div', 'rs-ways');
      const join = joinRow();
      const grid = el('div', 'rs-grid2');
      grid.append(button('＋ Create room', a.createRoom), join.toggle);
      if (from === 'plaza') box.append(button('⚡ Quick Match', a.quickMatch, 'rs-btn go wide'), grid, join.row, join.err);
      else {
        const top = el('div', 'rs-grid2');
        top.append(button('🌸 Plaza', a.enterPlaza, 'rs-btn go'), button('⚡ Quick Match', a.quickMatch));
        box.append(top, grid, join.row, join.err);
      }
      return box;
    },
  };
}
