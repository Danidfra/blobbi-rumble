/**
 * THE LOBBY, AS THE PAGE SHOWS IT (L3): one pure function from what the
 * server said (the `lobby` message, the roster) to everything the lobby
 * card, the countdown and the results card draw: the seats, who is ready,
 * the owner, the watchers, the settings, which controls this person has and
 * whether they work now, and the results. No DOM, no clock of its own:
 * tested on its own, rendered by `lobbyUi.ts`.
 *
 * It never decides anything. A button it offers is a request the server
 * may refuse; a control it disables is one the server would refuse anyway
 * (the owner's settings outside the lobby, a start below the minimum), so
 * the page cannot drift from the server's lifecycle: every frame is drawn
 * again from the server's latest word.
 */
import { ARENAS, arenaById } from '../arena/arenas';
import type { LobbyMessage, MatchResults, SlotIdentity } from '../net/protocol';
import { ROUND } from '../tuning';
import { lookFromSlotForm, type RumbleLook } from './rumbleForm';

/** What a seat is: a person, a bot (bots on), or nobody (bots off). */
export type SeatKind = 'person' | 'bot' | 'empty';

export interface SeatRow {
  seat: string;
  kind: SeatKind;
  /** A person's name (their profile's, else "Guest"), "Bot", or "Open seat". */
  name: string;
  /** A proven person's pubkey (for the avatar), else null. */
  pubkey: string | null;
  you: boolean;
  owner: boolean;
  /** A person ready or not; a bot always is; an empty seat waits for someone. */
  ready: 'ready' | 'not-ready' | 'bot' | 'open';
  /** The Blobbi this person's fighter wears (its name), if any. */
  blobbi: string | null;
  /** What the fighter looks like (its form's look; null: the seat's default fighter, by `seat`). */
  look: RumbleLook | null;
  /** Whether this seat plays the next match (in the lineup). */
  plays: boolean;
}

export interface ResultRow {
  id: string;
  name: string;
  kind: SeatKind;
  /** "Human", "Bot", or "Left" (a person who left a match without bots). */
  label: string;
  score: number;
  winner: boolean;
  you: boolean;
}

export interface ResultsView {
  title: string;
  subtitle: string;
  rows: ResultRow[];
  /** Whole seconds until the room is back in its lobby. */
  back: number;
}

export interface Control {
  shown: boolean;
  disabled: boolean;
  label: string;
  /** Why it is disabled (shown beside it), if it is. */
  reason?: string;
}

export interface LobbyView {
  /** What to draw: the lobby card (lobby, countdown), the results card, only the "waiting" chip (watching a match), or nothing (playing). */
  mode: 'lobby' | 'countdown' | 'results' | 'waiting' | 'hidden';
  status: string;
  /** Whole seconds left in the countdown (null outside it). */
  countdown: number | null;
  seats: SeatRow[];
  watchers: { name: string; pubkey: string | null }[];
  /** This connection watches (it gets a seat in the next lobby with one free). */
  watching: boolean;
  settings: { bots: boolean; arena: string; arenaName: string; rotate: boolean; editable: boolean };
  arenas: { id: string; name: string }[];
  ready: Control & { next: boolean };
  start: Control;
  /** The last match, in one line, while the lobby shows (null: none yet). */
  last: string | null;
  results: ResultsView | null;
}

export interface LobbyViewInput {
  lobby: LobbyMessage;
  roster: Record<string, SlotIdentity> | null;
  /** The newest state's tick, and the rate, for the seconds left. */
  tick: number;
  tickHz: number;
  /** A proven person's display name. */
  personName: (pubkey: string) => string;
  /** The Blobbi a seat's fighter wears, by name. */
  blobbiNameOf: (seat: string) => string | null;
  /** Keyboard hints in the labels (a desktop page). */
  keys: boolean;
}

const secondsUntil = (until: number, tick: number, tickHz: number) => Math.max(0, Math.ceil((until - tick) / tickHz));

/** A person's name from what the server vouches for: their profile's, else "Guest". */
function whoName(who: SlotIdentity, personName: (pk: string) => string): string {
  if (who.who === 'nostr') return personName(who.pubkey);
  if (who.who === 'guest') return 'Guest';
  if (who.who === 'bot') return 'Bot';
  return 'Open seat';
}

function seatKind(who: SlotIdentity | undefined, bots: boolean): SeatKind {
  if (!who || who.who === 'empty') return 'empty';
  if (who.who === 'bot') return bots ? 'bot' : 'empty';
  return 'person';
}

