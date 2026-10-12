/**
 * WHERE THE PLAYER IS, AND WHAT THE CORNER SAYS ABOUT IT (L4.2). One pure
 * reading of the page's state into one of the interface's contexts, and
 * the words of the small place pill in the top left corner. The shell
 * draws only what the context needs:
 *
 *   menu     nothing connected: the menu, the profile and settings buttons
 *   plaza    the public plaza: its name and how many are there; the plaza
 *            menu on demand. No ready, start, owner, rotation or scores.
 *   room     a private room between matches (its own plaza, the countdown,
 *            the results): the code, players and ready counts, Ready, the
 *            owner's Start, Invite; the roster, settings and invitations on
 *            demand
 *   combat   a match on (a private room's, or Quick Match): the scoreboard
 *            and the match's own messages; the room only as its name
 *   away     connecting, lost or refused: the banner speaks; the pill keeps
 *            the room's name
 *
 * No DOM; tested on its own.
 */
import type { LobbyMessage, RoomInfo, SlotIdentity } from '../net/protocol';

export type UiContext = 'menu' | 'plaza' | 'room' | 'combat' | 'away';

export interface HudInput {
  /** The menu is up (nothing connected). */
  menu: boolean;
  /** Connected and in a room (playing or watching). */
  healthy: boolean;
  room: Pick<RoomInfo, 'id' | 'kind'> | null;
  /** The room asked for while not connected (its code, PLAZA, OPEN), for the pill while away. */
  asked: string | null;
  lobby: LobbyMessage | null;
  roster: Record<string, SlotIdentity> | null;
}

export interface HudView {
  context: UiContext;
  /** A small glyph, the place's name, and its counts (each short: "3/8", "1/2 ready"). */
  icon: string;
  name: string;
  counts: string[];
  /** The pill's words for a screen reader: the place, the counts in full, and what pressing it does. */
  label: string;
}

export function uiContext(i: HudInput): UiContext {
  if (i.menu) return 'menu';
  if (!i.healthy) return 'away';
  if (i.room?.kind === 'plaza') return 'plaza';
  if (i.room?.kind === 'private' && i.lobby && i.lobby.phase !== 'playing') return 'room';
  return 'combat';
}

const people = (roster: Record<string, SlotIdentity> | null) => Object.values(roster ?? {}).filter((x) => x.who === 'guest' || x.who === 'nostr').length;

export function hudView(i: HudInput): HudView {
  const context = uiContext(i);
  const seats = Object.keys(i.roster ?? {}).length;
  switch (context) {
    case 'menu':
      return { context, icon: '', name: '', counts: [], label: '' };
    case 'plaza': {
      const here = people(i.roster);
      const cap = seats || 8;
      return { context, icon: '🌸', name: 'Blobbi Plaza', counts: [`${here}/${cap}`], label: `Blobbi Plaza, ${here} of ${cap} here. Open the plaza menu` };
    }
    case 'room': {
      const l = i.lobby!;
      const seated = l.seated.length;
      const ready = l.ready.length;
      // Readiness counts while it can start a match (the lobby, the countdown); the results have their own card.
      const readying = l.phase === 'lobby' || l.phase === 'countdown';
      return { context, icon: '🔑', name: i.room!.id, counts: [`${seated}/${seats}`, ...(readying ? [`${ready}/${seated} ready`] : [])], label: `Room ${i.room!.id}, ${seated} of ${seats} players${readying ? `, ${ready} of ${seated} ready` : ''}. Open the room` };
    }
    case 'combat': {
      const quick = i.room?.kind !== 'private';
      const name = quick ? 'Quick Match' : i.room!.id;
      return { context, icon: quick ? '⚡' : '🔑', name, counts: [], label: `${quick ? 'Quick Match' : `Room ${name}`}. Open the room` };
    }
    case 'away': {
      const name = i.room ? (i.room.kind === 'plaza' ? 'Blobbi Plaza' : i.room.kind === 'open' ? 'Quick Match' : i.room.id) : i.asked === 'PLAZA' ? 'Blobbi Plaza' : i.asked === 'OPEN' ? 'Quick Match' : (i.asked ?? 'New room');
      return { context, icon: '…', name, counts: [], label: `${name}, not connected` };
    }
  }
}
