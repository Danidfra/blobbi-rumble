/**
 * THE GAME'S INTERFACE in network mode: the arena first, the rest quiet
 * until it matters.
 *
 *   ┌ session chip ─────┐      ┌ scoreboard ┐          ┌ identity chip ┐
 *   ● A7F2 · Local server     round · P1 ●●○ …       Guest · Connect Nostr
 *
 *                       contextual message (round, match)
 *                       struggle bar (when you are held)
 *   H Help
 *
 *   on demand:  session panel (room + share link, host / join, players,
 *               identity, server), help panel (H), start card (first visit),
 *               the automatic-invites question (once, a corner card)
 *   loud:       the centred banner when play is impossible (offline, a
 *               missing room, …), with what to do about it
 *   debug:      F3 / F4 (the text HUD), unchanged, off by default
 *
 * Everything from Nostr or a server is text set with textContent. Buttons
 * never take focus; the only field (the room code) owns the keyboard while
 * focused, and the game's keys are released when it takes it.
 */
import { ROUND } from '../tuning';
import { normalizeRoomId } from '../net/roomId';
import type { RoomInfo, ServerInfo, SlotIdentity } from '../net/protocol';
import type { ServerTrust } from '../net/serverTrust';
import type { MatchSnapshot } from '../sim/snapshot';
import { npubOf, shortNpub } from '../../social/keys';
import { clip, displayName, type Profile } from '../../social/profile';
import { describe, type BannerAction, type ConnectionState } from './connection';
import { canCopy, copyShortcut, copyText } from './clipboard';
import { avatar, button, el, isTyping } from './dom';
import type { IdentityState } from './identity';
import type { InviteStatus } from './inviteSender';
import type { InboxState } from './inviteInbox';
import type { PeopleState, PersonRow } from './people';
import type { PickerState } from './blobbis';
import type { RumbleForm } from './rumbleForm';
import type { SetupState } from './inboxSetup';
import type { ReceivedInvite } from './invites';
import { isLocalHost } from '../net/serverTrust';

export interface ShellActions {
  retry(): void;
  openRoom(): void;
  hostGame(): void;
  joinGame(code: string): void;
  connectNostr(): void;
  disconnectNostr(): void;
  /** M9B.1: the extension holds another identity than the remembered one; connect it only on this click, or keep the hint without reconnecting. */
  connectOtherNostr(): void;
  dismissOtherNostr(): void;
  dismissIdentityError(): void;
  /** The code field took the keyboard: let go of every game key. */
  releaseKeys(): void;
  /** The start card was answered (don't show it again). */
  startSeen(): void;
  /** Send a private Nostr invite to an npub / nprofile (M8C-A). */
  sendInvite(recipient: string): void;
  /** M8C-C: finding whom to invite (follows, search, selection); only sendSelectedInvite sends, through the M8C-A sender. */
  sendSelectedInvite(): void;
  setPeopleQuery(text: string): void;
  selectPerson(pubkey: string): void;
  clearPerson(): void;
  morePeople(): void;
  /** M8C-B: the player asked to check for invites (decrypts a bounded number of recent private messages locally). */
  checkInvites(): void;
  joinInvite(id: string): void;
  dismissInvite(id: string): void;
  /** M8C-B.2: automatic checking, one consent per identity and origin: enable, "Not now", or turn it off later. */
  enableAutoInvites(): void;
  declineAutoInvites(): void;
  disableAutoInvites(): void;
  /** M9A: the player's own Blobbis: choose one as the preferred Rumble character (local), or the default fighter. */
  selectBlobbi(d: string): void;
  defaultBlobbi(): void;
  reloadBlobbis(): void;
  /** M8C-B.1: set up a private-message inbox (kind 10050) for an identity that has none. */
  openInboxSetup(): void;
  toggleInboxRelay(url: string): void;
  confirmInboxSetup(): void;
  closeInboxSetup(): void;
}

/** A received invite as the panel shows it. */
export interface InviteCard {
  invite: ReceivedInvite;
  trust: ServerTrust;
  /** On this page's own server (joining switches room in place) or elsewhere (joining opens that server's page). */
  sameOrigin: boolean;
}

/** Whether this player can send private invites: a guest cannot; an extension without NIP-44 cannot. */
export type InviteMode = 'guest' | 'no-nip44' | 'ready';

export interface ShellView {
  conn: ConnectionState;
  now: number;
  room: RoomInfo | null;
  share: string | null;
  trust: ServerTrust | null;
  server: ServerInfo | null;
  identity: IdentityState;
  profile: (pubkey: string) => Profile | null | undefined;
  roster: Record<string, SlotIdentity> | null;
  spectators: number;
  you: string | null;
  snapshot: MatchSnapshot | null;
  /** The presenter's current message (slot ids in it are replaced by names). */
  message: string;
  /** A proven person's name for a slot, or null. */
  nameOf: (slot: string) => string | null;
  startCard: boolean;
  invite: { mode: InviteMode; status: InviteStatus | null; busy: boolean };
  /** M8C-C: the people finder of the connected identity (null: none, or not a private room). */
  people: PeopleState | null;
  /** M9A: the connected identity's Blobbis and its local choice (null: no verified identity); M9B: the form the chosen one takes here, and whether the fighter wears it. */
  blobbis: { state: PickerState; form: RumbleForm | null; note: 'worn' | 'default' | 'refused' } | null;
  /** M8C-B: the invite inbox of the connected identity (null: no identity connected in this page); `offer`: ask about automatic checking now (M8C-B.2). */
  inbox: { state: InboxState; cards: InviteCard[]; setup: SetupState | null; offer: boolean } | null;
}

