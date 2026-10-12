/**
 * Small DOM helpers for the game's interface. Text only ever goes in as
 * text (`textContent`), never markup. A click or a tap never leaves a
 * button focused, so Space and Enter keep meaning jump; L4.2: the keyboard
 * can still reach every button (Tab), and while one has the focus the
 * game leaves the keys it acts on alone (`isUiKey`).
 */
import { fallbackAvatar } from '../../social/avatar';
import { interfaceKeeps } from '../control/input';

const SVG = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(text: string, onClick: () => void, cls = 'rs-btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  // A pointer never focuses it (Space / Enter must keep meaning jump); Tab still reaches it.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** An avatar: the profile picture (an https URL, already checked), or (none, or it fails) the pubkey's identicon. */
export function avatar(pubkey: string | null, picture: string | undefined, size = 20): HTMLElement {
  const box = el('span', 'rs-avatar');
  box.style.width = box.style.height = `${size}px`;
  const identicon = () => {
    box.replaceChildren();
    if (!pubkey) return;
    const a = fallbackAvatar(pubkey);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 5 5');
    const bg = document.createElementNS(SVG, 'rect');
    bg.setAttribute('width', '5');
    bg.setAttribute('height', '5');
    bg.setAttribute('fill', `hsl(${a.hue} 45% 90%)`);
    svg.appendChild(bg);
    a.cells.forEach((on, i) => {
      if (!on) return;
      const r = document.createElementNS(SVG, 'rect');
      r.setAttribute('x', String(i % 5));
      r.setAttribute('y', String(Math.floor(i / 5)));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      r.setAttribute('fill', `hsl(${a.hue} 55% 48%)`);
      svg.appendChild(r);
    });
    box.appendChild(svg);
  };
  if (picture) {
    const img = el('img');
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.alt = '';
    img.addEventListener('error', identicon, { once: true });
    img.src = picture;
    box.appendChild(img);
  } else identicon();
  return box;
}

/** Whether a key event is someone typing in a field (game keys must leave it alone). */
export const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/**
 * L4.2: whether a key event belongs to the interface: typing, or a key a
 * control the keyboard reached acts on (Space presses the button, it does
 * not jump). L4.4A: only those keys; the rest of the game's keys still play.
 */
export const isUiKey = (e: KeyboardEvent) => interfaceKeeps(e.target, e.code);

/**
 * L4.4A: where the keyboard goes when a sheet closes. A sheet used from the
 * keyboard (opened with it, or Tabbed into) hands it back to the button
 * that opened it, as a keyboard user expects; one closed with a pointer
 * (its ✕, a press outside) gives it back to the game: whatever interface
 * element holds the focus lets it go, so the game's keys play at once,
 * with no click on the arena first.
 */
export function focusAfterClose(o: { keyboardLast: boolean; openedByKeyboard: boolean; focusInside: boolean; insideByKeyboard: boolean; onTrigger: boolean }): 'trigger' | 'release' | 'keep' {
  if (o.keyboardLast && (o.openedByKeyboard || (o.focusInside && o.insideByKeyboard))) return 'trigger';
  return o.focusInside || o.onTrigger ? 'release' : 'keep';
}
