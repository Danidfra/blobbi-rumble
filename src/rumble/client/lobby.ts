/**
 * A LOBBY ROOM, AS THIS PAGE READS IT (L1-L3): the server's `lobby` message
 * (its lifecycle, `net/lifecycle.ts`) turned into what the page's match
 * view needs: whether it is live, which fighters to draw, what a refusal
 * means. Pure. The server decides every stage; nothing here changes one.
 * The lobby's interface is `lobbyView.ts` (what) and `lobbyUi.ts` (how).
 */
import type { LobbyCommand, LobbyMessage, LobbyRefusalReason } from '../net/protocol';
import type { MatchSnapshot } from '../sim/snapshot';

/** Whether the match is live for this page's prediction and input: always in a continuous room, only in play in a lobby room. */
export const lifecyclePlays = (lobby: LobbyMessage | null) => !lobby || lobby.phase === 'playing';

/**
 * L3: the fighters to draw in a lobby room before its match: only the next
 * match's lineup (the seated people, and the bots if they are on), never a
 * fighter left from the last match. The server shows the lineup itself
 * whenever it can be a match (two or more); this keeps the page right when
 * it cannot (one person alone, bots off) and for the instant before the
 * server's new lineup arrives. In play, the results, or a continuous room,
 * the snapshot is drawn as it is.
 */
export function visibleLineup(s: MatchSnapshot, lobby: LobbyMessage | null): MatchSnapshot {
  if (!lobby || (lobby.phase !== 'lobby' && lobby.phase !== 'countdown')) return s;
  const keep = s.players.map((id) => lobby.lineup.includes(id));
  if (keep.every(Boolean)) return s;
  return { ...s, players: s.players.filter((_, i) => keep[i]), fighters: s.fighters.filter((_, i) => keep[i]) };
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
