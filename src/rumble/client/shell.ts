/**
 * THE GAME'S INTERFACE in network mode: the world first, the rest small and
 * contextual (L4.2).
 *
 *   ┌ place pill ─┬ room bar ──────┐   ┌ scoreboard ┐   ┌ you ──┬ ⚙ ┐
 *   🔑 A7F2 2/4 1/2 ready  [Ready] ✉     (a match on)     (Blobbi) Ada
 *
 *                      contextual message (round, match)
 *                      struggle bar (when you are held)
 *
 *   where you are (`hud.ts`) decides what shows: the menu; the public plaza
 *   (its name, how many are there); a room between matches (its counts,
 *   Ready, the owner's Start, Invite); a match (the scoreboard); away (the
 *   banner, with the way out).
 *
 *   on demand, one SHEET at a time (Escape, ✕ or a press outside closes it):
 *     the place pill   the plaza's menu, or a room's players / settings /
 *                      invite / leave, or Quick Match's players / leave
 *     you              your name, your Blobbi (the picker), Nostr, invites
 *     ⚙                graphics, counter, camera, full screen, help, servers
 *   loud:       the centred banner when play is impossible (offline, a
 *               missing room, a full plaza, …), with what to do about it
 *   debug:      F3 / F4 (the text HUD), unchanged, off by default
 *
 * Everything from Nostr or a server is text set with textContent. A click
 * never leaves a button focused; the keyboard reaches every control (Tab),
 * and fields own the keyboard while focused (the game's keys are released).
 */
import { ROUND } from '../tuning';
import type { RoomInfo, ServerInfo, SlotIdentity } from '../net/protocol';
import type { ServerTrust } from '../net/serverTrust';
import type { MatchSnapshot } from '../sim/snapshot';
import { npubOf, shortNpub } from '../../social/keys';
import { clip, displayName, type Profile } from '../../social/profile';
import { describe, type BannerAction, type ConnectionState } from './connection';
import { canCopy, copyShortcut, copyText } from './clipboard';
import { avatar, button, el, focusAfterClose, isTyping } from './dom';
import type { IdentityState } from './identity';
import type { InviteStatus } from './inviteSender';
import type { InboxState } from './inviteInbox';
import type { PeopleState, PersonRow } from './people';
import type { GameServer } from './servers';
import { ARENAS, arenaById } from '../arena/arenas';
import type { RoomListing } from '../net/protocol';
import type { PickerState } from './blobbis';
import type { RumbleForm } from './rumbleForm';
import type { SetupState } from './inboxSetup';
import type { ReceivedInvite } from './invites';
import { QUALITY_CHOICES, type QualityChoice } from '../view/quality';
import { fullscreenNote, fullscreenState, isStandalone, toggleFullscreen } from './fullscreen';
import type { LobbyMessage } from '../net/protocol';
import { lobbyView } from './lobbyView';
import { LOBBY_CSS, createLobbyUi } from './lobbyUi';
import { lookPreview } from './blobbiPreview';
import { PLAZA_CSS, createPlazaUi } from './plazaUi';
import { THEME_CSS } from './uiTheme';
import { hudView, type HudView } from './hud';
import { rosterSeats, type LobbyView } from './lobbyView';
import type { RoomTab } from './lobbyUi';
import type { RumbleLook } from './rumbleForm';

/** L4.2: the sheets, one open at a time. */
type SheetKind = 'place' | 'profile' | 'settings';
import { isSocialSpace } from '../arena/lobbySpace';
import { seedFromLabel } from '../../playground/seeds';
import { ROSTER } from '../roster';

export interface ShellActions {
  retry(): void;
  openRoom(): void;
  /** Host a new game: listed in this server's public rooms, or reached by its code and link only; on an arena (M11A), rotating or not. */
  hostGame(listed: boolean, arena?: string, rotate?: boolean): void;
  /** M10A: servers. */
  useServer(id: string): void;
  addServer(input: { name?: string; url: string; region?: string; operator?: string }): string | null;
  removeServer(id: string): void;
  /** M10B: list the public rooms now. */
  refreshRooms(): void;
  joinGame(code: string): void;
  connectNostr(): void;
  disconnectNostr(): void;
  /** M9B.1: the extension holds another identity than the remembered one; connect it only on this click, or keep the hint without reconnecting. */
  connectOtherNostr(): void;
  dismissOtherNostr(): void;
  dismissIdentityError(): void;
  /** The code field took the keyboard: let go of every game key. */
  releaseKeys(): void;
  /** L4.1: the menu's and the plaza card's ways: the public plaza, Quick Match (the open room), back to the menu. */
  enterPlaza(): void;
  quickMatch(): void;
  toMenu(): void;
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
  /** M12: the graphics choice (saved on this device). */
  setQuality(choice: QualityChoice): void;
  /** M12: the player chose to play on in portrait (the rotate hint goes for this visit). */
  dismissRotate(): void;
  /** M12.1: show or hide the FPS counter (saved on this device). */
  setFps(on: boolean): void;
  /** M12.1: the touch camera back to the arena's own view. */
  recenterCamera(): void;
  /** L3: lobby requests (the server decides): this person ready or not; the owner's start and settings. */
  lobbyReady(on: boolean): void;
  lobbyStart(): void;
  lobbySettings(change: { bots?: boolean; arena?: string; rotate?: boolean }): void;
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
  /** M10: the game servers this page knows and uses, and the current server's public rooms. */
  servers: { current: GameServer; known: GameServer[]; linkError: string | null; rooms: RoomListing[] | null; roomsSupported: boolean };
  identity: IdentityState;
  /** Development only: the Nostr connection lifecycle, stage by stage (null: off). */
  diag: string[] | null;
  profile: (pubkey: string) => Profile | null | undefined;
  roster: Record<string, SlotIdentity> | null;
  spectators: number;
  you: string | null;
  snapshot: MatchSnapshot | null;
  /** The presenter's current message (slot ids in it are replaced by names). */
  message: string;
  /** A proven person's name for a slot, or null. */
  nameOf: (slot: string) => string | null;
  /** M9D: the Blobbi a slot's fighter wears, by name, or null. */
  blobbiNameOf: (slot: string) => string | null;
  /** L4.1: the menu is up (nothing is connected). */
  menu: boolean;
  /** L4.1: on the public plaza: how many are there, how many it holds, the Blobbi this player wears (null: not on the plaza). */
  plaza: { here: number; capacity: number; blobbi: string | null } | null;
  invite: { mode: InviteMode; status: InviteStatus | null; busy: boolean };
  /** M8C-C: the people finder of the connected identity (null: none, or not a private room). */
  people: PeopleState | null;
  /** M9A: the connected identity's Blobbis and its local choice (null: no verified identity); M9B: the form the chosen one takes here, and whether the fighter wears it. */
  blobbis: { state: PickerState; form: RumbleForm | null; note: 'worn' | 'default' | 'refused'; shared: boolean } | null;
  /** M8C-B: the invite inbox of the connected identity (null: no identity connected in this page); `offer`: ask about automatic checking now (M8C-B.2). */
  inbox: { state: InboxState; cards: InviteCard[]; setup: SetupState | null; offer: boolean } | null;
  /** M12: the graphics choice, and what the renderer does with it now (read live, outside the panel's rebuild). */
  graphics: { choice: QualityChoice; info: () => { level: string; ratio: number; width: number; height: number; fps: number; shadowMap: number } | null };
  /** M12: ask to turn the phone (portrait on a touch phone). */
  rotate: boolean;
  /** M12.1: the FPS counter is on. */
  fps: boolean;
  /** L3: a lobby room's lifecycle as last heard (null: a continuous room), and the newest state's tick and the rate (for seconds left). */
  lobby: LobbyMessage | null;
  tick: number;
  tickHz: number;
}