export function lobbyView(input: LobbyViewInput): LobbyView {
  const { lobby: l, tick, tickHz, personName } = input;
  const seats: SeatRow[] = Object.entries(input.roster ?? {}).map(([seat, who]) => {
    const kind = seatKind(who, l.settings.bots);
    const form = kind === 'person' && who.who === 'nostr' && who.form ? lookFromSlotForm(who.form) : null;
    return {
      seat,
      kind,
      name: kind === 'empty' ? 'Open seat' : whoName(who, personName),
      pubkey: who.who === 'nostr' ? who.pubkey : null,
      you: seat === l.you,
      owner: seat === l.owner,
      ready: kind === 'bot' ? 'bot' : kind === 'empty' ? 'open' : l.ready.includes(seat) ? 'ready' : 'not-ready',
      blobbi: kind === 'person' ? input.blobbiNameOf(seat) : null,
      look: form?.look ?? null,
      plays: l.lineup.includes(seat),
    };
  });
  const watching = l.you === null;
  const people = l.seated.length;
  const arriving = !!l.transition && l.transition.kind === 'toLobby' && tick < l.transition.arriveBy;
  const lobbyish = l.phase === 'lobby' || l.phase === 'countdown';
  const allReady = people > 0 && l.ready.length >= people;
  const key = (k: string) => (input.keys ? ` (${k})` : '');

  let status: string;
  if (l.phase === 'lobby') {
    if (!l.canStart) status = l.settings.bots ? 'Waiting for a player to join' : `${l.need} players needed to start (bots are off)`;
    else if (allReady) status = arriving ? 'Everyone is ready: starting in a moment' : 'Everyone is ready: starting';
    else status = `${l.ready.length} of ${people} ready · starts when everyone is ready`;
  } else if (l.phase === 'countdown') status = l.forced ? 'The owner started the match' : 'Everyone is ready';
  else if (l.phase === 'results') status = 'Match over';
  else status = watching ? 'Waiting for next match' : '';

  const mode: LobbyView['mode'] = l.phase === 'lobby' ? 'lobby' : l.phase === 'countdown' ? 'countdown' : l.phase === 'results' ? 'results' : watching ? 'waiting' : 'hidden';
  const mine = l.you !== null && l.ready.includes(l.you);
  // Ready: a seated person, in the lobby, and in a countdown that everyone's readiness started (being unready cancels it).
  const readyShown = !watching && (l.phase === 'lobby' || (l.phase === 'countdown' && !l.forced));
  const ready = { shown: readyShown, disabled: false, next: !mine, label: `${mine ? 'Not ready' : 'Ready'}${key('R')}` };
  const startReason = !l.canStart ? (l.settings.bots ? 'A player is needed' : `${l.need} players needed`) : arriving ? 'Back in a moment' : undefined;
  const start = { shown: l.youOwn && l.phase === 'lobby', disabled: !!startReason, label: allReady ? 'Start' : 'Start now', ...(startReason ? { reason: startReason } : {}) };
  const arena = arenaById(l.settings.arena);
  return {
    mode,
    status,
    countdown: l.phase === 'countdown' ? secondsUntil(l.deadline ?? tick, tick, tickHz) : null,
    seats,
    watchers: l.watchers.map((w) => ({ name: whoName(w, personName), pubkey: w.who === 'nostr' ? w.pubkey : null })),
    watching,
    settings: { bots: l.settings.bots, arena: l.settings.arena, arenaName: arena?.name ?? l.settings.arena, rotate: l.settings.rotate, editable: l.youOwn && l.phase === 'lobby' },
    arenas: ARENAS.map((a) => ({ id: a.id, name: a.name })),
    ready,
    start,
    last: lobbyish && l.results ? lastLine(l.results, personName) : null,
    results: l.phase === 'results' && l.results ? resultsView(l.results, l.you, secondsUntil(l.deadline ?? tick, tick, tickHz), personName) : null,
  };
}

/** A fighter's name in the results: who drove it at the end. */
function resultName(who: SlotIdentity, personName: (pk: string) => string) {
  return who.who === 'empty' ? 'Left the match' : whoName(who, personName);
}

function resultKind(who: SlotIdentity): SeatKind {
  return who.who === 'bot' ? 'bot' : who.who === 'empty' ? 'empty' : 'person';
}

export function resultsView(r: MatchResults, you: string | null, back: number, personName: (pk: string) => string): ResultsView {
  const rows = r.fighters
    .map((f): ResultRow => {
      const kind = resultKind(f.who);
      return { id: f.id, name: resultName(f.who, personName), kind, label: kind === 'person' ? 'Human' : kind === 'bot' ? 'Bot' : 'Left', score: f.score, winner: f.id === r.winner, you: f.id === you };
    })
    .sort((a, b) => Number(b.winner) - Number(a.winner) || b.score - a.score);
  const winner = rows.find((x) => x.winner);
  const title = winner ? `${winner.name} wins!` : 'Match abandoned';
  const subtitle = r.reason === 'won' ? `First to ${ROUND.target} rounds` : r.reason === 'forfeit' ? 'Everyone else left the match' : 'Everyone left the match';
  return { title, subtitle, rows, back };
}

function lastLine(r: MatchResults, personName: (pk: string) => string): string {
  const w = r.fighters.find((f) => f.id === r.winner);
  return w ? `Last match: ${resultName(w.who, personName)} won` : 'Last match: abandoned';
}

