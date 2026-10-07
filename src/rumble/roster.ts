/**
 * WHO PLAYS: the roster of fighters, as data. Each entry is a label, a
 * deterministic Blobbi identity, and what drives it: a person's keys (P1
 * and P2 share the keyboard) or a local test bot. Every entry gets the same
 * gameplay body; the identity only decides how it looks.
 *
 * The default is four: P1 and P2 at the keyboard, P3 and P4 test bots.
 * `?players=2|3|4` plays fewer; `?bots=all` hands P1 and P2 to bots too
 * (a bot-only arena, for watching and for scripted checks).
 */
import type { FighterCount } from './arena/layout';
import { P1_BINDINGS, P2_BINDINGS, type KeyBindings } from './control/input';

export interface RosterEntry {
  label: string;
  /** The label the Blobbi's seed is derived from (`seedFromLabel`). */
  identity: string;
  /** Keys for a person, or null for a test bot. */
  keys: KeyBindings | null;
}

/** Four visibly different individuals: yellow with ears, pink with horns and antennae, blue with side horns and a leaf tail, lime with top horns. */
export const ROSTER: readonly RosterEntry[] = [
  { label: 'P1', identity: 'abc123', keys: P1_BINDINGS },
  { label: 'P2', identity: 'blobbi-1', keys: P2_BINDINGS },
  { label: 'P3', identity: 'blobbi-0', keys: null },
  { label: 'P4', identity: 'pattern-1', keys: null },
];

export interface RosterOptions {
  count: FighterCount;
  /** Every fighter a bot, the keyboard's too. */
  allBots: boolean;
}

/** Read the roster options from a query string: four by default, the people at the keyboard by default. */
export function rosterOptions(search: string): RosterOptions {
  const q = new URLSearchParams(search);
  const n = Number(q.get('players'));
  const count: FighterCount = n === 2 || n === 3 || n === 4 ? n : 4;
  return { count, allBots: q.get('bots') === 'all' };
}

/** The entries that play. */
export function rosterFor(o: RosterOptions): RosterEntry[] {
  return ROSTER.slice(0, o.count).map((e) => (o.allBots ? { ...e, keys: null } : e));
}
