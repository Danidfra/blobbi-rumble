/**
 * THE LOBBY ON SCREEN (L3): the lobby card, the countdown, the results
 * card and the "waiting for next match" chip, drawn from `lobbyView`'s
 * model and nothing else. Part of the game's shell (its cards, buttons and
 * text-only DOM rules); no separate application.
 *
 *   lobby / countdown   a card on the right: the room (code, link, invite),
 *                       the seats (who, Blobbi, ready, owner), who waits, the
 *                       settings (the owner's to change), Ready and Start;
 *                       it folds down to its header to uncover the arena
 *   countdown           the big number in the middle (never in the way)
 *   results             a card in the middle: the winner, every fighter,
 *                       human or bot, the scores, the way back
 *   watching a match    a small chip: "Waiting for next match"
 *
 * Invitations, the Blobbi picker and identity stay where they are (the
 * session panel); the card only opens it. Everything from a server or a
 * relay goes in as text. Buttons never take focus (Space and Enter stay
 * jump); R stays Ready.
 */
import { button, el } from './dom';
import type { RumbleLook } from './rumbleForm';
import type { LobbyView, SeatRow } from './lobbyView';

export interface LobbyUiActions {
  ready(on: boolean): void;
  start(): void;
  settings(change: { bots?: boolean; arena?: string; rotate?: boolean }): void;
  /** Open the session panel (where invitations, the Blobbi picker and identity live). */
  openSession(): void;
  copyLink(): void;
}

export interface LobbyUiInput {
  view: LobbyView;
  /** The private room's code, and whether there is a link to copy. */
  room: string | null;
  share: boolean;
  /** A proven identity (can choose a Blobbi) or not (can connect one). */
  verified: boolean;
  touch: boolean;
}

export interface LobbyUiDeps {
  /** A picture of a look (null: none can be drawn). */
  preview: (look: RumbleLook) => Promise<string | null>;
  /** A seat's default fighter's look (its fighter when it wears no form). */
  defaultLook: (seat: string) => RumbleLook;
}