const CSS = `
  .rs-top { position: fixed; top: calc(var(--rs-safe-t) + 10px); left: calc(var(--rs-safe-l) + 10px); right: calc(var(--rs-safe-r) + 10px); display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; pointer-events: none; z-index: 7; font-size: 13px; }
  .rs-top > * { pointer-events: auto; }
  .rs-left, .rs-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .rs-right { flex: none; }
  .rs-left:empty { display: none; }
  .rs-place { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 12px; border: none; border-radius: 999px; cursor: pointer; font: 700 13px var(--rs-font); color: var(--rs-ink); white-space: nowrap; min-width: 0; max-width: 46vw; }
  .rs-place .ic { font-size: 16px; line-height: 1; }
  .rs-place b { font-weight: 800; letter-spacing: 0.02em; overflow: hidden; text-overflow: ellipsis; }
  .rs-place .cnt { padding: 2px 8px; border-radius: 999px; background: var(--rs-wash); color: var(--rs-sub); font-size: 12px; }
  .rs-place .cnt.ok { background: var(--rs-mint-soft); color: var(--rs-mint-ink); }
  .rs-place .car { color: var(--rs-faint); font-size: 11px; }
  .rs-place[aria-expanded="true"] { box-shadow: 0 0 0 2.5px var(--rs-lilac), var(--rs-shadow-sm); }
  .rs-place .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--rs-sun); }
  .rs-me { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px 0 4px; border: none; border-radius: 999px; cursor: pointer; font: 700 13px var(--rs-font); color: var(--rs-ink); max-width: 30vw; }
  .rs-me .pic { flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--rs-lilac-soft); overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .rs-me .pic img { width: 120%; height: 120%; object-fit: contain; }
  .rs-me .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-me[aria-expanded="true"], .rs-gear[aria-expanded="true"] { box-shadow: 0 0 0 2.5px var(--rs-lilac), var(--rs-shadow-sm); }
  .rs-gear { width: 38px; min-width: 38px; height: 38px; min-height: 38px; border: none; font-size: 17px; }
  .rs-badge { display: inline-block; min-width: 18px; padding: 1px 6px; border-radius: 999px; background: #e0608e; color: #fff; font: 800 11px var(--rs-font); text-align: center; }
  .rs-board { display: flex; gap: 4px; padding: 4px; border-radius: 16px; min-width: 0; }
  .rs-board .round { align-self: center; padding: 0 6px; font: 800 11px var(--rs-font); color: var(--rs-sub); white-space: nowrap; }
  .rs-pl { display: flex; flex-direction: column; align-items: center; min-width: 64px; max-width: 118px; padding: 3px 8px; border-radius: 12px; background: rgba(255,255,255,0.8); }
  .rs-pl.me { box-shadow: inset 0 0 0 2px var(--rs-lilac); }
  .rs-pl.out { opacity: 0.45; }
  .rs-pl .nm { font-weight: 700; font-size: 12px; max-width: 102px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-pl .sc { font-size: 10px; letter-spacing: 2px; color: #d4709a; }
  .rs-pl .pw { font-size: 10px; color: var(--rs-sun-ink); }
  .rs-msg { position: fixed; left: 50%; top: 22vh; transform: translateX(-50%); max-width: 80vw; padding: 8px 18px; border-radius: 16px; background: rgba(42,41,68,0.74); color: #fff; font: 800 20px var(--rs-font); letter-spacing: 0.02em; text-align: center; pointer-events: none; display: none; z-index: 4; }
  .rs-struggle { position: fixed; left: 50%; bottom: 14vh; transform: translateX(-50%); padding: 8px 14px; border-radius: 16px; background: rgba(160,52,72,0.9); color: #fff; font: 800 14px var(--rs-font); text-align: center; pointer-events: none; display: none; z-index: 4; }
  .rs-struggle .bar { margin-top: 6px; height: 8px; width: 220px; border-radius: 4px; background: rgba(255,255,255,0.3); overflow: hidden; }
  .rs-struggle .bar > i { display: block; height: 100%; background: #fff; }
  .rs-corner { position: fixed; left: calc(var(--rs-safe-l) + 10px); bottom: calc(var(--rs-safe-b) + 10px); z-index: 5; }
  .rs-hint { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 3px 10px; border: none; border-radius: 999px; font: 600 12px var(--rs-font); color: var(--rs-sub); cursor: pointer; }
  body.rs-touch .rs-corner { display: none; }
  .rs-fps { position: fixed; left: 50%; bottom: calc(var(--rs-safe-b) + 4px); transform: translateX(-50%); padding: 1px 8px; border-radius: 8px; background: rgba(42,41,68,0.6); color: #fff; font: 11px ui-monospace, Menlo, monospace; pointer-events: none; z-index: 5; display: none; }
  .rs-hint kbd, .rs-help kbd { display: inline-block; padding: 0 6px; border-radius: 6px; background: var(--rs-wash); border: 1px solid var(--rs-line); font: 11px ui-monospace, Menlo, monospace; color: var(--rs-ink); }
  .rs-sheet.rs-card { z-index: 8; }
  .rs-sheet .x { flex: none; }
  .rs-code { font: 800 30px ui-monospace, Menlo, monospace; letter-spacing: 0.16em; text-align: center; padding: 8px 0 4px; }
  .rs-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .rs-link { flex: 1; min-width: 0; min-height: 34px; font: 12px ui-monospace, Menlo, monospace; padding: 4px 8px; border: 1.5px solid var(--rs-line); border-radius: var(--rs-r-sm); background: var(--rs-wash); color: var(--rs-ink); }
  .rs-link:focus { border-color: var(--rs-lilac); outline: none; }
  select.rs-link { font: 600 13px var(--rs-font); }
  .rs-err { color: var(--rs-red-ink); font-size: 12px; }
  .rs-err:empty { display: none; }
  .rs-ok { color: var(--rs-mint-ink); font-size: 12px; font-weight: 700; }
  .rs-warn { color: var(--rs-sun-ink); font-size: 12px; }
  .rs-sub { color: var(--rs-sub); font-size: 12px; }
  .rs-invite { margin: 6px 0; padding: 8px 10px; border-radius: var(--rs-r-md); background: var(--rs-mint-soft); }
  .rs-person { display: flex; align-items: center; gap: 8px; width: 100%; margin: 2px 0; padding: 5px 8px; border: 1.5px solid transparent; border-radius: var(--rs-r-md); background: none; text-align: left; font: 13px var(--rs-font); color: var(--rs-ink); cursor: pointer; }
  .rs-person:hover { background: var(--rs-wash); }
  .rs-person.sel { border-color: var(--rs-line); background: var(--rs-mint-soft); cursor: default; }
  .rs-person .who { display: flex; flex-direction: column; min-width: 0; }
  .rs-person .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-person .tag { margin-left: auto; flex: none; font-size: 11px; color: var(--rs-sub); }
  .rs-people h5 { margin: 10px 0 2px; font: 800 11px var(--rs-font); letter-spacing: 0.06em; text-transform: uppercase; color: var(--rs-faint); }
  .rs-blobbi { display: flex; align-items: center; gap: 8px; margin: 3px 0; padding: 5px 8px; border: 1.5px solid transparent; border-radius: var(--rs-r-md); }
  .rs-blobbi.sel { border-color: var(--rs-mint-edge); background: var(--rs-mint-soft); }
  .rs-blobbi .pic { flex: none; width: 38px; height: 38px; border-radius: 12px; background: var(--rs-wash); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .rs-blobbi .pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .rs-blobbi .pic span { width: 18px; height: 18px; border-radius: 50%; }
  .rs-blobbi .who { display: flex; flex-direction: column; min-width: 0; }
  .rs-blobbi .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-blobbi .rs-btn { margin-left: auto; flex: none; }
  .rs-avatar { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; background: var(--rs-wash); }
  .rs-avatar img, .rs-avatar svg { width: 100%; height: 100%; object-fit: cover; display: block; }
  .rs-idcard { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--rs-r-md); background: var(--rs-wash); }
  .rs-idcard .pic { flex: none; width: 52px; height: 52px; border-radius: 16px; background: var(--rs-lilac-soft); overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .rs-idcard .pic img { width: 100%; height: 100%; object-fit: contain; }
  .rs-idcard .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .rs-idcard .who b { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-help { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100vw - 20px)); max-height: calc(100dvh - 20px); overflow: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 16px 20px; display: none; line-height: 1.8; z-index: 9; }
  .rs-help h3 { margin: 0 0 6px; font: 800 17px var(--rs-font); }
  .rs-help .x { position: absolute; right: 10px; top: 10px; }
  .rs-consent { right: calc(var(--rs-safe-r) + 10px); bottom: calc(var(--rs-safe-b) + 10px); width: min(340px, calc(100vw - 20px)); padding: 12px 14px; display: none; }
  .rs-toasts { position: fixed; left: 50%; top: calc(var(--rs-safe-t) + 60px); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; z-index: 11; }
  .rs-toast { padding: 6px 14px; border-radius: 999px; background: rgba(42,41,68,0.86); color: #fff; font: 600 12px var(--rs-font); box-shadow: var(--rs-shadow-sm); }
  .rs-banner { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(226,232,250,0.6); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); z-index: 9; }
  .rs-banner > div { width: min(440px, 100%); max-height: calc(100dvh - 32px); overflow: auto; padding: 20px 22px 18px; border-radius: var(--rs-r); background: var(--rs-card); box-shadow: var(--rs-shadow); font-size: 14px; text-align: center; }
  .rs-banner .ic { font-size: 34px; line-height: 1; margin-bottom: 6px; }
  .rs-banner .spin { width: 34px; height: 34px; margin: 0 auto 10px; border-radius: 50%; border: 4px solid var(--rs-lilac-soft); border-top-color: var(--rs-lilac); animation: rs-spin 0.9s linear infinite; }
  @keyframes rs-spin { to { transform: rotate(360deg); } }
  .rs-banner h2 { margin: 0 0 6px; font: 800 19px var(--rs-font); }
  .rs-banner p { margin: 0 0 14px; color: var(--rs-sub); word-break: break-word; }
  .rs-banner .acts { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
  .rs-banner.quiet { background: rgba(226,232,250,0.35); }
  #hud { top: 60px !important; max-height: calc(100vh - 70px); overflow: auto; }
  .rs-rotate { position: fixed; inset: 0; z-index: 12; display: none; align-items: center; justify-content: center; padding: 24px; background: rgba(226,232,250,0.94); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); text-align: center; font: 15px var(--rs-font); color: var(--rs-ink); }
  .rs-rotate .ph { width: 44px; height: 72px; margin: 0 auto 14px; border: 4px solid var(--rs-ink); border-radius: 10px; animation: rs-turn 2.2s ease-in-out infinite; }
  .rs-rotate h2 { margin: 0 0 6px; font: 800 20px var(--rs-font); }
  .rs-rotate p { margin: 0 0 14px; color: var(--rs-sub); }
  @keyframes rs-turn { 0%, 30% { transform: rotate(0); } 60%, 100% { transform: rotate(-90deg); } }
  @media (prefers-reduced-motion: reduce) { .rs-rotate .ph, .rs-banner .spin { animation: none; } }
  .rs-quality { display: inline-flex; padding: 3px; gap: 2px; border-radius: var(--rs-r-md); background: var(--rs-wash); }
  .rs-quality .rs-btn { border: none; background: none; min-height: 30px; padding: 4px 11px; color: var(--rs-sub); }
  .rs-quality .rs-btn.go { background: #fff; color: var(--rs-ink); box-shadow: var(--rs-shadow-sm); }
  /* Narrower screens: the scoreboard takes its own row under the corners. */
  @media (max-width: 860px) and (min-height: 521px) {
    .rs-top { flex-wrap: wrap; }
    .rs-board { order: 3; flex-basis: 100%; justify-content: center; flex-wrap: wrap; background: none !important; box-shadow: none !important; padding: 0; -webkit-backdrop-filter: none; backdrop-filter: none; }
    .rs-pl { min-width: 54px; }
  }
  @media (pointer: coarse) {
    .rs-card input, .rs-card select, .rs-card textarea { font-size: 16px !important; }
    .rs-person, .rs-blobbi { min-height: 44px; }
    .rs-place, .rs-me, .rs-gear { height: 40px; min-height: 40px; }
    .rs-gear { width: 40px; min-width: 40px; }
  }
  /* Touch play: no pull-to-refresh or rubber-banding of the page; cards scroll and zoom as any page. */
  body.rs-touch { overscroll-behavior: none; -webkit-user-select: none; user-select: none; }
  body.rs-touch .rs-card input, body.rs-touch .rs-card textarea, body.rs-touch .rs-link, body.rs-touch .rs-code { -webkit-user-select: text; user-select: text; }
  body.rs-touch .rs-fps { left: calc(var(--rs-safe-l) + 10px); top: calc(var(--rs-safe-t) + 56px); bottom: auto; transform: none; }
  body.rs-touch .rs-struggle { display: none !important; }
  body.rs-touch .rs-consent { right: auto; bottom: auto; left: 50%; top: calc(var(--rs-safe-t) + 56px); transform: translateX(-50%); }
  /* A phone on its side: one slim top row; the board shrinks into it; everything clear of the stick and the buttons below. */
  @media (max-height: 520px) {
    .rs-top { top: calc(var(--rs-safe-t) + 6px); gap: 6px; }
    .rs-place, .rs-me { height: 38px; min-height: 38px; padding: 0 10px; gap: 6px; font-size: 12px; }
    .rs-me { padding-left: 4px; }
    .rs-gear { height: 38px; min-height: 38px; width: 38px; min-width: 38px; }
    .rs-place { max-width: 34vw; }
    .rs-board { flex-wrap: nowrap; padding: 2px; gap: 2px; overflow: hidden; flex-shrink: 1; }
    .rs-board .round { padding: 0 4px; font-size: 10px; }
    .rs-pl { min-width: 0; max-width: 84px; padding: 1px 6px; flex-direction: row; gap: 4px; flex-shrink: 0; }
    .rs-pl .nm { font-size: 11px; max-width: 54px; flex-shrink: 0; }
    .rs-pl .sc { letter-spacing: 0; }
    .rs-msg { top: 20vh; font-size: 16px; padding: 6px 14px; }
    .rs-help { line-height: 1.5; padding: 12px 16px; }
    .rs-toasts { top: calc(var(--rs-safe-t) + 52px); }
    .rs-banner > div { padding: 14px 18px 12px; }
    .rs-banner .ic { font-size: 26px; margin-bottom: 2px; }
    .rs-banner p { margin-bottom: 10px; }
    #hud { top: 52px !important; }
    body.rs-touch .rs-fps { top: calc(var(--rs-safe-t) + 50px); }
    body.rs-touch .rs-consent { top: calc(var(--rs-safe-t) + 52px); }
    .rs-cue { bottom: calc(var(--rs-safe-b) + 8px) !important; font-size: 12px !important; max-width: 46vw; }
    .rs-cue > div { padding: 5px 10px !important; }
  }
  /* A small phone on its side: the pill keeps the place, the profile only its picture, the board only the names. */
  @media (max-height: 520px) and (max-width: 760px) {
    .rs-me .nm, .rs-board .round, .rs-place .car { display: none; }
    .rs-me { padding-right: 4px; }
  }
  body.rs-touch .rs-cue { max-width: 46vw; text-align: center; }
`;

