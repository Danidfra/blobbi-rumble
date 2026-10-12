/**
 * THE LOBBY ON SCREEN (L3, reorganised in L4.2 around what the player does):
 * drawn from `lobbyView`'s model and nothing else, with the shell's parts.
 *
 *   room bar       beside the place pill, always at hand between matches:
 *                  Ready / Not ready (the main action), the owner's Start,
 *                  Invite. The counts are the pill's (`hud.ts`).
 *   players        the roster, for the room sheet: each seat's Blobbi, name,
 *                  owner, you, ready, bots and open seats; who waits
 *   settings       for the room sheet: arena, rotation, bots and Start; the
 *                  owner's to change, everyone's to see
 *   countdown      the big number in the middle (never in the way)
 *   results        a card in the middle: the winner and their Blobbi, every
 *                  fighter (human, bot or left) with the score, and the way
 *                  back to the plaza
 *   watching       a small chip: "Waiting for next match"
 *
 * Invitations, the Blobbi picker and identity are the shell's (one of
 * each). Everything from a server or a relay goes in as text. A click never
 * leaves a button focused (Space and Enter stay jump); R stays Ready.
 */
import { LIFECYCLE } from '../net/lifecycle';
import { ROUND } from '../tuning';
import { button, el } from './dom';
import type { RumbleLook } from './rumbleForm';
import type { LobbyView, SeatRow } from './lobbyView';

/** Which part of the room sheet to open. */
export type RoomTab = 'players' | 'settings' | 'invite' | 'rooms';

export interface LobbyUiActions {
  ready(on: boolean): void;
  start(): void;
  settings(change: { bots?: boolean; arena?: string; rotate?: boolean }): void;
  /** Open the room sheet at one of its parts (Invite: the code, the link and the Nostr invitations). */
  openRoom(tab: RoomTab): void;
}

export interface LobbyUiInput {
  view: LobbyView;
  /** A keyboard page (key hints) or a touch one. */
  touch: boolean;
}

export interface LobbyUiDeps {
  /** A picture of a look (null: none can be drawn). */
  preview: (look: RumbleLook) => Promise<string | null>;
  /** A seat's default fighter's look (its fighter when it wears no form). */
  defaultLook: (seat: string) => RumbleLook;
}