export const LOBBY_CSS = `
  .rs-lobby { right: calc(env(safe-area-inset-right, 0px) + 10px); top: calc(env(safe-area-inset-top, 0px) + 50px); width: min(330px, calc(100vw - 20px)); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 64px); overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; padding: 10px 12px; display: none; }
  .rs-lobby .hd { display: flex; align-items: center; gap: 6px; }
  .rs-lobby .hd .ttl { font: 700 14px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em; }
  .rs-lobby .hd .code { font: 700 15px ui-monospace, Menlo, monospace; letter-spacing: 0.1em; }
  .rs-lobby .hd .fold { margin-left: auto; }
  .rs-lobby.folded .body { display: none; }
  .rs-lobby.folded { width: auto; max-width: calc(100vw - 20px); }
  .rs-lobby .hd .mini { white-space: nowrap; }
  .rs-lobby.folded .hd .rs-btn.go { padding: 6px 12px; }
  .rs-lobby h4 { margin: 10px 0 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7082; }
  .rs-seat { display: flex; align-items: center; gap: 8px; padding: 4px 6px; margin: 2px 0; border-radius: 10px; }
  .rs-seat.you { background: #f4f7f2; box-shadow: inset 0 0 0 1px #cfe6d7; }
  .rs-seat.empty { opacity: 0.6; }
  .rs-seat.out { opacity: 0.5; }
  .rs-seat .pic { flex: none; width: 34px; height: 34px; border-radius: 8px; background: #eef1f6; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .rs-seat .pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .rs-seat .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .rs-seat .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .rs-seat .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: #6b7082; }
  .rs-pill { flex: none; padding: 2px 8px; border-radius: 999px; font: 600 11px ui-sans-serif, system-ui, sans-serif; background: #eef1f6; color: #555a6e; white-space: nowrap; }
  .rs-pill.ready { background: #6fc38f; color: #fff; }
  .rs-pill.wait { background: #fbe9c6; color: #8a5a00; }
  .rs-pill.bot { background: #e3e8f4; color: #4b5578; }
  .rs-pill.left { background: #f3dcdb; color: #8f3431; }
  .rs-seg { display: inline-flex; border: 1px solid #d6dbe6; border-radius: 9px; overflow: hidden; }
  .rs-seg .rs-btn { border: none; border-radius: 0; }
  .rs-seg .rs-btn.on { background: #2b2b3a; color: #fff; }
  .rs-arenas { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 4px; }
  .rs-arenas .rs-btn { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-arenas .rs-btn.on { border-color: #2b2b3a; box-shadow: inset 0 0 0 1px #2b2b3a; }
  .rs-lobby .rs-btn[disabled], .rs-results .rs-btn[disabled] { opacity: 0.45; cursor: default; }
  .rs-lobby .foot { position: sticky; bottom: -10px; margin: 8px -12px -10px; padding: 6px 12px 10px; background: rgba(255,255,255,0.97); border-top: 1px solid #eef1f6; }
  .rs-lobby .acts { display: flex; gap: 6px; margin-top: 6px; }
  .rs-lobby .acts .rs-btn { flex: 1; padding: 9px 10px; font-size: 14px; }
  .rs-lobby .status { font-size: 12px; color: #2b2b3a; }
  .rs-count { position: fixed; left: 50%; top: 42%; transform: translate(-50%, -50%); z-index: 4; pointer-events: none; display: none; text-align: center; color: #fff; text-shadow: 0 4px 18px rgba(40,50,80,0.45); font: 800 96px ui-sans-serif, system-ui, sans-serif; line-height: 1; }
  .rs-count small { display: block; margin-top: 8px; font: 700 16px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; }
  .rs-results { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 24px); overflow: auto; overscroll-behavior: contain; padding: 14px 18px; display: none; text-align: center; }
  .rs-results h3 { margin: 0 0 2px; font-size: 20px; }
  .rs-results .sub { margin: 0 0 10px; color: #6b7082; font-size: 12px; }
  .rs-results .row { display: grid; grid-template-columns: 22px 1fr auto auto; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 10px; text-align: left; }
  .rs-results .row.win { background: #f4f7f2; box-shadow: inset 0 0 0 1px #cfe6d7; }
  .rs-results .row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-results .row .sc { font-size: 12px; letter-spacing: 2px; color: #3d8f5e; white-space: nowrap; }
  .rs-results .back { margin-top: 10px; font-size: 12px; color: #6b7082; }
  .rs-wait { position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 52px); transform: translateX(-50%); z-index: 4; padding: 5px 14px; border-radius: 999px; background: rgba(43,43,58,0.78); color: #fff; font: 600 13px ui-sans-serif, system-ui, sans-serif; pointer-events: none; display: none; white-space: nowrap; }
  @media (pointer: coarse) {
    .rs-lobby .rs-btn, .rs-results .rs-btn { min-height: 40px; }
    .rs-seat { min-height: 44px; }
  }
  @media (max-width: 860px) {
    .rs-lobby { top: 108px; max-height: calc(100dvh - 120px); }
    .rs-wait { top: 108px; }
  }
  /* A phone on its side: a narrower card under the slim top row; the countdown smaller; the results fit the short height. */
  @media (max-height: 520px) {
    .rs-lobby { top: calc(env(safe-area-inset-top, 0px) + 44px); width: min(300px, 44vw); max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 52px); padding: 8px 10px; }
    .rs-lobby .foot { bottom: -8px; margin: 6px -10px -8px; padding: 4px 10px 8px; }
    .rs-lobby .share { flex-wrap: nowrap; }
    .rs-lobby .share .rs-btn { padding: 6px 8px; font-size: 12px; white-space: nowrap; }
    .rs-lobby h4 { margin: 6px 0 2px; }
    .rs-seat { padding: 2px 4px; }
    .rs-seat .pic { width: 28px; height: 28px; }
    .rs-count { font-size: 64px; top: 46%; }
    .rs-results { padding: 10px 14px; }
    .rs-results h3 { font-size: 17px; }
    .rs-results .row { padding: 3px 8px; }
    .rs-wait { top: calc(env(safe-area-inset-top, 0px) + 44px); }
  }
`;

/** The seat's tag line: you, owner, the Blobbi it wears. */
function seatTags(s: SeatRow): string {
  const tags = [s.you ? 'you' : '', s.owner ? 'owner' : '', s.kind === 'person' && s.blobbi ? s.blobbi : '', s.kind !== 'empty' && !s.plays ? 'next match' : ''].filter(Boolean);
  return tags.join(' · ') || (s.kind === 'bot' ? 'plays the empty seat' : s.kind === 'empty' ? 'bots are off' : s.pubkey ? 'Nostr' : 'guest');
}

const READY_WORDS: Record<SeatRow['ready'], [string, string]> = {
  ready: ['Ready', 'ready'],
  'not-ready': ['Not ready', 'wait'],
  bot: ['Bot', 'bot'],
  open: ['Open', ''],
};