const HELP: [string, string][] = [
  ['WASD / ← ↑ ↓ →', 'move'],
  ['Shift', 'run'],
  ['Space / Enter', 'jump'],
  ['F / K', 'punch'],
  ['G / L', 'grab, then again to throw'],
  ['← → (A D) fast', 'break free when grabbed'],
  ['step or run off an edge', 'on your feet, you catch the ledge (Skyfall, Factory); knocked down or thrown, you fall'],
  ['Space / Enter · G / L', 'hanging: climb up · let go (or hold away from the wall); the bar over you is your grip'],
  ['out of the round', 'WASD aims a banana peel, F or G throws it (3 a round, while 3+ still play)'],
];

/** M12: the same help for touch players. */
const TOUCH_HELP: [string, string][] = [
  ['stick (left thumb)', 'move · push to the rim to run'],
  ['Jump', 'jump'],
  ['Punch', 'punch'],
  ['Grab', 'grab, then Throw (the same button)'],
  ['Break free', 'tap fast when grabbed (or wiggle the stick ← →)'],
  ['step or run off an edge', 'on your feet, you catch the ledge; knocked down or thrown, you fall'],
  ['hanging on a ledge', 'Climb (jump) · Let go (grab); the bar over you is your grip'],
  ['out of the round', 'the stick aims a banana peel, Throw throws it (3 a round, while 3+ still play)'],
];

/** L4.2: the actions that take the player somewhere else: the open sheet closes first (it belonged to the place left). */
const MOVES = ['enterPlaza', 'quickMatch', 'hostGame', 'joinGame', 'toMenu', 'openRoom', 'joinInvite', 'useServer'] as const;