export const LOBBY_CSS = `
  .rs-roombar { display: flex; gap: 6px; align-items: center; }
  .rs-roombar .rs-btn { min-height: 36px; box-shadow: var(--rs-shadow-sm); }
  .rs-roombar .ready { min-width: 92px; font-size: 14px; }
  .rs-roombar kbd { padding: 0 5px; border-radius: 5px; background: rgba(255,255,255,0.7); font: 700 10px ui-monospace, Menlo, monospace; opacity: 0.8; }
  .rs-seat { display: flex; align-items: center; gap: 10px; padding: 6px 8px; margin: 3px 0; border-radius: var(--rs-r-md); }
  .rs-seat.you { background: var(--rs-lilac-soft); }
  .rs-seat.empty { opacity: 0.6; }
  .rs-seat .pic { flex: none; width: 38px; height: 38px; border-radius: 12px; background: var(--rs-wash); overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .rs-seat .pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .rs-seat .who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .rs-seat .who b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .rs-seat .who span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--rs-sub); }
  .rs-seat .tags { display: flex; gap: 4px; flex: none; }
  .rs-setrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 6px 0; }
  .rs-setrow > span { font-weight: 700; }
  .rs-setrow > span small { display: block; font-weight: 500; font-size: 11px; color: var(--rs-sub); }
  .rs-arenas { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .rs-arenas .rs-btn { justify-content: flex-start; min-height: 40px; white-space: normal; text-align: left; font-size: 12px; }
  .rs-arena-now { padding: 10px 12px; border-radius: var(--rs-r-md); background: var(--rs-wash); font-weight: 700; }
  .rs-note { margin-top: 8px; color: var(--rs-sub); font-size: 12px; }
  .rs-count { position: fixed; left: 50%; top: 42%; transform: translate(-50%, -50%); z-index: 4; pointer-events: none; display: none; text-align: center; color: #fff; text-shadow: 0 4px 18px rgba(40,40,90,0.5); font: 900 104px/1 var(--rs-font); }
  .rs-count small { display: block; margin-top: 10px; font: 800 16px var(--rs-font); letter-spacing: 0.1em; text-transform: uppercase; }
  .rs-results { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(420px, calc(100vw - 24px)); max-height: calc(100dvh - var(--rs-safe-t) - var(--rs-safe-b) - 24px); overflow: auto; overscroll-behavior: contain; padding: 18px 20px 16px; display: none; text-align: center; background: linear-gradient(180deg, #fff6fa 0%, #ffffff 42%); }
  .rs-results .champ { width: 84px; height: 84px; margin: -4px auto 2px; display: flex; align-items: center; justify-content: center; }
  .rs-results .champ img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 6px 10px rgba(52,46,98,0.2)); }
  .rs-results .crown { font-size: 22px; line-height: 1; }
  .rs-results h3 { margin: 2px 0 2px; font: 900 22px var(--rs-font); }
  .rs-results .sub { margin: 0 0 12px; color: var(--rs-sub); font-size: 13px; }
  .rs-results .row { display: grid; grid-template-columns: 22px 30px 1fr auto auto; gap: 8px; align-items: center; padding: 5px 8px; margin: 2px 0; border-radius: var(--rs-r-md); text-align: left; }
  .rs-results .row.win { background: var(--rs-sun-soft); }
  .rs-results .row.me { box-shadow: inset 0 0 0 2px var(--rs-lilac-soft); }
  .rs-results .row .rank { font-weight: 900; color: var(--rs-faint); text-align: center; }
  .rs-results .row .pic { width: 30px; height: 30px; border-radius: 10px; background: var(--rs-wash); overflow: hidden; display: flex; }
  .rs-results .row .pic img { width: 100%; height: 100%; object-fit: contain; }
  .rs-results .row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-results .row .sc { font-size: 13px; letter-spacing: 2px; color: #d4709a; white-space: nowrap; }
  .rs-results .back { margin-top: 12px; font-size: 12px; color: var(--rs-sub); }
  .rs-results .bar { height: 6px; margin-top: 6px; border-radius: 3px; background: var(--rs-wash); overflow: hidden; }
  .rs-results .bar > i { display: block; height: 100%; border-radius: 3px; background: var(--rs-mint); transition: width 1s linear; }
  .rs-wait { position: fixed; left: 50%; top: calc(var(--rs-safe-t) + 58px); transform: translateX(-50%); z-index: 4; padding: 6px 14px; border-radius: 999px; background: rgba(42,41,68,0.8); color: #fff; font: 700 13px var(--rs-font); pointer-events: none; display: none; white-space: nowrap; }
  @media (max-width: 860px) {
    .rs-wait { top: calc(var(--rs-safe-t) + 96px); }
  }
  @media (pointer: coarse) {
    .rs-roombar .rs-btn { min-height: 40px; }
    .rs-seat { min-height: 48px; }
  }
  /* A phone on its side: the countdown smaller; the results fit the short height. */
  @media (max-height: 520px) {
    .rs-count { font-size: 68px; top: 48%; }
    .rs-results { padding: 10px 14px 10px; width: min(460px, calc(100vw - 24px)); }
    .rs-results .champ { width: 54px; height: 54px; margin-top: -2px; }
    .rs-results h3 { font-size: 18px; }
    .rs-results .sub { margin-bottom: 6px; }
    .rs-results .row { padding: 2px 8px; }
    .rs-results .row .pic { width: 24px; height: 24px; }
    .rs-results .back { margin-top: 6px; }
    .rs-seat { padding: 3px 6px; }
    .rs-seat .pic { width: 32px; height: 32px; }
    .rs-wait { top: calc(var(--rs-safe-t) + 52px); }
  }
`;

/** The seat's second line: the Blobbi a person wears (or what they are), a bot's or an open seat's job, and whether it plays next. */
export function seatLine(s: SeatRow): string {
  const what = s.kind === 'bot' ? 'Plays an empty seat' : s.kind === 'empty' ? 'Bots are off' : s.blobbi ? s.blobbi : s.pubkey ? 'Nostr' : 'Guest';
  return s.kind !== 'empty' && !s.plays ? `${what} · next match` : what;
}

const READY_WORDS: Record<SeatRow['ready'], [string, string]> = {
  ready: ['✓ Ready', 'ready'],
  'not-ready': ['Not ready', 'wait'],
  bot: ['Bot', 'bot'],
  open: ['Open', ''],
  none: ['', ''],
};

