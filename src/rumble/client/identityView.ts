/**
 * THE IDENTITY UI (network mode): a small card under the connection pill
 * ("Nostr · Guest [Connect Nostr]" / "Connected as Daniel [Disconnect]"),
 * a light first-visit welcome card (never blocking: the game is already
 * playable behind it), and the player list (P1 Daniel · P2 Guest · P3 Bot).
 *
 * Everything from Nostr is hostile input: names go in with `textContent`
 * only, pictures are https URLs (already checked) in an <img> with no
 * referrer, and a picture that fails becomes the pubkey's identicon. No
 * innerHTML anywhere here. Buttons never take keyboard focus, so Space and
 * Enter stay jump.
 */
import { fallbackAvatar } from '../../social/avatar';
import { npubOf, shortNpub } from '../../social/keys';
import { clip, displayName, type Profile } from '../../social/profile';
import type { SlotIdentity } from '../net/protocol';
import type { IdentityState } from './identity';

export interface IdentityViewActions {
  connect(): void;
  disconnect(): void;
  guest(): void;
  dismissError(): void;
}

export interface IdentityViewInput {
  state: IdentityState;
  profile: (pubkey: string) => Profile | null | undefined;
  /** Per slot, from the server (null: none yet). */
  roster: Record<string, SlotIdentity> | null;
  you: string | null;
  welcome: boolean;
}

const SVG = 'http://www.w3.org/2000/svg';

/** An avatar: the profile picture, or (none, or it fails) the pubkey's identicon. */
export function avatar(pubkey: string | null, picture: string | undefined, size = 20): HTMLElement {
  const box = document.createElement('span');
  box.className = 'rn-avatar';
  box.style.width = box.style.height = `${size}px`;
  const identicon = () => {
    box.replaceChildren();
    if (!pubkey) {
      box.textContent = '?';
      return;
    }
    const a = fallbackAvatar(pubkey);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 5 5');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
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
    const img = document.createElement('img');
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.loading = 'lazy';
    img.alt = '';
    img.width = img.height = size;
    img.addEventListener('error', identicon, { once: true });
    img.src = picture;
    box.appendChild(img);
  } else identicon();
  return box;
}

function button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.className = primary ? 'rn-btn primary' : 'rn-btn';
  b.tabIndex = -1;
  // Never take focus: Space / Enter must keep meaning jump.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

const span = (text: string, cls?: string) => {
  const s = document.createElement('span');
  s.textContent = text;
  if (cls) s.className = cls;
  return s;
};