export function createShell(actions: ShellActions) {
  const a: ShellActions = { ...actions };
  for (const k of MOVES) {
    const f = actions[k] as (...x: unknown[]) => void;
    (a as unknown as Record<string, (...x: unknown[]) => void>)[k] = (...x) => {
      closeSheet();
      f(...x);
    };
  }
  const style = el('style');
  style.textContent = THEME_CSS + CSS + LOBBY_CSS + PLAZA_CSS;
  document.head.appendChild(style);
  const defaultLook = (seat: string): RumbleLook => ({ seed: seedFromLabel(ROSTER.find((e) => e.label === seat)?.identity ?? seat), algorithm: 1 });

  // Top bar: where you are (left), the scoreboard (middle, in a match), you and the settings (right).
  const top = el('div', 'rs-top');
  const left = el('div', 'rs-left');
  const place = el('button', 'rs-place rs-glass');
  place.type = 'button';
  place.setAttribute('aria-haspopup', 'dialog');
  place.setAttribute('aria-expanded', 'false');
  place.addEventListener('mousedown', (e) => e.preventDefault());
  const board = el('div', 'rs-board rs-glass');
  board.setAttribute('aria-label', 'Scoreboard');
  const right = el('div', 'rs-right');
  const me = el('button', 'rs-me rs-glass');
  me.type = 'button';
  me.setAttribute('aria-haspopup', 'dialog');
  me.setAttribute('aria-expanded', 'false');
  me.addEventListener('mousedown', (e) => e.preventDefault());
  // M12.1: settings, always one tap away (graphics, FPS, camera, full screen; L4.2: the help and the servers too).
  const gear = button('⚙', () => toggleSheet('settings'), 'rs-btn icon rs-gear rs-glass');
  gear.title = 'Settings';
  gear.setAttribute('aria-label', 'Settings');
  gear.setAttribute('aria-haspopup', 'dialog');
  gear.setAttribute('aria-expanded', 'false');
  right.append(me, gear);
  top.append(left, board, right);
  // Middle.
  const msg = el('div', 'rs-msg');
  msg.setAttribute('role', 'status');
  const struggle = el('div', 'rs-struggle');
  // A desktop's quiet reminder of the help (a touch screen has it in the settings).
  const corner = el('div', 'rs-corner');
  const hint = button('', () => toggleHelp(), 'rs-hint rs-glass');
  hint.append(el('kbd', undefined, 'H'), document.createTextNode('Help'));
  corner.append(hint);
  const fpsBox = el('div', 'rs-fps');
  // L4.2: the one expandable panel at a time: the place (plaza menu, room, match), your profile, the settings.
  const sheet = el('div', 'rs-card rs-ui rs-sheet left');
  sheet.setAttribute('role', 'dialog');
  const help = el('div', 'rs-card rs-ui rs-help');
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'How to play');
  // M8C-B.2: the one-time question about automatic invites (small, a corner, only until answered).
  const consent = el('div', 'rs-card rs-ui rs-consent');
  const toasts = el('div', 'rs-toasts');
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');
  const banner = el('div', 'rs-banner');
  const bannerBox = el('div');
  bannerBox.setAttribute('role', 'alertdialog');
  bannerBox.setAttribute('aria-live', 'assertive');
  banner.appendChild(bannerBox);
  // M12: the friendly ask to turn a phone held upright (the match goes on behind it).
  const rotate = el('div', 'rs-rotate');
  const rotateBox = el('div');
  rotateBox.append(el('div', 'ph'), el('h2', undefined, 'Rotate your phone'), el('p', undefined, 'Blobbi Rumble is made for landscape: the whole arena, and room for both thumbs. Your match keeps going meanwhile.'), button('Play in portrait anyway', () => a.dismissRotate()));
  rotate.appendChild(rotateBox);
  // L3: the lobby's room bar, countdown, results and waiting chip (drawn from the server's lobby message).
  const lobbyUi = createLobbyUi(
    {
      ready: (on) => a.lobbyReady(on),
      start: () => a.lobbyStart(),
      settings: (change) => a.lobbySettings(change),
      openRoom: (tab) => openSheet('place', tab),
    },
    { preview: lookPreview, defaultLook },
  );
  // L4.1: the menu, and the ways on that the sheets reuse.
  const plazaUi = createPlazaUi(
    {
      enterPlaza: () => a.enterPlaza(),
      quickMatch: () => a.quickMatch(),
      createRoom: () => a.hostGame(false),
      joinRoom: (code) => a.joinGame(code),
      toMenu: () => a.toMenu(),
      connectNostr: () => a.connectNostr(),
      releaseKeys: () => a.releaseKeys(),
    },
    { preview: lookPreview, mascots: ['P2', 'P1', 'P3'].map(defaultLook) },
  );
  left.append(place, lobbyUi.bar);
  document.body.append(top, msg, struggle, corner, sheet, help, consent, toasts, banner, rotate, fpsBox, ...lobbyUi.nodes, ...plazaUi.nodes);

  // The help card: built for keys, rebuilt for touch (M12).
  let touch = false;
  const buildHelp = () => {
    help.replaceChildren(el('h3', undefined, 'How to play'), button('✕', () => toggleHelp(false), 'rs-btn x'));
    for (const [keys, what] of touch ? TOUCH_HELP : HELP) {
      const row = el('div');
      row.append(el('kbd', undefined, keys), document.createTextNode(`  ${what}`));
      help.appendChild(row);
    }
    help.append(el('div', 'rs-sub', 'Knock the others off the island: the last Blobbi standing wins the round; first to 3 rounds wins the match.'));
    if (touch) {
      help.append(el('div', 'rs-sub', 'Keyboard works too (WASD, Space, F, G). Graphics, camera and full screen: ⚙ Settings.'));
      return;
    }
    const dbg = el('div', 'rs-sub');
    dbg.append(el('kbd', undefined, 'H'), document.createTextNode(' this help · '), el('kbd', undefined, 'F3'), document.createTextNode(' colliders · '), el('kbd', undefined, 'F4'), document.createTextNode(' network numbers'));
    help.appendChild(dbg);
  };
  buildHelp();

  let helpOpen = false;
  /** L4.2: which sheet is open (one at a time), and the part of the place sheet shown. */
  let sheetKind: SheetKind | null = null;
  /** L4.4A: whether the interface was last used from the keyboard (a key) or a pointer (a press), and how the open sheet was opened. */
  let keyboardLast = false;
  let sheetByKeyboard = false;
  /** L4.4A: whether the focus inside the sheet got there by the keyboard (Tab), not by a press on a field or a heading. */
  let sheetFocusByKeyboard = false;
  window.addEventListener('pointerdown', () => (keyboardLast = false), true);
  window.addEventListener('keydown', () => (keyboardLast = true), true);
  sheet.addEventListener('focusin', () => (sheetFocusByKeyboard = keyboardLast));
  let roomTab: RoomTab = 'players';
  let lastSheet = '';
  const triggers: Record<SheetKind, HTMLElement> = { place, profile: me, settings: gear };
  const toggleHelp = (open = !helpOpen) => {
    helpOpen = open;
    help.style.display = open ? 'block' : 'none';
    if (open) closeSheet();
  };
  const openSheet = (kind: SheetKind, tab?: RoomTab) => {
    if (sheetKind !== kind) sheetByKeyboard = keyboardLast;
    sheetKind = kind;
    if (tab) roomTab = tab;
    sheet.className = `rs-card rs-ui rs-sheet ${kind === 'place' ? 'left' : 'right'}`;
    sheet.setAttribute('aria-label', kind === 'place' ? 'Room' : kind === 'profile' ? 'Your profile' : 'Settings');
    sheet.style.display = 'block';
    for (const [k, t] of Object.entries(triggers)) t.setAttribute('aria-expanded', String(k === kind));
    lastSheet = '';
    toggleHelp(false);
  };
  const closeSheet = () => {
    if (!sheetKind) return;
    const was = sheetKind;
    sheetKind = null;
    sheet.style.display = 'none';
    for (const t of Object.values(triggers)) t.setAttribute('aria-expanded', 'false');
    // L4.4A: a sheet used from the keyboard (opened with it, or Tabbed into) hands the keyboard back to the button that opened
    // it; one closed with a pointer gives it back to the game: nothing in the interface keeps the focus, so the keys play at once.
    const focused = document.activeElement as HTMLElement | null;
    const inside = !!focused && sheet.contains(focused);
    const next = focusAfterClose({ keyboardLast, openedByKeyboard: sheetByKeyboard, focusInside: inside, insideByKeyboard: sheetFocusByKeyboard, onTrigger: !!focused && Object.values(triggers).includes(focused) });
    if (next === 'trigger') triggers[was].focus();
    else if (next === 'release') focused?.blur();
    sheetByKeyboard = false;
  };
  const toggleSheet = (kind: SheetKind, tab?: RoomTab) => (sheetKind === kind && (!tab || tab === roomTab) ? closeSheet() : openSheet(kind, tab));
  place.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet('place');
  });
  me.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSheet('profile');
  });
  // A press anywhere outside the open sheet (the arena, mostly) closes it; the top bar, cards and the banner keep it.
  document.addEventListener('pointerdown', (e) => {
    if (!sheetKind) return;
    const t = e.target as Node | null;
    if (t && (sheet.contains(t) || top.contains(t) || banner.contains(t) || help.contains(t) || consent.contains(t))) return;
    closeSheet();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      // A field keeps its Escape (it lets go of the keyboard); otherwise the topmost card goes, and the keyboard with it.
      if (isTyping(e)) return;
      if (helpOpen) toggleHelp(false);
      else if (sheetKind) closeSheet();
      else if ((document.activeElement as HTMLElement | null)?.closest?.('.rs-top, .rs-card, .rs-menu, .rs-banner')) (document.activeElement as HTMLElement).blur();
      return;
    }
    if (isTyping(e)) return;
    if (e.code === 'KeyH' && !e.repeat) toggleHelp();
  });

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

  let lastPlace = '';
  let lastMe = '';
  let lastBoard = '';
  let lastMsg = '';
  let lastStruggle = '';
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
    const out: Node[] = [el('div', 'rs-sec', 'Invite a Nostr friend')];
    if (v.invite.mode === 'guest') return [...out, el('div', 'rs-sub', 'Connect Nostr (your profile) to send private invites. Or share the code or the link above.')];
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
    const out: Node[] = [el('div', 'rs-sec', `Invites${ib.cards.length ? ` (${ib.cards.length})` : ''}`)];
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
  const blobbiSection = (ps: PickerState, form: RumbleForm | null, note: 'worn' | 'default' | 'refused', shared: boolean): Node[] => {
    const out: Node[] = [el('div', 'rs-sec', 'My Blobbis')];
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
      else out.push(el('div', 'rs-sub', note === 'worn' ? (shared ? 'Your fighter wears this form now, for everyone in the room.' : 'Your fighter wears this form now. This server shows it only to you; other players see the default.') : 'Your fighter takes this form as soon as the match is on screen.'));
    } else if (ps.selected && !form && !ps.missing) out.push(el('div', 'rs-warn', 'This Blobbi has no Rumble form here, so your fighter keeps the default look.'));
    const r = el('div', 'rs-row');
    if (ps.missing) r.append(button('Try again', a.reloadBlobbis));
    if (ps.selected) r.append(button('Use the default fighter', a.defaultBlobbi));
    else r.append(el('span', 'rs-sub', 'Using the default fighter.'));
    out.push(r);
    out.push(el('div', 'rs-sub', 'Your choice stays in this browser, for this identity. Nothing is published, and your Blobbi itself is unchanged.'));
    return out;
  };

  /** M11A: hosting a game: which arena (or a rotation), public or private. The choice is kept across panel redraws. */
  let hostDraft = { arena: ARENAS[0].id as string, rotate: false };
  const hostForm = (): Node[] => {
    const pick = el('select', 'rs-link');
    for (const ar of ARENAS) {
      const o = el('option', undefined, ar.name);
      o.value = ar.id;
      pick.append(o);
    }
    pick.value = hostDraft.arena;
    pick.addEventListener('focus', () => a.releaseKeys());
    pick.addEventListener('change', () => (hostDraft = { ...hostDraft, arena: pick.value }));
    pick.addEventListener('keydown', (e) => e.stopPropagation());
    const rotate = el('label', 'rs-sub');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = hostDraft.rotate;
    box.addEventListener('change', () => (hostDraft = { ...hostDraft, rotate: box.checked }));
    rotate.append(box, document.createTextNode(' rotate arenas between matches'));
    const row = el('div', 'rs-row');
    row.append(pick, rotate);
    const acts = el('div', 'rs-row');
    acts.append(button('Host a public game', () => a.hostGame(true, hostDraft.arena, hostDraft.rotate), 'rs-btn go'), button('Host a private game', () => a.hostGame(false, hostDraft.arena, hostDraft.rotate)));
    const chosen = arenaById(hostDraft.arena);
    return [row, acts, ...(chosen ? [el('div', 'rs-sub', chosen.description)] : [])];
  };

  /** M10B: the current server's public rooms: counts and state, Join, Refresh; never who is in them. */
  const roomsSection = (v: ShellView): Node[] => {
    const out: Node[] = [el('h5', undefined, 'Public rooms on this server')];
    const sv = v.servers;
    if (!sv.roomsSupported) return [...out, el('div', 'rs-sub', v.conn.phase === 'playing' || v.conn.phase === 'watching' ? 'This server does not list its rooms (an older server).' : 'Not connected.')];
    if (!sv.rooms) return [...out, el('div', 'rs-sub', 'Listing…')];
    if (!sv.rooms.length) out.push(el('div', 'rs-sub', 'No public rooms right now.'));
    for (const r of sv.rooms) {
      const row = el('div', 'rs-row');
      const here = v.room?.id === r.id;
      const words = `${arenaById(r.arena)?.name ?? 'Classic'} · ${r.players}/${r.maxPlayers} playing${r.spectators ? ` · ${r.spectators} watching` : ''} · ${r.phase === 'playing' ? `round ${r.round}` : r.phase}${r.joinable ? '' : ' · full'}`;
      row.append(el('b', undefined, r.kind === 'open' ? 'Open room' : r.id), el('span', 'rs-sub', words));
      if (here) row.append(el('span', 'rs-ok', 'you are here'));
      else if (r.joinable) row.append(button('Join', () => (r.kind === 'open' ? a.openRoom() : a.joinGame(r.id)), 'rs-btn go'));
      out.push(row);
    }
    const r = el('div', 'rs-row');
    r.append(button('Refresh', a.refreshRooms), el('span', 'rs-sub', 'Private games are not listed: join them by code or link.'));
    out.push(r);
    return out;
  };

  /** M10A: the game servers this page knows: the current one, the others to switch to, and a form for a community server. */
  let serverDraft = { name: '', url: '' };
  const serversSection = (v: ShellView): Node[] => {
    const sv = v.servers;
    const out: Node[] = [el('h5', undefined, 'Game servers')];
    if (sv.linkError) out.push(el('div', 'rs-err', `The server in this page’s link was not used: ${sv.linkError}.`));
    const words: Record<GameServer['source'], string> = { official: 'official', page: 'this site', dev: 'development', community: 'added by you', link: 'from this link' };
    for (const s of sv.known) {
      const row = el('div', 'rs-row');
      const here = s.id === sv.current.id;
      const who = el('div', 'who');
      who.append(el('b', undefined, clip(s.name, 28)), el('span', 'rs-sub', `${s.url.replace(/\/$/, '')} · ${words[s.source]}${s.region ? ` · ${s.region}` : ''}${s.operator ? ` · ${clip(s.operator, 24)}` : ''}`));
      row.append(who);
      if (here) row.append(el('span', 'rs-ok', v.conn.phase === 'playing' || v.conn.phase === 'watching' ? 'connected' : v.conn.phase === 'connecting' ? 'connecting…' : v.conn.phase === 'incompatible' ? 'incompatible' : v.conn.phase === 'rejected' ? 'refused this page' : 'unavailable'));
      else row.append(button('Use', () => a.useServer(s.id)));
      if (s.source === 'community') row.append(button('Remove', () => a.removeServer(s.id)));
      out.push(row);
    }
    if (sv.current.source === 'link') out.push(el('div', 'rs-sub', 'This page’s link named this server. It is used for this page only.'));
    const form = el('div', 'rs-row');
    const name = el('input', 'rs-link');
    name.placeholder = 'Name';
    name.maxLength = 40;
    name.value = serverDraft.name;
    const addr = el('input', 'rs-link');
    addr.placeholder = location.protocol === 'https:' ? 'wss://host/ws' : 'ws://host:8787 or wss://host/ws';
    addr.maxLength = 256;
    addr.value = serverDraft.url;
    const formErr = el('div', 'rs-err');
    const add = () => {
      const r = a.addServer({ name: name.value, url: addr.value });
      if (r) {
        formErr.textContent = `Not added: ${r}.`;
        return;
      }
      formErr.textContent = '';
      serverDraft = { name: '', url: '' };
      name.value = '';
      addr.value = '';
      toast('Server added');
    };
    for (const i of [name, addr]) {
      i.autocomplete = 'off';
      i.spellcheck = false;
      i.addEventListener('focus', () => a.releaseKeys());
      i.addEventListener('input', () => (serverDraft = { name: name.value, url: addr.value }));
      i.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') i.blur();
        if (e.key === 'Enter') add();
      });
    }
    form.append(name, addr, button('Add server', add));
    out.push(el('div', 'rs-sub', 'Add a community or self-hosted server (its address only; nothing else is stored). You connect only when you choose Use.'), form, formErr);
    return out;
  };

  /** M12: graphics quality (Auto / Low / Medium / High) and what it does now (refreshed live, once a second); M12.1: shared by the session panel and the settings card. */
  const graphicsLines: HTMLElement[] = [];
  let graphicsInfo: ShellView['graphics']['info'] | null = null;
  let graphicsAt = 0;
  const names: Record<QualityChoice, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };
  const qualityRow = (v: ShellView): HTMLElement => {
    const row = el('div', 'rs-row');
    const seg = el('div', 'rs-quality');
    for (const c of QUALITY_CHOICES) {
      const b = button(names[c], () => a.setQuality(c), c === v.graphics.choice ? 'rs-btn go' : 'rs-btn');
      b.setAttribute('aria-pressed', String(c === v.graphics.choice));
      seg.appendChild(b);
    }
    row.appendChild(seg);
    return row;
  };
  const liveLine = (v: ShellView): HTMLElement => {
    const line = el('div', 'rs-sub');
    graphicsLines.push(line);
    graphicsInfo = v.graphics.info;
    graphicsAt = 0;
    return line;
  };
  /** Full screen: a button where the browser has it, else a plain word on the home-screen app. */
  const displayNodes = (): Node[] => {
    const st = fullscreenState(document as never, isStandalone(window as never));
    const out: Node[] = [];
    if (st.supported && !st.standalone) {
      const row = el('div', 'rs-row');
      row.appendChild(
        button(st.active ? 'Exit full screen' : 'Full screen', async () => {
          if (!(await toggleFullscreen(document as never, document.documentElement as never))) toast('This browser did not allow full screen');
          lastSheet = '';
        }),
      );
      out.push(row);
    }
    const note = fullscreenNote(st);
    if (note) out.push(el('div', 'rs-sub', note));
    return out;
  };
  const graphicsNodes = (v: ShellView): Node[] => {
    graphicsLines.length = 0;
    return [
      el('div', 'rs-sec', 'Graphics'),
      qualityRow(v),
      liveLine(v),
      el('div', 'rs-sub', v.graphics.choice === 'auto' ? 'Auto follows how the device keeps up; pick a level to fix it (remembered on this device). The game and its rules are the same at every level.' : 'Fixed by you (remembered on this device). Auto adapts to the device.'),
    ];
  };
  const refreshGraphics = () => {
    if (!graphicsLines.length || !graphicsInfo || sheetKind !== 'settings') return;
    const now = performance.now();
    if (now - graphicsAt < 1000) return;
    graphicsAt = now;
    const g = graphicsInfo();
    const text = g ? `Now: ${g.level} · ${g.width}×${g.height} px (×${g.ratio.toFixed(2)}) · shadow ${g.shadowMap} · ${g.fps.toFixed(0)} fps` : 'Now: starting…';
    for (const line of graphicsLines) if (line.isConnected) line.textContent = text;
  };
  const onFullscreen = () => {
    lastSheet = '';
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('webkitfullscreenchange', onFullscreen);
  let fpsAt = 0;

  /** A picture of a look, drawn once and kept (the profile button, the profile card). */
  const lookPictures = new Map<string, string | null>();
  const lookPic = (look: RumbleLook, cls = 'pic') => {
    const box = el('span', cls);
    const key = `${look.seed}|${look.colors ? JSON.stringify(look.colors) : ''}`;
    const put = (src: string | null) => {
      if (!src) return;
      const img = el('img');
      img.alt = '';
      img.src = src;
      box.replaceChildren(img);
    };
    if (lookPictures.has(key)) put(lookPictures.get(key)!);
    else
      void lookPreview(look).then((src) => {
        lookPictures.set(key, src);
        put(src);
      });
    return box;
  };
  /** This player's fighter as it looks: their Blobbi's form when worn, else their seat's default fighter (P1's on the menu). */
  const myLook = (v: ShellView): RumbleLook => (v.blobbis?.form && v.blobbis.note !== 'refused' ? v.blobbis.form.look : defaultLook(v.you ?? 'P1'));

  /** A sheet's header: its title and a line under it, and the close button. */
  const sheetHead = (title: string, sub: string | null, lead?: Node): HTMLElement => {
    const hd = el('div', 'hd');
    const words = el('div', 'ttl');
    words.append(el('h3', undefined, title));
    if (sub) words.append(el('span', 'rs-sub', sub));
    const x = button('✕', closeSheet, 'rs-btn icon soft x');
    x.setAttribute('aria-label', 'Close');
    if (lead) hd.append(lead);
    hd.append(words, x);
    return hd;
  };
  const sec = (text: string) => el('div', 'rs-sec', text);
  /** A folding part of a sheet (rarely needed things: other rooms, hosting options, servers). */
  const fold = (title: string, nodes: Node[]): HTMLElement => {
    const d = el('details');
    d.append(el('summary', undefined, title), ...nodes);
    return d;
  };

  /** The room's code, its link, and the Nostr invitations (one place for all of them). */
  const inviteNodes = (v: ShellView): Node[] => {
    const out: Node[] = [];
    if (!v.room || v.room.kind !== 'private') return [el('div', 'rs-sub', 'Only a private room has a code to share.')];
    out.push(sec('Room code'), el('div', 'rs-code', v.room.id));
    const acts = el('div', 'rs-grid2');
    acts.append(button('Copy code', async () => toast((await copyText(v.room!.id)) === 'copied' ? 'Code copied' : `Code: ${v.room!.id}`)));
    if (v.share) {
      const link = el('input', 'rs-link');
      link.readOnly = true;
      link.value = v.share;
      link.setAttribute('aria-label', 'Invitation link');
      const hint = el('div', 'rs-sub', 'Anyone with the link or the code joins this room.');
      link.addEventListener('focus', () => {
        link.select();
        a.releaseKeys();
      });
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
      acts.append(canCopy() ? button('Copy link', async () => ((await copyText(v.share!)) === 'copied' ? toast('Link copied') : selectForCopy()), 'rs-btn go') : button('Select link', selectForCopy, 'rs-btn go'));
      const row = el('div', 'rs-row');
      row.append(link);
      out.push(acts, row, hint);
    } else out.push(acts);
    out.push(...inviteSection(v));
    return out;
  };

  /** Where else to go: the plaza, Quick Match, a new room, a code; the public rooms and hosting options folded away. */
  const elsewhereNodes = (v: ShellView, from: 'plaza' | 'elsewhere'): Node[] => [plazaUi.ways(from), fold('Public rooms on this server', roomsSection(v)), fold('Host a game (arena, public or private)', hostForm())];

  /** The tabs of a room's sheet; the chosen one lit. */
  const tabs = (list: [RoomTab, string][]): HTMLElement => {
    const bar = el('div', 'rs-tabs');
    bar.setAttribute('role', 'tablist');
    for (const [t, words] of list) {
      const b = button(words, () => {
        roomTab = t;
        lastSheet = '';
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t === roomTab));
      bar.append(b);
    }
    return bar;
  };

  /** L4.2: the place sheet: the plaza's menu, a room's players / settings / invitations / other rooms, Quick Match's players. */
  const placeNodes = (v: ShellView, hv: HudView, lv: LobbyView | null): Node[] => {
    const menuFoot = () => {
      const f = el('div', 'foot');
      f.append(button('⌂ Main menu', () => a.toMenu(), 'rs-btn soft'));
      return f;
    };
    if (hv.context === 'plaza' && v.plaza) {
      return [sheetHead('Blobbi Plaza', `${v.plaza.here} of ${v.plaza.capacity} here · everyone sees your name and your Blobbi`), sec('Play'), ...elsewhereNodes(v, 'plaza'), menuFoot()];
    }
    if (hv.context === 'away' || !v.room) return [sheetHead(hv.name, 'Not connected'), ...elsewhereNodes(v, 'elsewhere'), menuFoot()];
    const priv = v.room.kind === 'private';
    const list: [RoomTab, string][] = priv ? [['players', `Players`], ['settings', 'Settings'], ['invite', 'Invite'], ['rooms', 'Leave']] : [['players', 'Players'], ['rooms', 'Leave']];
    if (!list.some(([t]) => t === roomTab)) roomTab = 'players';
    const sub = lv ? (lv.status || (lv.mode === 'hidden' ? 'Match in progress' : '')) : 'Anyone on this server can join · bots fill the empty seats';
    const out: Node[] = [sheetHead(priv ? `Room ${v.room.id}` : 'Quick Match', sub || null), tabs(list)];
    if (roomTab === 'players') {
      if (lv) out.push(...lobbyUi.players(lv));
      else {
        const names = (pk: string) => clip(displayName(v.profile(pk), pk), 22);
        out.push(...lobbyUi.seats(rosterSeats(v.roster, v.you, names, (slot) => (v.blobbiNameOf(slot) ? clip(v.blobbiNameOf(slot)!, 18) : null))));
        if (v.spectators) out.push(el('div', 'rs-note', `${v.spectators} watching`));
      }
    } else if (roomTab === 'settings') {
      if (lv) out.push(...lobbyUi.settings(lv));
      else out.push(el('div', 'rs-arena-now', `${arenaById(v.room.arena ?? '')?.name ?? 'Classic'}${v.room.rotate ? ' · rotating between matches' : ''}`));
    } else if (roomTab === 'invite') out.push(...inviteNodes(v));
    else out.push(sec('Go somewhere else'), ...elsewhereNodes(v, 'elsewhere'), menuFoot());
    return out;
  };

  /** L4.2: the profile sheet: who you are (a name, never a key), your Blobbi, your invitations. */
  const profileNodes = (v: ShellView): Node[] => {
    const s = v.identity;
    const own = s.pubkey ? v.profile(s.pubkey) : undefined;
    const out: Node[] = [];
    const card = el('div', 'rs-idcard');
    const who = el('div', 'who');
    const verified = s.phase === 'verified' && !!s.pubkey;
    who.append(el('b', undefined, verified ? clip(displayName(own, s.pubkey!), 28) : 'Guest'));
    const blobbi = v.blobbis?.form && v.blobbis.note !== 'refused' ? v.blobbis.form.blobbi.name : null;
    who.append(el('span', 'rs-sub', blobbi ? `Playing as ${clip(blobbi, 22)}` : 'Playing the default Blobbi'));
    card.append(lookPic(myLook(v)), who);
    out.push(sheetHead('Your profile', null), card);
    // Identity.
    out.push(sec('Nostr'));
    const row = el('div', 'rs-row');
    if (verified) {
      const id = el('span');
      id.append(avatar(s.pubkey!, own?.picture, 22));
      const words = el('span', 'rs-sub', shortNpub(s.pubkey!, 8, 6));
      words.title = npubOf(s.pubkey!);
      row.append(id, words, button('Disconnect', a.disconnectNostr, 'rs-btn soft'));
    } else if (s.phase === 'error') {
      row.append(el('span', 'rs-err', s.error ?? 'Something went wrong.'), button('Try again', a.connectNostr, 'rs-btn go'), button('Play as guest', a.dismissIdentityError));
    } else if (s.phase === 'asking' || s.phase === 'proving' || s.phase === 'restoring') {
      row.append(el('span', 'rs-sub', s.phase === 'asking' ? 'Answer your Nostr extension’s prompt…' : s.phase === 'restoring' ? 'Restoring Nostr… (your extension may ask once)' : 'Verifying with the game server…'));
    } else if (s.phase === 'changed' && s.pubkey && s.other) {
      const o = v.profile(s.other);
      row.append(avatar(s.other, o?.picture, 22), el('span', undefined, `Your extension is signed in as ${clip(displayName(o, s.other), 20)}, not ${clip(displayName(own, s.pubkey), 20)}.`));
      out.push(row);
      const acts = el('div', 'rs-row');
      acts.append(button(`Connect as ${clip(displayName(o, s.other), 16)}`, a.connectOtherNostr, 'rs-btn go'), button('Not now', a.dismissOtherNostr), button('Forget', a.disconnectNostr));
      out.push(acts, el('div', 'rs-sub', 'Nothing switched by itself: your saved Blobbi and invites belong to the remembered identity.'));
      return out;
    } else if (s.phase === 'known' && s.pubkey) {
      row.append(avatar(s.pubkey, own?.picture, 22), el('span', undefined, clip(displayName(own, s.pubkey), 20)), button('Reconnect Nostr', a.connectNostr, 'rs-btn go'), button('Forget', a.disconnectNostr));
    } else {
      row.append(button('Connect Nostr', a.connectNostr, 'rs-btn go'));
      out.push(row, el('div', 'rs-sub', 'Connect to play as your own Blobbi, send private invites and receive them. As a guest you play the default Blobbi.'));
    }
    if (!out.includes(row)) out.push(row);
    if (v.diag) {
      const box = el('details');
      box.append(el('summary', 'rs-sub', `Nostr diagnostics (${v.diag.length} lines, development only)`));
      const pre = el('pre', 'rs-sub', v.diag.join('\n'));
      pre.style.cssText = 'white-space: pre-wrap; margin: 4px 0; max-height: 160px; overflow: auto; font: 11px ui-monospace, Menlo, monospace;';
      const r = el('div', 'rs-row');
      const text = v.diag.join('\n');
      r.append(button('Copy diagnostics', async () => void ((await copyText(text)) === 'copied' && toast('Diagnostics copied'))));
      box.append(pre, r);
      out.push(box);
    }
    if (v.blobbis && verified) out.push(...blobbiSection(v.blobbis.state, v.blobbis.form, v.blobbis.note, v.blobbis.shared));
    if (v.inbox) out.push(...inboxSection(v, v.inbox));
    return out;
  };

  /** L4.2: the settings sheet: graphics, the counter, the camera, full screen, the help, and the server. */
  const settingsNodes = (v: ShellView): Node[] => {
    const out: Node[] = [sheetHead('Settings', null), ...graphicsNodes(v)];
    out.push(sec('Performance'));
    const fpsRow = el('div', 'rs-row');
    const fps = button(v.fps ? '✓ FPS counter' : 'FPS counter', () => a.setFps(!v.fps), v.fps ? 'rs-btn on' : 'rs-btn');
    fps.setAttribute('aria-pressed', String(v.fps));
    fpsRow.append(fps);
    out.push(fpsRow);
    if (touch) {
      out.push(sec('Camera'));
      const camRow = el('div', 'rs-row');
      camRow.append(button('⟲ Recenter camera', () => a.recenterCamera()));
      out.push(camRow, el('div', 'rs-sub', 'Drag a finger across the arena (away from the stick and the buttons) to turn the camera.'));
    }
    const display = displayNodes();
    if (display.length) out.push(sec('Display'), ...display);
    out.push(sec('Help'));
    const helpRow = el('div', 'rs-row');
    helpRow.append(button('How to play', () => toggleHelp(true)));
    out.push(helpRow);
    out.push(sec('Server'));
    if (v.trust) {
      out.push(el('div', undefined, `${v.trust.label} · ${v.trust.host}`));
      if (v.server?.name) out.push(el('div', 'rs-sub', `Calls itself “${v.server.name}”`));
      if (v.server?.operator) {
        const p = v.profile(v.server.operator);
        out.push(el('div', 'rs-sub', `Operator (as the server states): ${clip(displayName(p, v.server.operator), 28)}`));
      }
      out.push(el('div', 'rs-sub', v.trust.detail));
    }
    out.push(fold('Game servers', serversSection(v)));
    return out;
  };

  /** The open sheet's contents, rebuilt only when something it shows changed, never under someone typing; a focused button keeps the focus. */
  const renderSheet = (v: ShellView, hv: HudView, lv: LobbyView | null) => {
    if (!sheetKind) return;
    const s = v.identity;
    const own = s.pubkey ? v.profile(s.pubkey) : undefined;
    let key: string;
    if (sheetKind === 'place') {
      const inviteWho = v.invite.status && 'pubkey' in v.invite.status ? v.profile(v.invite.status.pubkey) ?? null : null;
      key = JSON.stringify(['place', roomTab, hv, lv, v.plaza, v.roster, v.spectators, v.room, v.share, roomTab === 'rooms' ? v.servers.rooms : null, v.servers.roomsSupported, v.invite.mode, roomTab === 'invite' ? [v.invite, inviteWho] : null, Object.values(v.roster ?? {}).map((x) => (x.who === 'nostr' ? v.profile(x.pubkey) ?? null : null)), v.you, touch]);
    } else if (sheetKind === 'profile') {
      const inboxKey = v.inbox ? [v.inbox.setup, v.inbox.state, v.inbox.offer, v.inbox.cards.map((c) => [c.invite.id, c.trust.label, v.profile(c.invite.from) ?? null, Math.ceil((c.invite.expiresAt - Date.now() / 1000) / 60)])] : null;
      key = JSON.stringify(['profile', s, own, v.blobbis, inboxKey, v.diag?.length, v.you]);
    } else key = JSON.stringify(['settings', v.graphics.choice, v.fps, touch, v.trust, v.server, v.server?.operator ? v.profile(v.server.operator) ?? null : null, v.servers.known, v.servers.current, v.servers.linkError, v.conn.phase]);
    if (key === lastSheet) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && sheet.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')) return;
    // A details folded open stays open across the rebuild.
    const opened = new Set([...sheet.querySelectorAll('details')].filter((d) => d.open).map((d) => d.querySelector('summary')?.textContent ?? ''));
    const focused = active && sheet.contains(active) ? active.textContent : null;
    lastSheet = key;
    sheet.replaceChildren(...(sheetKind === 'place' ? placeNodes(v, hv, lv) : sheetKind === 'profile' ? profileNodes(v) : settingsNodes(v)));
    for (const d of sheet.querySelectorAll('details')) if (opened.has(d.querySelector('summary')?.textContent ?? '')) d.open = true;
    if (focused !== null) [...sheet.querySelectorAll('button')].find((b) => b.textContent === focused)?.focus();
  };

  return {
    toast,
    /** Open the place sheet (L4.2: at a part of it: the invitations, say). */
    openSession: (tab?: RoomTab) => openSheet('place', tab),
    get helpOpen() {
      return helpOpen;
    },
    /** Any sheet is open (the place, the profile or the settings). */
    get panelOpen() {
      return sheetKind !== null;
    },
    get settingsOpen() {
      return sheetKind === 'settings';
    },
    /** M12: something over the arena wants the player's fingers (a sheet, a card, the banner, the rotate ask): the touch controls step aside. */
    get modalOpen() {
      return sheetKind !== null || helpOpen || lobbyUi.resultsOpen || plazaUi.menuOpen || banner.style.display === 'flex' || rotate.style.display === 'flex';
    },
    /** M12: the player plays by touch: touch help, no browser gestures on the game. */
    setTouch(on: boolean) {
      if (on === touch) return;
      touch = on;
      document.body.classList.toggle('rs-touch', on);
      buildHelp();
      lastStruggle = '';
      lastSheet = '';
    },
    show(v: ShellView) {
      const c = v.conn;
      const rotateOn = v.rotate ? 'flex' : 'none';
      if (rotate.style.display !== rotateOn) rotate.style.display = rotateOn;
      // M12.1: the FPS counter (twice a second).
      refreshGraphics();
      const fpsDisplay = v.fps ? 'block' : 'none';
      if (fpsBox.style.display !== fpsDisplay) fpsBox.style.display = fpsDisplay;
      if (v.fps && performance.now() - fpsAt > 500) {
        fpsAt = performance.now();
        const g = v.graphics.info();
        fpsBox.textContent = g ? `${g.fps.toFixed(0)} fps` : '… fps';
      }
      const healthy = c.phase === 'playing' || c.phase === 'watching';
      const s = v.identity;
      const own = s.pubkey ? v.profile(s.pubkey) : undefined;
      // L4.2: where the player is decides what the corners say.
      const hv = hudView({ menu: v.menu, healthy, room: v.room, asked: c.room, lobby: v.lobby, roster: v.roster });
      const lv = v.lobby ? lobbyView({ lobby: v.lobby, roster: v.roster, tick: v.tick, tickHz: v.tickHz, personName: (pk) => clip(displayName(v.profile(pk), pk), 22), blobbiNameOf: (slot) => (v.blobbiNameOf(slot) ? clip(v.blobbiNameOf(slot)!, 18) : null), keys: !touch }) : null;
      if (hv.context === 'menu' && sheetKind === 'place') closeSheet();
      // The place pill: the place, its counts, a dot while not connected.
      const pKey = JSON.stringify([hv, c.phase]);
      if (pKey !== lastPlace) {
        lastPlace = pKey;
        place.style.display = hv.context === 'menu' ? 'none' : '';
        const parts: Node[] = [hv.context === 'away' ? el('span', 'dot') : el('span', 'ic', hv.icon), el('b', undefined, hv.name)];
        hv.counts.forEach((n, i) => parts.push(el('span', `cnt${hv.context === 'room' && i === 1 && lv && lv.seats.some((x) => x.kind === 'person') && v.lobby!.ready.length >= v.lobby!.seated.length ? ' ok' : ''}`, n)));
        parts.push(el('span', 'car', '▾'));
        place.replaceChildren(...parts);
        place.setAttribute('aria-label', hv.label);
        place.title = hv.context === 'plaza' ? 'Plaza menu' : hv.context === 'away' ? 'Not connected' : 'Room: players, settings, invitations';
      }
      // The profile button: your fighter's picture and your name (never a key), invitations waiting.
      const invites = v.inbox?.cards.length ?? 0;
      const look = myLook(v);
      const verified = s.phase === 'verified' && !!s.pubkey;
      const name = verified ? clip(displayName(own, s.pubkey!), 18) : s.phase === 'asking' || s.phase === 'proving' || s.phase === 'restoring' ? 'Connecting…' : s.phase === 'error' || s.phase === 'changed' ? 'Nostr ⚠' : 'Guest';
      const mKey = JSON.stringify([look, name, invites]);
      if (mKey !== lastMe) {
        lastMe = mKey;
        me.replaceChildren(lookPic(look), el('span', 'nm', name), ...(invites ? [el('span', 'rs-badge', `✉ ${invites}`)] : []));
        me.setAttribute('aria-label', `Your profile: ${name}${invites ? `, ${invites} invitation${invites === 1 ? '' : 's'}` : ''}`);
        me.title = 'Your profile, your Blobbi, invitations';
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
      // L3, L4.2: the scoreboard is for a match on; the plaza and a room between matches have none.
      board.style.display = snap && hv.context === 'combat' && !isSocialSpace(snap.arena) ? '' : 'none';
      // The contextual message, with names for slot ids.
      const m = v.message ? v.message.replace(/\bP[1-4]\b/g, (id) => clip(label(v, id), 16)) : '';
      if (m !== lastMsg) {
        lastMsg = m;
        msg.textContent = m;
        msg.style.display = m ? 'block' : 'none';
      }
      // Your struggle.
      const meF = snap && v.you ? snap.fighters.find((f) => f.id === v.you) : undefined;
      const held = meF?.heldBy && !meF.eliminated ? meF : undefined;
      const stKey = held ? `${held.heldBy}|${Math.round(held.combat.struggle * 20)}` : '';
      if (stKey !== lastStruggle) {
        lastStruggle = stKey;
        if (held) {
          const bar = el('div', 'bar');
          const fill = el('i');
          fill.style.width = `${Math.round(held.combat.struggle * 100)}%`;
          bar.appendChild(fill);
          struggle.replaceChildren(el('div', undefined, `Grabbed by ${clip(label(v, held.heldBy!), 14)}! ${touch ? 'Tap Break free fast' : 'Alternate ← → (A D) fast'}`), bar);
        }
        struggle.style.display = held ? 'block' : 'none';
      }
      // The open sheet.
      renderSheet(v, hv, lv);
      // The people part of the invitations (M8C-C): refreshed on its own, so typing never loses results or focus.
      if (sheetKind === 'place' && roomTab === 'invite' && v.people) {
        const pplKey = JSON.stringify([v.people, v.invite, v.invite.status && 'pubkey' in v.invite.status ? v.profile(v.invite.status.pubkey) ?? null : null, [...v.people.follows.rows, ...v.people.search.rows, ...(v.people.selected ? [v.people.selected] : [])].map((r) => v.profile(r.pubkey) ?? null)]);
        if (pplKey !== lastPeople) {
          lastPeople = pplKey;
          renderPeople(v);
        }
      }
      // L4.1: the menu (a plain visit: nothing connected until the player chooses); the profile and settings sheets may sit over it.
      const who = { name: verified ? clip(displayName(own, s.pubkey!), 24) : null, busy: s.phase === 'asking' || s.phase === 'proving' || s.phase === 'restoring', pubkey: verified ? s.pubkey : null, ...(verified && own?.picture ? { picture: own.picture } : {}) };
      const showMenu = v.menu && !helpOpen;
      plazaUi.showMenu(showMenu ? { who } : null);
      corner.style.display = v.menu ? 'none' : '';
      // The automatic-invites question (M8C-B.2): a corner card while unanswered, unless the profile (which asks it too) is open.
      const showConsent = !!v.inbox?.offer && healthy && !showMenu && sheetKind !== 'profile';
      if (showConsent !== lastConsent) {
        lastConsent = showConsent;
        consent.style.display = showConsent ? 'block' : 'none';
        if (showConsent) consent.replaceChildren(...consentNodes());
      }
      // L3: the room bar, the countdown, the results and the waiting chip (the results step aside for the help and the banner).
      const d = describe(c, v.now);
      lobbyUi.show(lv && healthy && !helpOpen && !d ? { view: lv, touch } : null);
      // The banner: loud, only when play is impossible (or a connection is on its way), with the way out.
      const bnKey = d ? JSON.stringify(d) : '';
      if (bnKey !== lastBanner) {
        lastBanner = bnKey;
        banner.style.display = d ? 'flex' : 'none';
        if (d) {
          const acts: Record<BannerAction, () => HTMLButtonElement> = {
            retry: () => button(c.phase === 'refused' || c.phase === 'plazaFull' ? 'Try again' : 'Retry now', a.retry, 'rs-btn go'),
            quick: () => button('⚡ Quick Match', a.quickMatch),
            private: () => button('＋ Create private room', () => a.hostGame(false)),
            open: () => button('Play Quick Match', a.openRoom, c.phase === 'missing' ? 'rs-btn go' : 'rs-btn'),
            host: () => button('Host a new game', () => a.hostGame(true)),
            menu: () => button('⌂ Main menu', a.toMenu, 'rs-btn soft'),
          };
          banner.className = `rs-banner${d.icon === 'wait' ? ' quiet' : ''}`;
          const row = el('div', 'acts');
          row.append(...d.actions.map((k) => acts[k]()));
          bannerBox.replaceChildren(d.icon === 'wait' ? el('div', 'spin') : el('div', 'ic', d.icon), el('h2', undefined, d.title), el('p', undefined, d.detail), ...(d.actions.length ? [row] : []));
        }
      }
    },
  };
}