export function createLobbyUi(a: LobbyUiActions, deps: LobbyUiDeps) {
  const bar = el('div', 'rs-roombar');
  const count = el('div', 'rs-count');
  count.setAttribute('aria-live', 'assertive');
  const results = el('div', 'rs-card rs-results');
  results.setAttribute('role', 'dialog');
  results.setAttribute('aria-label', 'Match results');
  const wait = el('div', 'rs-wait', 'Waiting for next match');
  wait.setAttribute('role', 'status');
  for (const e of [bar, count, results, wait]) e.style.display = 'none';
  let lastBar = '';
  let lastResults = '';
  let lastCount = '';
  /** Pictures already drawn, by look, so a rebuild shows them at once. */
  const pictures = new Map<string, string | null>();

  const picture = (look: RumbleLook, cls = 'pic') => {
    const box = el('span', cls);
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
  const lookOf = (v: LobbyView, seat: string) => v.seats.find((s) => s.seat === seat)?.look ?? deps.defaultLook(seat);

  const seatRow = (s: SeatRow) => {
    const row = el('div', `rs-seat${s.you ? ' you' : ''}${s.kind === 'empty' ? ' empty' : ''}`);
    const who = el('span', 'who');
    who.append(el('b', undefined, s.name), el('span', undefined, seatLine(s)));
    const tags = el('span', 'tags');
    if (s.you) tags.append(el('span', 'rs-pill you', 'You'));
    if (s.owner) tags.append(el('span', 'rs-pill own', '★ Owner'));
    const [words, tone] = READY_WORDS[s.ready];
    if (words) tags.append(el('span', `rs-pill${tone ? ` ${tone}` : ''}`, words));
    row.append(s.kind === 'empty' ? el('span', 'pic') : picture(s.look ?? deps.defaultLook(s.seat)), who, tags);
    row.title = s.seat;
    return row;
  };

  /** A two-way switch: the current value lit; the owner's to change, or shown only. */
  const seg = (label: string, on: boolean, editable: boolean, set: (v: boolean) => void) => {
    const box = el('span', 'rs-seg');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', label);
    for (const v of [true, false]) {
      const b = button(v ? 'On' : 'Off', () => v !== on && set(v), `rs-btn${v === on ? ' on' : ''}`);
      b.setAttribute('aria-pressed', String(v === on));
      b.disabled = !editable;
      box.append(b);
    }
    return box;
  };

  const startButton = (v: LobbyView, cls = 'rs-btn go') => {
    const b = button(`▶ ${v.start.label}`, a.start, cls);
    b.disabled = v.start.disabled;
    if (v.start.reason) b.title = v.start.reason;
    return b;
  };

  const renderBar = (i: LobbyUiInput) => {
    const v = i.view;
    const out: HTMLElement[] = [];
    if (v.ready.shown) {
      const b = button(v.ready.next ? 'Ready' : 'Not ready', () => a.ready(v.ready.next), `rs-btn ready ${v.ready.next ? 'go' : 'on'}`);
      b.setAttribute('aria-pressed', String(!v.ready.next));
      if (!i.touch) {
        b.append(el('kbd', undefined, 'R'));
        b.setAttribute('aria-keyshortcuts', 'R');
      }
      out.push(b);
    }
    if (v.start.shown) out.push(startButton(v, 'rs-btn go start'));
    const inv = button('✉', () => a.openRoom('invite'), 'rs-btn icon invite');
    inv.title = 'Invite friends';
    inv.setAttribute('aria-label', 'Invite friends');
    out.push(inv);
    bar.replaceChildren(...out);
  };

  const renderResults = (i: LobbyUiInput) => {
    const v = i.view;
    const r = v.results!;
    const winner = r.rows.find((x) => x.winner);
    const head: Node[] = [];
    if (winner && winner.kind !== 'empty') head.push(el('div', 'crown', '👑'), picture(lookOf(v, winner.id), 'champ'));
    const rows = r.rows.map((x, n) => {
      const row = el('div', `row${x.winner ? ' win' : ''}${x.you ? ' me' : ''}`);
      const tone = x.kind === 'bot' ? ' bot' : x.kind === 'empty' ? ' left' : ' ready';
      row.append(el('span', 'rank', x.winner ? '🏆' : String(n + 1)), x.kind === 'empty' ? el('span', 'pic') : picture(lookOf(v, x.id)), el('b', undefined, `${x.name}${x.you ? ' (you)' : ''}`), el('span', `rs-pill${tone}`, x.label), el('span', 'sc', `${'●'.repeat(Math.min(x.score, ROUND.target))}${'○'.repeat(Math.max(0, ROUND.target - x.score))}`));
      row.title = `${x.id}: ${x.score}`;
      row.setAttribute('aria-label', `${x.name}${x.you ? ' (you)' : ''}, ${x.label}, ${x.score} point${x.score === 1 ? '' : 's'}${x.winner ? ', winner' : ''}`);
      return row;
    });
    const back = el('div', 'back', `Back to the plaza in ${r.back} s`);
    const barBox = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, r.back / LIFECYCLE.resultsSeconds)) * 100)}%`;
    barBox.append(fill);
    back.append(barBox);
    results.replaceChildren(...head, el('h3', undefined, r.title), el('div', 'sub', r.subtitle), ...rows, back);
  };

  return {
    /** The elements, for the shell to place: the room bar goes beside the place pill. */
    nodes: [count, results, wait] as const,
    bar,
    get resultsOpen() {
      return results.style.display === 'block';
    },
    /** The roster, for the room sheet: every seat, then who waits for the next match. */
    seats: (rows: SeatRow[]): Node[] => rows.map(seatRow),
    players(v: LobbyView): Node[] {
      const out: Node[] = v.seats.map(seatRow);
      if (v.watchers.length) out.push(el('div', 'rs-sec', `Waiting for next match (${v.watchers.length})`), el('div', 'rs-sub', v.watchers.map((w) => w.name).join(' · ')));
      if (v.watching) out.push(el('div', 'rs-note', 'You are watching: you get a seat in the next lobby with one free.'));
      if (v.last) out.push(el('div', 'rs-note', v.last));
      return out;
    },
    /** The room's settings, for the room sheet: the owner's to change in the lobby, everyone's to see. */
    settings(v: LobbyView): Node[] {
      const s = v.settings;
      const out: Node[] = [el('div', 'rs-sec', 'Arena')];
      if (s.editable) {
        const grid = el('div', 'rs-arenas');
        for (const ar of v.arenas) {
          const b = button(ar.name, () => ar.id !== s.arena && a.settings({ arena: ar.id }), `rs-btn${ar.id === s.arena ? ' on' : ''}`);
          b.setAttribute('aria-pressed', String(ar.id === s.arena));
          b.title = ar.name;
          grid.append(b);
        }
        out.push(grid);
      } else out.push(el('div', 'rs-arena-now', s.arenaName));
      out.push(el('div', 'rs-sec', 'Match'));
      const rot = el('div', 'rs-setrow');
      const rotWords = el('span', undefined, 'Rotate arenas');
      rotWords.append(el('small', undefined, 'A new arena after each match'));
      rot.append(rotWords, seg('Rotate arenas', s.rotate, s.editable, (r) => a.settings({ rotate: r })));
      const bots = el('div', 'rs-setrow');
      const botWords = el('span', undefined, 'Bots');
      botWords.append(el('small', undefined, 'Bots play the empty seats'));
      bots.append(botWords, seg('Bots', s.bots, s.editable, (b) => a.settings({ bots: b })));
      out.push(rot, bots);
      if (v.start.shown) {
        out.push(startButton(v, 'rs-btn go wide'));
        if (v.start.reason) out.push(el('div', 'rs-note', v.start.reason));
      }
      if (!s.editable) {
        const owner = v.seats.find((x) => x.owner);
        out.push(el('div', 'rs-note', v.mode === 'lobby' || v.mode === 'countdown' ? (owner && !owner.you ? `Only the owner (★ ${owner.name}) can change these.` : 'Settings change between matches.') : 'Settings change between matches.'));
      }
      return out;
    },
    /**
     * Draw what the model says (null: not a lobby room, or another card is up). Rebuilt only when
     * something shown changed.
     */
    show(i: LobbyUiInput | null) {
      const v = i?.view;
      const barOn = !!v && (v.mode === 'lobby' || v.mode === 'countdown');
      const bk = barOn ? JSON.stringify([v!.ready, v!.start, i!.touch]) : '';
      if (bk !== lastBar) {
        lastBar = bk;
        if (barOn) renderBar(i!);
      }
      const bd = barOn ? 'flex' : 'none';
      if (bar.style.display !== bd) bar.style.display = bd;
      const cnt = v && v.countdown !== null ? String(v.countdown) : '';
      if (cnt !== lastCount) {
        lastCount = cnt;
        count.replaceChildren(document.createTextNode(cnt === '0' ? 'GO!' : cnt), el('small', undefined, 'Match starts'));
        count.style.display = cnt ? 'block' : 'none';
      }
      const rk = v?.results ? JSON.stringify([v.results, v.seats.map((s) => s.look)]) : '';
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
