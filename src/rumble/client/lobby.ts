/**
 * A LOBBY ROOM, AS THIS PAGE READS IT (L1): the server's `lobby` message
 * (its lifecycle, `net/lifecycle.ts`) turned into what the page needs to
 * know. Pure. The server decides every stage; nothing here changes one.
 *
 * Until the lobby's own interface (L3), the stage is one line of the
 * contextual message: waiting, the countdown, the results.
 */
import type { LobbyMessage } from '../net/protocol';

/** Whether the match is live for this page's prediction and input: always in a continuous room, only in play in a lobby room. */
export const lifecyclePlays = (lobby: LobbyMessage | null) => !lobby || lobby.phase === 'playing';

/** Whole seconds from `tick` until `until` (never below zero). */
export const secondsUntil = (until: number, tick: number, tickHz: number) => Math.max(0, Math.ceil((until - tick) / tickHz));

/** The stage in one line (null while playing: the match's own messages speak then). */
export function lobbyLine(l: LobbyMessage | null, tick: number, tickHz: number, nameOf: (id: string) => string = (id) => id): string | null {
  if (!l) return null;
  switch (l.phase) {
    case 'lobby':
      if (!l.canStart) return `LOBBY · waiting for players (${l.need} needed${l.settings.bots ? '' : ', bots off'})`;
      return 'LOBBY · the match is about to start';
    case 'countdown':
      return `MATCH STARTS IN ${secondsUntil(l.deadline ?? tick, tick, tickHz)}`;
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