const CSS = `
  .rs-top { position: fixed; top: 10px; left: 10px; right: 10px; display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; pointer-events: none; z-index: 5; font: 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; }
  .rs-top > * { pointer-events: auto; }
  .rs-chip { display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: 999px; background: rgba(255,255,255,0.82); box-shadow: 0 3px 12px rgba(40,50,80,0.13); cursor: pointer; white-space: nowrap; max-width: 46vw; overflow: hidden; }
  .rs-chip:hover { background: rgba(255,255,255,0.95); }
  .rs-chip .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #6fc38f; }
  .rs-chip .dot.wait { background: #e6b450; }
  .rs-chip .dot.off { background: #d0605c; }
  .rs-chip b { font-weight: 700; letter-spacing: 0.04em; }
  .rs-chip .dim { color: #6b7082; overflow: hidden; text-overflow: ellipsis; }
  .rs-board { display: flex; gap: 4px; padding: 4px; border-radius: 14px; background: rgba(255,255,255,0.7); box-shadow: 0 3px 12px rgba(40,50,80,0.12); }
  .rs-board .round { align-self: center; padding: 0 6px; font: 600 11px ui-sans-serif, system-ui, sans-serif; color: #6b7082; white-space: nowrap; }
  .rs-pl { display: flex; flex-direction: column; align-items: center; min-width: 64px; max-width: 118px; padding: 3px 8px; border-radius: 10px; background: rgba(255,255,255,0.75); }
  .rs-pl.me { box-shadow: inset 0 0 0 2px #6fc38f; }
  .rs-pl.out { opacity: 0.45; }
  .rs-pl .nm { font-weight: 600; font-size: 12px; max-width: 102px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-pl .sc { font-size: 10px; letter-spacing: 2px; color: #3d8f5e; }
  .rs-pl .pw { font-size: 10px; color: #b07a12; }
  .rs-msg { position: fixed; left: 50%; top: 22vh; transform: translateX(-50%); max-width: 80vw; padding: 8px 18px; border-radius: 14px; background: rgba(43,43,58,0.72); color: #fff; font: 700 20px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.02em; text-align: center; pointer-events: none; display: none; z-index: 4; }
  .rs-struggle { position: fixed; left: 50%; bottom: 14vh; transform: translateX(-50%); padding: 8px 14px; border-radius: 14px; background: rgba(176,65,62,0.88); color: #fff; font: 700 14px ui-sans-serif, system-ui, sans-serif; text-align: center; pointer-events: none; display: none; z-index: 4; }
  .rs-struggle .bar { margin-top: 6px; height: 8px; width: 220px; border-radius: 4px; background: rgba(255,255,255,0.3); overflow: hidden; }
  .rs-struggle .bar > i { display: block; height: 100%; background: #fff; }
  .rs-hint { position: fixed; left: 10px; bottom: 10px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,0.7); font: 12px ui-sans-serif, system-ui, sans-serif; color: #555a6e; cursor: pointer; z-index: 5; }
  .rs-hint kbd, .rs-help kbd { display: inline-block; padding: 0 5px; border-radius: 4px; background: #eef1f6; border: 1px solid #d6dbe6; font: 11px ui-monospace, Menlo, monospace; color: #2b2b3a; }
  .rs-card { position: fixed; z-index: 6; border-radius: 16px; background: rgba(255,255,255,0.96); box-shadow: 0 10px 40px rgba(40,50,80,0.22); font: 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; }
  .rs-panel { left: 10px; top: 50px; width: min(320px, calc(100vw - 20px)); max-height: calc(100vh - 70px); overflow: auto; padding: 12px 14px; display: none; }
  .rs-panel h4 { margin: 10px 0 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7082; }
  .rs-panel h4:first-child { margin-top: 0; }
  .rs-code { font: 700 26px ui-monospace, Menlo, monospace; letter-spacing: 0.12em; }
  .rs-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
  .rs-link { flex: 1; min-width: 0; font: 12px ui-monospace, Menlo, monospace; padding: 4px 6px; border: 1px solid #d6dbe6; border-radius: 8px; background: #f7f8fb; color: #2b2b3a; }
  .rs-input { width: 90px; font: 700 15px ui-monospace, Menlo, monospace; letter-spacing: 0.1em; text-transform: uppercase; padding: 4px 8px; border: 1px solid #d6dbe6; border-radius: 8px; }
  .rs-err { color: #b0413e; font-size: 12px; }
  .rs-ok { color: #2f7d4f; font-size: 12px; }
  .rs-warn { color: #9a6200; font-size: 12px; }
  .rs-invite { margin: 6px 0; padding: 8px 10px; border-radius: 12px; background: #f4f7f2; border: 1px solid #e1e8dc; }
  .rs-person { display: flex; align-items: center; gap: 8px; width: 100%; margin: 2px 0; padding: 4px 6px; border: 1px solid transparent; border-radius: 10px; background: none; text-align: left; font: 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; cursor: pointer; }
  .rs-person:hover { background: #f1f3f8; }
  .rs-person.sel { border-color: #d6dbe6; background: #f4f7f2; cursor: default; }
  .rs-person .who { display: flex; flex-direction: column; min-width: 0; }
  .rs-person .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-person .tag { margin-left: auto; flex: none; font-size: 11px; color: #6b7082; }
  .rs-people h5 { margin: 8px 0 2px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7082; }
  .rs-blobbi { display: flex; align-items: center; gap: 8px; margin: 3px 0; padding: 4px 6px; border: 1px solid transparent; border-radius: 10px; }
  .rs-blobbi.sel { border-color: #d6dbe6; background: #f4f7f2; }
  .rs-blobbi .pic { flex: none; width: 34px; height: 34px; border-radius: 8px; background: #eef1f6; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .rs-blobbi .pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .rs-blobbi .pic span { width: 18px; height: 18px; border-radius: 50%; }
  .rs-blobbi .who { display: flex; flex-direction: column; min-width: 0; }
  .rs-blobbi .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-blobbi .rs-btn { margin-left: auto; flex: none; }
  .rs-badge { display: inline-block; min-width: 16px; padding: 0 5px; border-radius: 999px; background: #e0794f; color: #fff; font: 700 11px ui-sans-serif, system-ui, sans-serif; text-align: center; }
  .rs-sub { color: #6b7082; font-size: 12px; }
  .rs-btn { font: 600 12px ui-sans-serif, system-ui, sans-serif; padding: 5px 11px; border: 1px solid #d6dbe6; border-radius: 9px; background: #fff; color: #2b2b3a; cursor: pointer; }
  .rs-btn.go { border-color: #6fc38f; background: #6fc38f; color: #fff; }
  .rs-players { display: grid; grid-template-columns: auto auto 1fr auto; gap: 4px 8px; align-items: center; }
  .rs-players .slot { font: 600 11px ui-monospace, Menlo, monospace; color: #6b7082; }
  .rs-players .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-avatar { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; background: #eef1f6; }
  .rs-avatar img, .rs-avatar svg { width: 100%; height: 100%; object-fit: cover; display: block; }
  .rs-help { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(400px, calc(100vw - 20px)); padding: 16px 20px; display: none; line-height: 1.8; }
  .rs-help h3, .rs-start h3 { margin: 0 0 6px; font-size: 16px; letter-spacing: 0.05em; }
  .rs-help .x { position: absolute; right: 10px; top: 8px; }
  .rs-start { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(360px, calc(100vw - 20px)); padding: 18px 20px; text-align: center; display: none; }
  .rs-start p { margin: 0 0 12px; color: #555a6e; }
  .rs-start .rs-btn { margin: 3px; padding: 7px 14px; font-size: 13px; }
  .rs-start .id { margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef1f6; font-size: 12px; color: #555a6e; }
  .rs-consent { right: 10px; bottom: 10px; width: min(340px, calc(100vw - 20px)); padding: 12px 14px; display: none; }
  .rs-toasts { position: fixed; left: 50%; top: 80px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; z-index: 7; }
  .rs-toast { padding: 5px 12px; border-radius: 10px; background: rgba(43,43,58,0.85); color: #fff; font: 12px ui-sans-serif, system-ui, sans-serif; }
  .rs-banner { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(210,225,245,0.55); backdrop-filter: blur(2px); z-index: 8; }
  .rs-banner > div { max-width: 460px; margin: 16px; padding: 18px 22px; border-radius: 16px; background: rgba(255,255,255,0.96); box-shadow: 0 10px 40px rgba(40,50,80,0.25); font: 14px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; text-align: center; }
  .rs-banner h2 { margin: 0 0 6px; font-size: 18px; }
  .rs-banner p { margin: 0 0 12px; color: #555a6e; word-break: break-word; }
  .rs-banner .rs-btn { margin: 3px; padding: 7px 14px; font-size: 13px; }
  #hud { top: 52px !important; max-height: calc(100vh - 70px); overflow: auto; }
  @media (max-width: 860px) {
    .rs-board { order: 3; flex-basis: 100%; justify-content: center; flex-wrap: wrap; background: none; box-shadow: none; padding: 0; }
    .rs-pl { min-width: 54px; }
    .rs-chip { max-width: 48vw; }
    .rs-toasts { top: auto; bottom: 46px; }
    .rs-panel { top: 108px; max-height: calc(100vh - 128px); }
    #hud { top: 108px !important; }
  }
`;