export function createLobbyUi(a: LobbyUiActions, deps: LobbyUiDeps) {
  const card = el('div', 'rs-card rs-lobby');
  const count = el('div', 'rs-count');
  const results = el('div', 'rs-card rs-results');
  const wait = el('div', 'rs-wait', 'Waiting for next match');
  for (const e of [card, count, results, wait]) e.style.display = 'none';
  /** Folded to its header (null: not decided yet: the first show folds it on a touch screen, L4). */
  let folded: boolean | null = null;
  let lastCard = '';
  let lastResults = '';
  let lastCount = '';
  /** Pictures already drawn, by look, so a rebuild shows them at once. */
  const pictures = new Map<string, string | null>();

  const picture = (look: RumbleLook) => {
    const box = el('span', 'pic');
    const key = `${look.seed}|${look.colors ? JSON.stringify(look.colors) : ''}`;
    const put = (src: string | null) => {
      if (!src) return;
      const img = el('img');
      img.alt = '';
      img.src = src;
      box.replaceChildren(img);
    };
    if (pictures.has(key)) put(pictures.get(key)!);
    else
      void deps.preview(look).then((src) => {
        pictures.set(key, src);
        put(src);
      });
    return box;
  };

  const seatRow = (s: SeatRow) => {
    const row = el('div', `rs-seat${s.you ? ' you' : ''}${s.kind === 'empty' ? ' empty' : ''}`);
    const who = el('span', 'who');
    who.append(el('b', undefined, `${s.owner ? '★ ' : ''}${s.name}`), el('span', undefined, seatTags(s)));
    const [words, tone] = READY_WORDS[s.ready];
    const pill = el('span', `rs-pill${tone ? ` ${tone}` : ''}`, words);
    row.append(s.kind === 'empty' ? el('span', 'pic') : picture(s.look ?? deps.defaultLook(s.seat)), who, pill);
    row.title = s.seat;
    return row;
  };

  /** A two-way switch: the current value lit; the owner's to change, or shown only. */
  const seg = (on: boolean, editable: boolean, set: (v: boolean) => void) => {
    const box = el('span', 'rs-seg');
    for (const v of [true, false]) {
      const b = button(v ? 'On' : 'Off', () => v !== on && set(v), `rs-btn${v === on ? ' on' : ''}`);
      b.disabled = !editable;
      box.append(b);
    }
    return box;
  };

  /** Ready and the owner's Start (shown in the card's foot, and in its header when folded). */
  const actionButtons = (v: LobbyView) => {
    const out: HTMLButtonElement[] = [];
    if (v.ready.shown) out.push(button(v.ready.label, () => a.ready(v.ready.next), `rs-btn${v.ready.next ? ' go' : ''}`));
    if (v.start.shown) {
      const b = button(v.start.label, a.start, 'rs-btn go');
      b.disabled = v.start.disabled;
      if (v.start.reason) b.title = v.start.reason;
      out.push(b);
    }
    return out;
  };

  const renderCard = (i: LobbyUiInput) => {
    const v = i.view;
    const hd = el('div', 'hd');
    hd.append(el('span', 'ttl', v.mode === 'countdown' ? 'Starting' : 'Lobby'));
    if (i.room) hd.append(el('span', 'code', i.room));
    // L4: folded, the header keeps what matters while walking: how many are ready, and Ready / Start.
    if (folded) {
      const people = v.seats.filter((x) => x.kind === 'person');
      hd.append(el('span', 'rs-sub mini', `${people.filter((x) => x.ready === 'ready').length}/${people.length} ready`), ...actionButtons(v));
    }
    hd.append(button(folded ? '▸' : '▾', () => {
      folded = !folded;
      lastCard = '';
    }, 'rs-btn fold'));
    const body = el('div', 'body');
    // The room: share it (the session panel holds the invitations).
    const share = el('div', 'rs-row share');
    if (i.share) share.append(button('Copy link', a.copyLink));
    share.append(button('Invite…', a.openSession));
    share.append(button(i.verified ? 'Choose Blobbi…' : 'Use my Blobbi…', a.openSession));
    body.append(share);
    // The seats.
    body.append(el('h4', undefined, 'Players'));
    for (const s of v.seats) body.append(seatRow(s));
    if (v.watchers.length) {
      body.append(el('h4', undefined, `Waiting for next match (${v.watchers.length})`));
      body.append(el('div', 'rs-sub', v.watchers.map((w) => w.name).join(' · ')));
    }
    // The settings: the owner's in the lobby; everyone sees them.
    body.append(el('h4', undefined, v.settings.editable ? 'Settings (you own this room)' : 'Settings'));
    const bots = el('div', 'rs-row');
    bots.append(el('span', undefined, 'Bots'), seg(v.settings.bots, v.settings.editable, (b) => a.settings({ bots: b })), el('span', undefined, 'Rotate'), seg(v.settings.rotate, v.settings.editable, (r) => a.settings({ rotate: r })));
    body.append(bots);
    if (v.settings.editable) {
      const grid = el('div', 'rs-arenas');
      for (const ar of v.arenas) {
        const b = button(ar.name, () => ar.id !== v.settings.arena && a.settings({ arena: ar.id }), `rs-btn${ar.id === v.settings.arena ? ' on' : ''}`);
        b.title = ar.name;
        grid.append(b);
      }
      body.append(grid);
    } else body.append(el('div', 'rs-sub', `Arena: ${v.settings.arenaName}${v.settings.rotate ? ' · rotating between matches' : ''}`));
    if (v.last) body.append(el('div', 'rs-sub', v.last));
    // What happens next, and this person's controls: pinned at the card's foot, in reach without scrolling (a phone on its side).
    const foot = el('div', 'foot');
    foot.append(el('div', 'status', v.status));
    if (v.watching) foot.append(el('div', 'rs-sub', 'You are watching: you get a seat in the next lobby with one free.'));
    const acts = el('div', 'acts');
    const buttons = actionButtons(v);
    acts.append(...buttons);
    if (buttons.length) foot.append(acts);
    if (v.start.shown && v.start.reason) foot.append(el('div', 'rs-sub', v.start.reason));
    body.append(foot);
    card.className = `rs-card rs-lobby${folded ? ' folded' : ''}`;
    card.replaceChildren(hd, body);
  };

  const renderResults = (i: LobbyUiInput) => {
    const r = i.view.results!;
    const rows = r.rows.map((x) => {
      const row = el('div', `row${x.winner ? ' win' : ''}`);
      row.append(el('span', undefined, x.winner ? '🏆' : ''), el('b', undefined, `${x.name}${x.you ? ' (you)' : ''}`), el('span', `rs-pill${x.kind === 'bot' ? ' bot' : x.kind === 'empty' ? ' left' : ''}`, x.label), el('span', 'sc', `${x.score}`));
      row.title = x.id;
      return row;
    });
    results.replaceChildren(el('h3', undefined, r.title), el('div', 'sub', r.subtitle), ...rows, el('div', 'back', `Back to the lobby in ${r.back} s`));
  };

  return {
    /** The elements, for the shell to place. */
    nodes: [card, count, results, wait] as const,
    /** Whether the lobby card is up (and unfolded). */
    get cardOpen() {
      return card.style.display === 'block' && !folded;
    },
    get resultsOpen() {
      return results.style.display === 'block';
    },
    /**
     * Draw what the model says (null: not a lobby room, or the card must step
     * aside for another card). Rebuilt only when something shown changed.
     */
    show(i: LobbyUiInput | null) {
      const v = i?.view;
      const cardOn = !!v && (v.mode === 'lobby' || v.mode === 'countdown');
      if (cardOn && folded === null) folded = i!.touch;
      const ck = cardOn ? JSON.stringify([v, i!.room, i!.share, i!.verified, i!.touch, folded, v!.countdown === null]) : '';
      // Never rebuilt under a click in progress: only when something changed.
      if (ck !== lastCard) {
        lastCard = ck;
        if (cardOn) renderCard(i!);
      }
      const cd = cardOn ? 'block' : 'none';
      if (card.style.display !== cd) card.style.display = cd;
      const cnt = v && v.countdown !== null ? String(v.countdown) : '';
      if (cnt !== lastCount) {
        lastCount = cnt;
        count.replaceChildren(document.createTextNode(cnt === '0' ? 'GO' : cnt), el('small', undefined, 'Match starts'));
        count.style.display = cnt ? 'block' : 'none';
      }
      const rk = v?.results ? JSON.stringify(v.results) : '';
      if (rk !== lastResults) {
        lastResults = rk;
        if (rk) renderResults(i!);
        results.style.display = rk ? 'block' : 'none';
      }
      const w = v?.mode === 'waiting' ? 'block' : 'none';
      if (wait.style.display !== w) wait.style.display = w;
    },
  };
}