export function createIdentityView(actions: IdentityViewActions) {
  const style = document.createElement('style');
  style.textContent = `
    .rn-side { position: fixed; left: 12px; top: 50px; display: flex; flex-direction: column; gap: 8px; max-width: 300px; font: 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; }
    .rn-card { padding: 8px 12px; border-radius: 14px; background: rgba(255,255,255,0.88); box-shadow: 0 4px 16px rgba(40,50,80,0.15); }
    .rn-id { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .rn-id .who { display: flex; flex-direction: column; min-width: 0; }
    .rn-id .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
    .rn-id .sub, .rn-players .sub { color: #6b7082; font-size: 11px; }
    .rn-id .err { color: #b0413e; font-size: 12px; flex-basis: 100%; }
    .rn-btn { font: 600 12px ui-sans-serif, system-ui, sans-serif; padding: 4px 10px; border: 1px solid #d6dbe6; border-radius: 8px; background: #fff; color: #2b2b3a; cursor: pointer; }
    .rn-btn.primary { border-color: #6fc38f; background: #6fc38f; color: #fff; }
    .rn-avatar { display: inline-flex; align-items: center; justify-content: center; flex: none; border-radius: 50%; overflow: hidden; background: #eef1f6; font-size: 11px; }
    .rn-avatar img, .rn-avatar svg { width: 100%; height: 100%; object-fit: cover; display: block; }
    .rn-players { display: grid; grid-template-columns: auto auto 1fr auto; gap: 4px 8px; align-items: center; }
    .rn-players .slot { font: 600 11px ui-monospace, Menlo, monospace; color: #6b7082; }
    .rn-players .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    .rn-welcome { position: fixed; left: 50%; top: 64px; transform: translateX(-50%); max-width: 380px; padding: 14px 18px; border-radius: 16px; background: rgba(255,255,255,0.95); box-shadow: 0 10px 40px rgba(40,50,80,0.22); font: 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; text-align: center; }
    .rn-welcome h3 { margin: 0 0 4px; font-size: 16px; letter-spacing: 0.04em; }
    .rn-welcome p { margin: 0 0 10px; color: #555a6e; }
    .rn-welcome .rn-btn { margin: 0 4px; padding: 6px 14px; font-size: 13px; }
  `;
  document.head.appendChild(style);
  const side = document.createElement('div');
  side.className = 'rn-side';
  const idCard = document.createElement('div');
  idCard.className = 'rn-card rn-id';
  const players = document.createElement('div');
  players.className = 'rn-card rn-players';
  side.append(idCard, players);
  const welcome = document.createElement('div');
  welcome.className = 'rn-welcome';
  welcome.style.display = 'none';
  document.body.append(side, welcome);

  const nameOf = (pubkey: string, profile: Profile | null | undefined, max: number) => clip(displayName(profile, pubkey), max);

  const renderId = (v: IdentityViewInput) => {
    const s = v.state;
    const profile = s.pubkey ? v.profile(s.pubkey) : undefined;
    const name = s.pubkey ? nameOf(s.pubkey, profile, 32) : '';
    const parts: Node[] = [];
    const who = (title: string, sub: string) => {
      const w = document.createElement('span');
      w.className = 'who';
      w.append(span(title, 'name'), span(sub, 'sub'));
      return w;
    };
    switch (s.phase) {
      case 'guest':
        parts.push(who('Nostr · Guest', 'your name is P1–P4'), button('Connect Nostr', actions.connect, true));
        break;
      case 'known':
        parts.push(avatar(s.pubkey, profile?.picture), who(name, 'not signed in on this server'), button(`Continue as ${clip(name, 14)}`, actions.connect, true), button('Forget', actions.disconnect));
        break;
      case 'asking':
        parts.push(who('Nostr · waiting…', 'answer your extension’s prompt'));
        break;
      case 'proving':
        parts.push(avatar(s.pubkey, profile?.picture), who(name, 'verifying with the game server…'));
        break;
      case 'verified':
        parts.push(avatar(s.pubkey, profile?.picture, 26), who(`Connected as ${name}`, shortNpub(s.pubkey!, 8, 6)), button('Disconnect', actions.disconnect));
        break;
      case 'error':
        parts.push(span(s.error ?? 'Something went wrong.', 'err'), button('Try again', actions.connect, true), button('Play as guest', actions.dismissError));
        break;
    }
    idCard.replaceChildren(...parts);
    idCard.title = s.phase === 'verified' && s.pubkey ? npubOf(s.pubkey) : '';
  };

  const renderPlayers = (v: IdentityViewInput) => {
    const rows: Node[] = [];
    for (const [slot, id] of Object.entries(v.roster ?? {})) {
      const mine = slot === v.you;
      let label: string;
      let pic: HTMLElement;
      let tag: string;
      if (id.who === 'nostr') {
        const p = v.profile(id.pubkey);
        label = nameOf(id.pubkey, p, 24);
        pic = avatar(id.pubkey, p?.picture, 18);
        tag = mine ? 'you · nostr' : 'nostr';
      } else {
        label = id.who === 'bot' ? 'Bot' : 'Guest';
        pic = avatar(null, undefined, 18);
        pic.textContent = id.who === 'bot' ? '·' : '?';
        tag = mine ? 'you' : '';
      }
      rows.push(span(slot, 'slot'), pic, span(label, 'name'), span(tag, 'sub'));
    }
    players.replaceChildren(...rows);
    players.style.display = rows.length ? '' : 'none';
  };

  const renderWelcome = (show: boolean) => {
    welcome.style.display = show ? '' : 'none';
    if (!show || welcome.childElementCount) return;
    const h = document.createElement('h3');
    h.textContent = 'BLOBBI RUMBLE';
    const p = document.createElement('p');
    p.textContent = 'You are already in, as a guest. Connect Nostr to show your name to the other players.';
    welcome.append(h, p, button('Connect Nostr', actions.connect, true), button('Continue as guest', actions.guest));
  };

  let lastId = '';
  let lastPlayers = '';
  let lastWelcome: boolean | null = null;
  return {
    /** Bring the UI up to date; cheap when nothing changed (it compares a summary first). */
    show(v: IdentityViewInput) {
      const own = v.state.pubkey ? v.profile(v.state.pubkey) : undefined;
      const idKey = JSON.stringify([v.state.phase, v.state.pubkey, v.state.error, own?.displayName, own?.name, own?.picture]);
      if (idKey !== lastId) {
        lastId = idKey;
        renderId(v);
      }
      const plKey = JSON.stringify([v.you, v.roster, Object.values(v.roster ?? {}).map((x) => (x.who === 'nostr' ? v.profile(x.pubkey) ?? null : null))]);
      if (plKey !== lastPlayers) {
        lastPlayers = plKey;
        renderPlayers(v);
      }
      if (v.welcome !== lastWelcome) {
        lastWelcome = v.welcome;
        renderWelcome(v.welcome);
      }
    },
  };
}