const HELP: [string, string][] = [
  ['WASD / ← ↑ ↓ →', 'move'],
  ['Shift', 'run'],
  ['Space / Enter', 'jump'],
  ['F / K', 'punch'],
  ['G / L', 'grab, then again to throw'],
  ['← → (A D) fast', 'break free when grabbed'],
];

export function createShell(a: ShellActions) {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // Top bar.
  const top = el('div', 'rs-top');
  const sessionChip = el('div', 'rs-chip');
  const board = el('div', 'rs-board');
  const idChip = el('div', 'rs-chip');
  top.append(sessionChip, board, idChip);
  // Middle.
  const msg = el('div', 'rs-msg');
  const struggle = el('div', 'rs-struggle');
  // Corners and cards.
  const hint = el('div', 'rs-hint');
  hint.append(el('kbd', undefined, 'H'), document.createTextNode(' Help'));
  const panel = el('div', 'rs-card rs-panel');
  const help = el('div', 'rs-card rs-help');
  const start = el('div', 'rs-card rs-start');
  // M8C-B.2: the one-time question about automatic invites (small, a corner, only until answered).
  const consent = el('div', 'rs-card rs-consent');
  const toasts = el('div', 'rs-toasts');
  const banner = el('div', 'rs-banner');
  const bannerBox = el('div');
  banner.appendChild(bannerBox);
  document.body.append(top, msg, struggle, hint, panel, help, start, consent, toasts, banner);

  // The help card: static, built once.
  help.append(el('h3', undefined, 'How to play'), button('✕', () => toggleHelp(false), 'rs-btn x'));
  for (const [keys, what] of HELP) {
    const row = el('div');
    row.append(el('kbd', undefined, keys), document.createTextNode(`  ${what}`));
    help.appendChild(row);
  }
  help.append(el('div', 'rs-sub', 'Knock the others off the island: the last Blobbi standing wins the round; first to 3 rounds wins the match.'));
  const dbg = el('div', 'rs-sub');
  dbg.append(el('kbd', undefined, 'H'), document.createTextNode(' this help · '), el('kbd', undefined, 'F3'), document.createTextNode(' colliders · '), el('kbd', undefined, 'F4'), document.createTextNode(' network numbers'));
  help.appendChild(dbg);

  let helpOpen = false;
  let panelOpen = false;
  const toggleHelp = (open = !helpOpen) => {
    helpOpen = open;
    help.style.display = open ? 'block' : 'none';
  };
  const togglePanel = (open = !panelOpen) => {
    panelOpen = open;
    panel.style.display = open ? 'block' : 'none';
    lastPanel = '';
  };
  hint.addEventListener('click', () => toggleHelp());
  sessionChip.addEventListener('click', () => togglePanel());
  idChip.addEventListener('click', () => togglePanel(true));
  window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    if (e.code === 'KeyH') toggleHelp();
    if (e.code === 'Escape') {
      toggleHelp(false);
      togglePanel(false);
    }
  });

  // A room-code field: owns the keyboard while focused, Enter joins, Escape leaves it.
  const codeField = (onJoin: () => void) => {
    const input = el('input', 'rs-input');
    input.maxLength = 6;
    input.placeholder = 'CODE';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('focus', () => a.releaseKeys());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') onJoin();
      if (e.key === 'Escape') input.blur();
    });
    return input;
  };
  const joinRow = (err: HTMLElement) => {
    const row = el('div', 'rs-row');
    const input = codeField(() => join());
    const join = () => {
      const id = normalizeRoomId(input.value);
      if (!id) {
        err.textContent = 'Room codes look like A7F2 (4 letters and numbers).';
        return;
      }
      err.textContent = '';
      input.blur();
      a.joinGame(id);
    };
    row.append(input, button('Join', join, 'rs-btn go'));
    return row;
  };

  let toastCount = 0;
  const toast = (text: string, ms = 4000) => {
    const t = el('div', 'rs-toast', text);
    toasts.appendChild(t);
    if (++toastCount > 3) toasts.firstElementChild?.remove();
    setTimeout(() => {
      t.remove();
      toastCount--;
    }, ms);
  };

  const label = (v: ShellView, slot: string) => v.nameOf(slot) ?? slot;

  let lastSession = '';
  let lastId = '';
  let lastBoard = '';
  let lastMsg = '';
  let lastStruggle = '';
  let lastPanel = '';
  let lastStart = '';
  let lastConsent = false;
  let lastBanner = '';

  // The invite field keeps what was typed across panel redraws.
  let inviteDraft = '';
  const inviteWords = (v: ShellView, st: InviteStatus): { text: string; cls: string } => {
    const who = 'pubkey' in st ? clip(displayName(v.profile(st.pubkey), st.pubkey), 24) : '';
    switch (st.k) {
      case 'invalid':
        return { text: 'Paste an npub or nprofile.', cls: 'rs-err' };
      case 'looking':
        return { text: `Looking for ${who}’s private inbox…`, cls: 'rs-sub' };
      case 'no-inbox':
        return { text: `${who} has no private-message inbox (NIP-17 relays) set up, so the invite can’t be delivered. Copy the link instead.`, cls: 'rs-err' };
      case 'sending':
        return { text: 'Sending… approve the requests in your Nostr extension.', cls: 'rs-sub' };
      case 'sent':
        return { text: `Invite sent to ${who} (${st.accepted} of ${st.total} inbox relay${st.total === 1 ? '' : 's'}).`, cls: 'rs-ok' };
      case 'declined':
        return { text: 'Your extension declined, so nothing was sent.', cls: 'rs-err' };
      case 'failed':
        return { text: st.why === 'relays' ? `No inbox relay accepted the invite. Copy the link instead.` : `Couldn’t send: ${st.detail}.`, cls: 'rs-err' };
    }
  };
  // M8C-C: the people part of the invite section lives in one element that is refreshed on its own
  // (the panel is never rebuilt while the search box has the keyboard, so results must not depend on a rebuild).
  const peopleBox = el('div', 'rs-people');
  let lastPeople = '';
  const personRow = (v: ShellView, r: PersonRow, onClick: (() => void) | null, note?: string): HTMLElement => {
    const p = v.profile(r.pubkey);
    const row = el('button', `rs-person${onClick ? '' : ' sel'}`);
    row.type = 'button';
    row.tabIndex = -1;
    row.addEventListener('mousedown', (e) => e.preventDefault());
    if (onClick)
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
    const who = el('div', 'who');
    who.append(el('b', undefined, clip(displayName(p, r.pubkey), 26)));
    const sub = [shortNpub(r.pubkey, 6, 4)];
    // A NIP-05 is shown once its domain confirmed it: a claim alone is just text anyone can type.
    if (r.nip05?.status === 'verified') sub.push(`✓ ${r.nip05.label}`);
    who.append(el('span', 'rs-sub', sub.join(' · ')));
    row.append(avatar(r.pubkey, p?.picture, 26), who);
    if (note) row.append(el('span', 'tag', note));
    return row;
  };
  const renderPeople = (v: ShellView) => {
    const ps = v.people;
    const parts: Node[] = [];
    if (!ps) return peopleBox.replaceChildren();
    if (ps.selected) {
      parts.push(el('h5', undefined, 'Selected'));
      parts.push(personRow(v, ps.selected, null, ps.selected.followed ? 'Following' : undefined));
      const acts = el('div', 'rs-row');
      acts.append(
        button(v.invite.busy ? 'Sending…' : 'Send invite', () => {
          if (!v.invite.busy) a.sendSelectedInvite();
        }, 'rs-btn go'),
        button('Change', a.clearPerson),
      );
      parts.push(acts);
      if (v.invite.status) {
        const w = inviteWords(v, v.invite.status);
        parts.push(el('div', w.cls, w.text));
      } else parts.push(el('div', 'rs-sub', 'A private Nostr message with this room’s link. It doesn’t reserve a seat: anyone with the link can join.'));
    }
    const sr = ps.search;
    if (sr.phase !== 'idle') {
      parts.push(el('h5', undefined, 'Search results'));
      const words: Partial<Record<PeopleState['search']['phase'], string>> = {
        short: 'Type a bit more, or paste an npub.',
        invalid: 'That doesn’t look like a valid npub or nprofile.',
        resolving: 'Asking that domain who this is…',
        searching: sr.rows.length ? 'Searching the search relays too…' : 'Searching…',
        'not-found': 'No one found. Nostr has no global name index: an npub or a NIP-05 (name@domain) always works.',
      };
      if (words[sr.phase]) parts.push(el('div', 'rs-sub', words[sr.phase]!));
      for (const r of sr.rows) parts.push(personRow(v, r, () => a.selectPerson(r.pubkey), r.followed ? 'Following' : undefined));
      if (sr.phase === 'done' && sr.remote) parts.push(el('div', 'rs-sub', 'Names aren’t unique: check the npub. Results come from a few search relays and may miss people.'));
    }
    const f = ps.follows;
    if (f.phase !== 'idle' && !ps.selected) {
      parts.push(el('h5', undefined, 'People you follow'));
      if (f.phase === 'loading') parts.push(el('div', 'rs-sub', 'Reading your follow list…'));
      else if (f.phase === 'none') parts.push(el('div', 'rs-sub', 'No follow list found (or no relay answered). Search by name, npub or NIP-05 instead.'));
      else if (f.phase === 'empty') parts.push(el('div', 'rs-sub', 'You don’t follow anyone yet. Search by name, npub or NIP-05.'));
      else {
        for (const r of f.rows) parts.push(personRow(v, r, () => a.selectPerson(r.pubkey)));
        if (f.more) {
          const more = el('div', 'rs-row');
          more.append(button('Show more', a.morePeople), el('span', 'rs-sub', `${f.rows.length} of ${f.total}`));
          parts.push(more);
        }
      }
    }
    peopleBox.replaceChildren(...parts);
  };
  const inviteSection = (v: ShellView): Node[] => {
    const out: Node[] = [el('h4', undefined, 'Invite a friend')];
    if (v.invite.mode === 'guest') return [...out, el('div', 'rs-sub', 'Connect Nostr to send private invites. Or copy the link above.')];
    if (v.invite.mode === 'no-nip44') return [...out, el('div', 'rs-sub', 'Your Nostr extension can’t encrypt private messages (NIP-44), so it can’t send invites. Copy the link above instead.')];
    const row = el('div', 'rs-row');
    const input = el('input', 'rs-link');
    input.placeholder = 'Search name, npub or NIP-05';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 1000;
    input.value = inviteDraft;
    input.addEventListener('focus', () => a.releaseKeys());
    input.addEventListener('input', () => {
      inviteDraft = input.value;
      a.setPeopleQuery(input.value);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Enter') input.blur();
    });
    row.append(input);
    out.push(row, peopleBox);
    renderPeople(v);
    lastPeople = JSON.stringify([v.people, v.invite, v.invite.status && 'pubkey' in v.invite.status ? v.profile(v.invite.status.pubkey) ?? null : null]);
    return out;
  };

  const setupSection = (su: SetupState | null): Node[] => {
    const out: Node[] = [el('div', undefined, 'Private invites aren’t set up.')];
    if (!su) {
      out.push(el('div', 'rs-sub', 'To receive invites, your Nostr identity needs private-message inbox relays (NIP-17). Rumble can set them up for you: you’ll see which relays first, and nothing is published until you confirm.'));
      const row = el('div', 'rs-row');
      row.append(button('Set up private invites', a.openInboxSetup, 'rs-btn go'));
      out.push(row);
      return out;
    }
    const busy: Partial<Record<SetupState['phase'], string>> = {
      probing: 'Checking the suggested relays…',
      checking: 'Making sure you don’t have private-message relays already…',
      signing: 'Approve the signature in your Nostr extension…',
      publishing: 'Publishing your private-message relays…',
      verifying: 'Checking that others can find them…',
    };
    if (busy[su.phase]) return [...out, el('div', 'rs-sub', busy[su.phase]!)];
    out.push(el('div', 'rs-sub', 'Inbox relays (where others’ apps will deliver your private messages):'));
    const what = { answered: 'reachable', auth: 'reachable, asks you to sign in', down: 'not reachable', checking: '…' } as const;
    for (const c of su.candidates) {
      const row = el('div', 'rs-row');
      row.append(button(c.selected ? '✓' : '○', () => a.toggleInboxRelay(c.url), c.selected ? 'rs-btn go' : 'rs-btn'), el('span', undefined, c.url.replace(/\/$/, '')), el('span', 'rs-sub', what[c.probe]));
      out.push(row);
    }
    if (su.message) out.push(el('div', su.phase === 'unverified' ? 'rs-warn' : 'rs-err', su.message));
    out.push(el('div', 'rs-sub', 'Publishing makes these your private-message relays on Nostr (a public kind 10050 list that any Nostr app can read). Your extension asks to sign it; some relays may ask you to sign in too.'));
    const row = el('div', 'rs-row');
    row.append(button(su.phase === 'unverified' || su.phase === 'failed' ? 'Try again' : 'Publish and set up', a.confirmInboxSetup, 'rs-btn go'), button('Cancel', a.closeInboxSetup));
    out.push(row);
    return out;
  };

  /** The automatic-checking question (M8C-B.2), as the panel and the corner card both ask it. */
  const AUTO_WORDS = 'Rumble checks a small number of recent encrypted Nostr messages and listens for new ones while you’re connected. Other messages are discarded immediately.';
  const consentNodes = (): Node[] => {
    const row = el('div', 'rs-row');
    row.append(button('Enable automatic invites', a.enableAutoInvites, 'rs-btn go'), button('Not now', a.declineAutoInvites));
    return [el('div', undefined, 'Automatically check for Rumble invites?'), el('div', 'rs-sub', AUTO_WORDS), row];
  };

  const inboxSection = (v: ShellView, ib: NonNullable<ShellView['inbox']>): Node[] => {
    const st = ib.state;
    const out: Node[] = [el('h4', undefined, `Invites${ib.cards.length ? ` (${ib.cards.length})` : ''}`)];
    const explain = 'Checking decrypts a few recent private Nostr messages on this device to find Blobbi Rumble invites. Other messages are not shown or kept.';
    switch (st.phase) {
      case 'no-nip44':
        out.push(el('div', 'rs-sub', 'Your Nostr extension can’t decrypt private messages (NIP-44), so invites can’t be checked here. They still reach you in a Nostr messaging app.'));
        return out;
      case 'no-inbox':
        out.push(...setupSection(ib.setup));
        return out;
      case 'locating':
        out.push(el('div', 'rs-sub', 'Finding your private-message inbox…'));
        return out;
    }
    // Automatic checking (M8C-B.2): the question until answered; afterwards a plain On / Off.
    if (ib.offer) out.push(...consentNodes());
    else {
      const row = el('div', 'rs-row');
      row.append(el('span', undefined, `Automatic invites: ${st.auto === 'on' ? 'On' : 'Off'}`), st.auto === 'on' ? button('Turn off', a.disableAutoInvites) : button('Turn on', a.enableAutoInvites));
      out.push(row);
    }
    switch (st.phase) {
      case 'idle':
      case 'declined': {
        if (!ib.offer) out.push(el('div', 'rs-sub', st.phase === 'declined' ? 'Your extension declined, so the check stopped.' : explain));
        const row = el('div', 'rs-row');
        row.append(button(st.phase === 'declined' ? 'Check again' : 'Check invites', a.checkInvites, 'rs-btn go'));
        out.push(row);
        return out;
      }
      case 'checking':
        out.push(el('div', 'rs-sub', `Checking invites… (${st.checked} looked at; approve the requests in your extension)`));
        return out;
      case 'paused': {
        out.push(el('div', 'rs-warn', 'Automatic invites paused — decrypt permission needed. Allow decryption in your Nostr extension, then try again.'));
        const row = el('div', 'rs-row');
        row.append(button('Try again', a.checkInvites, 'rs-btn go'));
        out.push(row);
        break;
      }
      case 'error':
        out.push(el('div', 'rs-err', 'Couldn’t check invites.'));
        return out;
      case 'live':
        if (st.auto === 'on') out.push(el('div', 'rs-ok', 'Listening for private invites'));
        if (!ib.cards.length) out.push(el('div', 'rs-sub', st.auto === 'on' ? 'No new invites.' : 'No new invites. Listening for new ones while Rumble is open.'));
    }
    const nowS = Math.floor(Date.now() / 1000);
    for (const c of ib.cards) {
      const i = c.invite;
      const p = v.profile(i.from);
      const card = el('div', 'rs-invite');
      const who = el('div', 'rs-row');
      who.append(avatar(i.from, p?.picture, 22), el('b', undefined, clip(displayName(p, i.from), 24)), el('span', 'rs-sub', 'invited you to Blobbi Rumble'));
      card.append(who, el('div', undefined, `Room ${i.room}`), el('div', 'rs-sub', `${c.trust.host} · ${c.trust.label} · ${Math.max(1, Math.ceil((i.expiresAt - nowS) / 60))} min left`));
      if (!c.sameOrigin) card.append(el('div', 'rs-warn', `Another server: Join opens ${i.origin} (it runs that match, not this server).`));
      const acts = el('div', 'rs-row');
      acts.append(button('Join', () => a.joinInvite(i.id), 'rs-btn go'), button('Dismiss', () => a.dismissInvite(i.id)));
      card.append(acts);
      out.push(card);
    }
    return out;
  };

  /** M9A: the player's Blobbis (kind 31124 by this identity, through the kit), and a local choice among them; M9B: the form the chosen one takes here. */
  const blobbiSection = (ps: PickerState, form: RumbleForm | null, note: 'worn' | 'default' | 'refused'): Node[] => {
    const out: Node[] = [el('h4', undefined, 'My Blobbis')];
    const stageWord = { egg: 'Egg', baby: 'Baby', adult: 'Adult' } as const;
    switch (ps.phase) {
      case 'idle':
      case 'loading':
        out.push(el('div', 'rs-sub', 'Looking for your Blobbis…'));
        return out;
      case 'unreachable': {
        // Nothing answered: nothing is concluded, and the choice is kept.
        out.push(el('div', 'rs-warn', ps.selected ? 'Your selected Blobbi couldn’t be loaded right now (the Blobbi relay didn’t answer). Your selection is saved; the default fighter plays meanwhile.' : 'The Blobbi relay didn’t answer, so your Blobbis couldn’t be listed right now.'));
        const r = el('div', 'rs-row');
        r.append(button('Try again', a.reloadBlobbis));
        if (ps.selected) r.append(button('Use the default fighter', a.defaultBlobbi));
        out.push(r);
        return out;
      }
      case 'none': {
        out.push(el('div', 'rs-sub', ps.missing ? 'Your selected Blobbi couldn’t be loaded right now: the relay answered without it. Your selection is saved; the default fighter plays meanwhile.' : 'No Blobbis found for this identity. Rumble uses its default fighter.'));
        const r = el('div', 'rs-row');
        r.append(button(ps.missing ? 'Try again' : 'Look again', a.reloadBlobbis));
        if (ps.selected) r.append(button('Use the default fighter', a.defaultBlobbi));
        out.push(r);
        return out;
      }
    }
    if (ps.missing) out.push(el('div', 'rs-warn', 'Your selected Blobbi couldn’t be loaded right now: the relay answered without it. Your selection is saved; the default fighter plays meanwhile. Try again, or pick another.'));
    for (const b of ps.blobbis) {
      const sel = b.d === ps.selected;
      const row = el('div', `rs-blobbi${sel ? ' sel' : ''}`);
      const pic = el('div', 'pic');
      const url = ps.previews[b.d];
      if (url) {
        const img = el('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = url;
        pic.append(img);
      } else {
        const dot = el('span');
        dot.style.background = b.visual.baseColor;
        pic.append(dot);
      }
      const who = el('div', 'who');
      who.append(el('b', undefined, clip(b.name, 22)));
      const words = [stageWord[b.stage], b.generation.toUpperCase()];
      if (b.unsupported) words.push('newer than this Rumble understands');
      else if (sel) words.push('Rumble Form · Temporary');
      who.append(el('span', 'rs-sub', words.join(' · ')));
      row.append(pic, who);
      if (sel) row.append(el('span', 'rs-ok', 'Selected'));
      else if (!b.unsupported) row.append(button('Use this Blobbi', () => a.selectBlobbi(b.d)));
      out.push(row);
    }
    // The chosen Blobbi's form here: what it is, and why it looks as it does (Blobbi identity ≠ Blobbi form).
    if (ps.selected && form) {
      if (form.derivation === 'legacy') out.push(el('div', 'rs-sub', `Temporary Rumble Form. Blobbis are formless creatures! Your Blobbi has temporarily taken on a new form to play in Rumble${form.ownColors ? ', in its own colours' : ''}. Its original appearance remains unchanged.`));
      else if (form.derivation === 'adult-stage') out.push(el('div', 'rs-sub', 'Your Blobbi is temporarily taking an adult form to play. Its actual life stage is unchanged.'));
      if (note === 'refused') out.push(el('div', 'rs-warn', 'This form couldn’t be built here, so your fighter keeps the default look.'));
      else out.push(el('div', 'rs-sub', note === 'worn' ? 'Your fighter wears this form now. Only you see it for the moment; other players still see the default.' : 'Your fighter takes this form as soon as the match is on screen.'));
    } else if (ps.selected && !form && !ps.missing) out.push(el('div', 'rs-warn', 'This Blobbi has no Rumble form here, so your fighter keeps the default look.'));
    const r = el('div', 'rs-row');
    if (ps.missing) r.append(button('Try again', a.reloadBlobbis));
    if (ps.selected) r.append(button('Use the default fighter', a.defaultBlobbi));
    else r.append(el('span', 'rs-sub', 'Using the default fighter.'));
    out.push(r);
    out.push(el('div', 'rs-sub', 'Your choice stays in this browser, for this identity. Nothing is published, and your Blobbi itself is unchanged.'));
    return out;
  };

  const renderPanel = (v: ShellView) => {
    const parts: Node[] = [];
    // Room.
    parts.push(el('h4', undefined, 'Room'));
    if (v.room && v.room.kind === 'private') {
      parts.push(el('div', 'rs-code', v.room.id));
      if (v.share) {
        const row = el('div', 'rs-row');
        const link = el('input', 'rs-link');
        link.readOnly = true;
        link.value = v.share;
        link.addEventListener('focus', () => {
          link.select();
          a.releaseKeys();
        });
        const hint = el('div', 'rs-sub', 'Anyone with the link or the code joins this room.');
        // Copied by hand (the shortcut, or the context menu): say so, and give the keyboard back to the game.
        link.addEventListener('copy', () => {
          toast('Link copied');
          setTimeout(() => link.blur(), 0);
        });
        link.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || e.key === 'Enter') link.blur();
        });
        /** Where one-click copy is impossible (plain http on a LAN) or refused: select the link and say which keys copy it. */
        const selectForCopy = () => {
          link.focus();
          link.select();
          hint.textContent = `Link selected: press ${copyShortcut()} to copy it.${canCopy() ? '' : ' (One-click copy needs https or localhost.)'}`;
        };
        row.append(
          link,
          canCopy()
            ? button('Copy link', async () => ((await copyText(v.share!)) === 'copied' ? toast('Link copied') : selectForCopy()), 'rs-btn go')
            : button('Select link', selectForCopy, 'rs-btn go'),
        );
        parts.push(row, hint);
      }
      parts.push(el('div', 'rs-row'));
      (parts.at(-1) as HTMLElement).append(button('Back to the open room', a.openRoom), button('Host a new game', a.hostGame));
      parts.push(...inviteSection(v));
    } else {
      parts.push(el('div', 'rs-sub', 'The open room: anyone who opens this server plays here, with bots in the empty slots.'));
      parts.push(el('div', 'rs-row'));
      (parts.at(-1) as HTMLElement).append(button('Host a game', a.hostGame, 'rs-btn go'));
    }
    const err = el('div', 'rs-err');
    parts.push(el('div', 'rs-sub', 'Join a game by its code:'), joinRow(err), err);
    // Players.
    parts.push(el('h4', undefined, 'Players'));
    const list = el('div', 'rs-players');
    for (const [slot, id] of Object.entries(v.roster ?? {})) {
      const mine = slot === v.you;
      let name: string;
      let pic: HTMLElement;
      let tag = mine ? 'you' : '';
      if (id.who === 'nostr') {
        const p = v.profile(id.pubkey);
        name = clip(displayName(p, id.pubkey), 22);
        pic = avatar(id.pubkey, p?.picture, 18);
        tag = mine ? 'you · nostr' : 'nostr';
      } else {
        name = id.who === 'bot' ? 'Bot' : 'Guest';
        pic = avatar(null, undefined, 18);
      }
      list.append(el('span', 'slot', slot), pic, el('span', 'nm', name), el('span', 'rs-sub', tag));
    }
    parts.push(list);
    if (v.spectators) parts.push(el('div', 'rs-sub', `${v.spectators} watching`));
    // Identity.
    parts.push(el('h4', undefined, 'You'));
    const s = v.identity;
    const own = s.pubkey ? v.profile(s.pubkey) : undefined;
    const row = el('div', 'rs-row');
    if (s.phase === 'verified' && s.pubkey) {
      const who = el('span');
      who.append(el('div', undefined, clip(displayName(own, s.pubkey), 28)), el('div', 'rs-sub', shortNpub(s.pubkey, 8, 6)));
      who.title = npubOf(s.pubkey);
      row.append(avatar(s.pubkey, own?.picture, 26), who, button('Disconnect Nostr', a.disconnectNostr));
    } else if (s.phase === 'error') {
      row.append(el('span', 'rs-err', s.error ?? 'Something went wrong.'), button('Try again', a.connectNostr, 'rs-btn go'), button('Play as guest', a.dismissIdentityError));
    } else if (s.phase === 'asking' || s.phase === 'proving' || s.phase === 'restoring') {
      row.append(el('span', 'rs-sub', s.phase === 'asking' ? 'Answer your Nostr extension’s prompt…' : s.phase === 'restoring' ? 'Restoring Nostr… (your extension may ask once)' : 'Verifying with the game server…'));
    } else if (s.phase === 'changed' && s.pubkey && s.other) {
      const o = v.profile(s.other);
      row.append(avatar(s.other, o?.picture, 22), el('span', undefined, `Your extension is signed in as ${clip(displayName(o, s.other), 20)}, not ${clip(displayName(own, s.pubkey), 20)}.`));
      parts.push(row);
      const acts = el('div', 'rs-row');
      acts.append(button(`Connect as ${clip(displayName(o, s.other), 16)}`, a.connectOtherNostr, 'rs-btn go'), button('Not now', a.dismissOtherNostr), button('Forget', a.disconnectNostr));
      parts.push(acts);
      parts.push(el('div', 'rs-sub', 'Nothing switched by itself: your saved Blobbi and invites belong to the remembered identity.'));
      parts.push(el('h4', undefined, 'Server'));
      if (v.trust) {
        parts.push(el('div', undefined, `${v.trust.label} · ${v.trust.host}`));
        parts.push(el('div', 'rs-sub', v.trust.detail));
      }
      panel.replaceChildren(...parts);
      return;
    } else if (s.phase === 'known' && s.pubkey) {
      row.append(avatar(s.pubkey, own?.picture, 22), el('span', undefined, clip(displayName(own, s.pubkey), 20)), button('Reconnect Nostr', a.connectNostr, 'rs-btn go'), button('Forget', a.disconnectNostr));
    } else {
      row.append(el('span', undefined, 'Guest'), button('Connect Nostr', a.connectNostr, 'rs-btn go'));
    }
    parts.push(row);
    if (v.blobbis && s.phase === 'verified') parts.push(...blobbiSection(v.blobbis.state, v.blobbis.form, v.blobbis.note));
    if (v.inbox) parts.push(...inboxSection(v, v.inbox));
    // Server.
    parts.push(el('h4', undefined, 'Server'));
    if (v.trust) {
      parts.push(el('div', undefined, `${v.trust.label} · ${v.trust.host}`));
      if (v.server?.name) parts.push(el('div', 'rs-sub', `Calls itself “${v.server.name}”`));
      if (v.server?.operator) {
        const p = v.profile(v.server.operator);
        parts.push(el('div', 'rs-sub', `Operator (as the server states): ${clip(displayName(p, v.server.operator), 28)}`));
      }
      parts.push(el('div', 'rs-sub', v.trust.detail));
    }
    panel.replaceChildren(...parts);
  };

  const renderStart = (v: ShellView) => {
    const parts: Node[] = [el('h3', undefined, 'BLOBBI RUMBLE'), el('p', undefined, 'You’re already in the open room, with bots in the empty slots.')];
    const err = el('div', 'rs-err');
    const joining = el('div');
    joining.style.display = 'none';
    joining.append(joinRow(err), err);
    const row = el('div');
    row.append(
      button('Play', () => a.startSeen(), 'rs-btn go'),
      button('Host a game', () => {
        a.startSeen();
        a.hostGame();
      }),
      button('Join a game', () => {
        joining.style.display = '';
        (joining.querySelector('input') as HTMLInputElement | null)?.focus();
      }),
    );
    const id = el('div', 'id');
    if (v.identity.phase === 'verified' && v.identity.pubkey) id.append(document.createTextNode(`Playing as ${clip(displayName(v.profile(v.identity.pubkey), v.identity.pubkey), 24)}`));
    else id.append(document.createTextNode('Playing as a guest · '), button('Connect Nostr', a.connectNostr));
    parts.push(row, joining, id);
    start.replaceChildren(...parts);
  };

  return {
    toast,
    openSession: () => togglePanel(true),
    get helpOpen() {
      return helpOpen;
    },
    get panelOpen() {
      return panelOpen;
    },
    show(v: ShellView) {
      const c = v.conn;
      const healthy = c.phase === 'playing' || c.phase === 'watching';
      // Session chip: room · server, and a dot for the connection (quiet when healthy).
      const roomText = v.room ? (v.room.kind === 'private' ? v.room.id : 'Open room') : c.room ?? '…';
      const sKey = JSON.stringify([c.phase, roomText, v.trust?.label]);
      if (sKey !== lastSession) {
        lastSession = sKey;
        const dot = el('span', `dot${healthy ? '' : c.phase === 'connecting' ? ' wait' : ' off'}`);
        sessionChip.replaceChildren(dot, el('b', undefined, roomText), el('span', 'dim', `· ${healthy ? (v.trust?.label ?? 'server') : c.phase === 'connecting' ? 'connecting…' : 'offline'}${c.phase === 'watching' ? ' · watching' : ''}`));
        sessionChip.title = 'Room, players, identity and server';
      }
      // Identity chip.
      const s = v.identity;
      const own = s.pubkey ? v.profile(s.pubkey) : undefined;
      const invites = v.inbox?.cards.length ?? 0;
      const iKey = JSON.stringify([s.phase, s.pubkey, s.other, own?.displayName, own?.name, own?.picture, invites]);
      if (iKey !== lastId) {
        lastId = iKey;
        if (s.phase === 'verified' && s.pubkey) idChip.replaceChildren(avatar(s.pubkey, own?.picture, 22), el('b', undefined, clip(displayName(own, s.pubkey), 18)), el('span', 'dim', 'Nostr'), ...(invites ? [el('span', 'rs-badge', `✉ ${invites}`)] : []));
        else if (s.phase === 'asking' || s.phase === 'proving') idChip.replaceChildren(el('span', 'dim', 'Nostr · check your extension…'));
        else if (s.phase === 'restoring') idChip.replaceChildren(el('span', 'dim', 'Restoring Nostr… ·'), button('Connect Nostr', a.connectNostr));
        else if (s.phase === 'changed') idChip.replaceChildren(el('span', 'dim', 'Nostr · another account'), button('Session', () => togglePanel(true)));
        else if (s.phase === 'error') idChip.replaceChildren(el('span', 'dim', 'Nostr · didn’t connect'));
        else if (s.phase === 'known' && s.pubkey) idChip.replaceChildren(avatar(s.pubkey, own?.picture, 22), el('span', 'dim', `${clip(displayName(own, s.pubkey), 14)} · `), button('Reconnect Nostr', a.connectNostr, 'rs-btn go'));
        else idChip.replaceChildren(el('span', 'dim', 'Guest ·'), button('Connect Nostr', a.connectNostr, 'rs-btn go'));
      }
      // Scoreboard.
      const snap = v.snapshot;
      const bKey = snap ? JSON.stringify([snap.round, v.you, snap.fighters.map((f) => [f.id, f.score, f.eliminated, f.powerLevel, label(v, f.id)])]) : '';
      if (bKey !== lastBoard) {
        lastBoard = bKey;
        if (!snap) board.replaceChildren();
        else {
          const items: Node[] = [el('span', 'round', `R${snap.round} · to ${ROUND.target}`)];
          for (const f of snap.fighters) {
            const p = el('div', `rs-pl${f.id === v.you ? ' me' : ''}${f.eliminated ? ' out' : ''}`);
            p.append(el('span', 'nm', clip(label(v, f.id), 12)), el('span', 'sc', `${'●'.repeat(f.score)}${'○'.repeat(Math.max(0, ROUND.target - f.score))}`));
            if (f.powerLevel > 0) p.append(el('span', 'pw', `⚡${f.powerLevel}`));
            p.title = f.id;
            items.push(p);
          }
          board.replaceChildren(...items);
        }
      }
      board.style.display = snap && healthy ? '' : 'none';
      // The contextual message, with names for slot ids.
      const m = v.message ? v.message.replace(/\bP[1-4]\b/g, (id) => clip(label(v, id), 16)) : '';
      if (m !== lastMsg) {
        lastMsg = m;
        msg.textContent = m;
        msg.style.display = m ? 'block' : 'none';
      }
      // Your struggle.
      const me = snap && v.you ? snap.fighters.find((f) => f.id === v.you) : undefined;
      const held = me?.heldBy && !me.eliminated ? me : undefined;
      const stKey = held ? `${held.heldBy}|${Math.round(held.combat.struggle * 20)}` : '';
      if (stKey !== lastStruggle) {
        lastStruggle = stKey;
        if (held) {
          const bar = el('div', 'bar');
          const fill = el('i');
          fill.style.width = `${Math.round(held.combat.struggle * 100)}%`;
          bar.appendChild(fill);
          struggle.replaceChildren(el('div', undefined, `Grabbed by ${clip(label(v, held.heldBy!), 14)}! Alternate ← → (A D) fast`), bar);
        }
        struggle.style.display = held ? 'block' : 'none';
      }
      // The session panel, while open.
      if (panelOpen) {
        const inviteWho = v.invite.status && 'pubkey' in v.invite.status ? v.profile(v.invite.status.pubkey) ?? null : null;
        const inboxKey = v.inbox ? [v.inbox.setup, v.inbox.state, v.inbox.offer, v.inbox.cards.map((c) => [c.invite.id, c.trust.label, v.profile(c.invite.from) ?? null, Math.ceil((c.invite.expiresAt - Date.now() / 1000) / 60)])] : null;
        const pKey = JSON.stringify([inboxKey, v.blobbis, v.invite, inviteWho, v.room, v.share, v.roster, v.spectators, v.you, s, v.trust, v.server, Object.values(v.roster ?? {}).map((x) => (x.who === 'nostr' ? v.profile(x.pubkey) ?? null : null)), own, v.server?.operator ? v.profile(v.server.operator) ?? null : null]);
        // Never rebuild under someone typing a code.
        if (pKey !== lastPanel && !panel.contains(document.activeElement)) {
          lastPanel = pKey;
          renderPanel(v);
        }
      }
      // The people part of the invite section (M8C-C): refreshed on its own, so typing never loses results or focus.
      if (panelOpen && v.people) {
        const pplKey = JSON.stringify([v.people, v.invite, v.invite.status && 'pubkey' in v.invite.status ? v.profile(v.invite.status.pubkey) ?? null : null, [...v.people.follows.rows, ...v.people.search.rows, ...(v.people.selected ? [v.people.selected] : [])].map((r) => v.profile(r.pubkey) ?? null)]);
        if (pplKey !== lastPeople) {
          lastPeople = pplKey;
          renderPeople(v);
        }
      }
      // The start card (first visit, open room).
      const showStart = v.startCard && healthy;
      const stK = showStart ? JSON.stringify([s.phase, s.pubkey, own?.displayName]) : '';
      if (stK !== lastStart && !start.contains(document.activeElement)) {
        lastStart = stK;
        start.style.display = showStart ? 'block' : 'none';
        if (showStart) renderStart(v);
      }
      // The automatic-invites question (M8C-B.2): a corner card while unanswered, unless the panel (which asks it too) is open.
      const showConsent = !!v.inbox?.offer && healthy && !showStart && !panelOpen;
      if (showConsent !== lastConsent) {
        lastConsent = showConsent;
        consent.style.display = showConsent ? 'block' : 'none';
        if (showConsent) consent.replaceChildren(...consentNodes());
      }
      // The banner: loud, only when play is impossible.
      const d = describe(c, v.now);
      const bnKey = d ? JSON.stringify(d) : '';
      if (bnKey !== lastBanner) {
        lastBanner = bnKey;
        banner.style.display = d ? 'flex' : 'none';
        if (d) {
          const acts: Record<BannerAction, () => HTMLButtonElement> = {
            retry: () => button(c.phase === 'refused' ? 'Try again' : 'Retry now', a.retry, 'rs-btn go'),
            open: () => button('Play in the open room', a.openRoom, c.phase === 'missing' ? 'rs-btn go' : 'rs-btn'),
            host: () => button('Host a new game', a.hostGame),
          };
          bannerBox.replaceChildren(el('h2', undefined, d.title), el('p', undefined, d.detail), ...d.actions.map((k) => acts[k]()));
        }
      }
    },
  };
}
