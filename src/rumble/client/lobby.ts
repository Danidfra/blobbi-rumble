/**
 * A LOBBY ROOM, AS THIS PAGE READS IT (L1, L2): the server's `lobby` message
 * (its lifecycle, `net/lifecycle.ts`) turned into what the page needs to
 * know. Pure. The server decides every stage; nothing here changes one.
 *
 * Until the lobby's own interface (L3), the stage is one line of the
 * contextual message (waiting, who is ready, the countdown, the results),
 * and R toggles this person's readiness.
 */
import type { LobbyCommand, LobbyMessage, LobbyRefusalReason } from '../net/protocol';

/** Whether the match is live for this page's prediction and input: always in a continuous room, only in play in a lobby room. */
export const lifecyclePlays = (lobby: LobbyMessage | null) => !lobby || lobby.phase === 'playing';

/** Whole seconds from `tick` until `until` (never below zero). */
export const secondsUntil = (until: number, tick: number, tickHz: number) => Math.max(0, Math.ceil((until - tick) / tickHz));

/** The stage in one line (null while playing in a seat: the match's own messages speak then). */
export function lobbyLine(l: LobbyMessage | null, tick: number, tickHz: number, nameOf: (id: string) => string = (id) => id): string | null {
  if (!l) return null;
  const watching = l.you === null;
  switch (l.phase) {
    case 'lobby': {
      if (watching) return 'LOBBY · watching: every seat is taken';
      if (!l.canStart) return `LOBBY · waiting for players (${l.need} needed${l.settings.bots ? '' : ', bots off'})`;
      const mine = l.ready.includes(l.you!) ? 'you are ready (R: not ready)' : 'R: ready';
      return `LOBBY · ${l.ready.length} of ${l.seated.length} ready · ${mine}`;
    }
    case 'countdown':
      return `MATCH STARTS IN ${secondsUntil(l.deadline ?? tick, tick, tickHz)}${watching ? ' · you are watching this one' : ''}`;
    case 'playing':
      return watching ? 'WATCHING · you play from the next lobby' : null;
    case 'results': {
      const r = l.results;
      const back = `back to the lobby in ${secondsUntil(l.deadline ?? tick, tick, tickHz)} s`;
      if (!r || !r.winner) return `MATCH OVER · ${back}`;
      return `${nameOf(r.winner)} WINS THE MATCH${r.reason === 'forfeit' ? ' (the others left)' : ''} · ${back}`;
    }
    default:
      return null;
  }
}


/** L2: what to say when the server refused a lobby request. */
export function refusalWords(of: LobbyCommand['t'], reason: LobbyRefusalReason): string {
  switch (reason) {
    case 'not-owner':
      return 'Only the room’s owner can do that';
    case 'spectator':
      return 'You are watching: you get a seat in the next lobby';
    case 'too-few':
      return 'Not enough players to start';
    case 'busy':
      return of === 'start' ? 'Wait a moment before starting' : 'Wait a moment';
    case 'phase':
      return of === 'settings' ? 'Settings change only in the lobby' : 'Not now: the match is on';
    case 'no-lobby':
      return 'This room has no lobby';
    default:
      return 'The server did not accept that';
  }
}
