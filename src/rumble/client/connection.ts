/**
 * THE CONNECTION, AS A PLAYER SEES IT: a small state machine over what the
 * socket does, and the words for each state. Pure, so the rules (when to
 * retry, what to say) are tested without a browser.
 *
 *   connecting ──open+welcome──► playing (as P1..P4) | watching (all slots taken)
 *        │                            │
 *        └─close, never connected─► failed      └─close / silence─► lost ──retry──► connecting
 *   refused as full ──► full (retrying slowly)
 *   the room asked for does not exist ──► missing (no retry: the page offers the open room or a new one)
 *   no new room can be made now ──► refused (no retry)
 *
 * L4.1: `idle` is the menu (nothing connected, nothing to say), and the
 * public plaza being full is its own refusal: said plainly, with another
 * room or Quick Match offered, never retried by itself and never turned
 * into a match.
 *
 * A reconnect is a new connection: it gets whatever slot is free, never a
 * promise of the fighter it had. L4.2: whether a bot plays that fighter
 * meanwhile is the room's to say (the open room and a room with bots on:
 * yes; the plaza and a room with bots off: no), so the words never claim
 * a bot that is not there. Every refusal also offers the way back to the
 * menu: no state traps the player.
 */
export type ConnectionPhase = 'idle' | 'connecting' | 'playing' | 'watching' | 'lost' | 'failed' | 'full' | 'plazaFull' | 'missing' | 'refused' | 'incompatible' | 'rejected';
/** What the banner may offer: try again, go to the open room, make a new room; L4.1: Quick Match, a private room. */
export type BannerAction = 'retry' | 'open' | 'host' | 'quick' | 'private' | 'menu';

export interface ConnectionState {
  phase: ConnectionPhase;
  url: string;
  you: string | null;
  /** Whether any connection ever got through (decides "lost" versus "failed"). */
  everConnected: boolean;
  /** The slot held before the last loss, for the reconnect note. */
  previous: string | null;
  /** L4.2: whether a bot plays that slot's fighter while this page is away (the room's rule, given at the loss). */
  takeover: boolean;
  attempts: number;
  /** Client seconds of the next automatic try, while lost, failed or full. */
  retryAt: number;
  /** A short note shown for a while after a reconnect, and until when. */
  note: string;
  noteUntil: number;
  /** The room asked for (for the words when it is missing), and why a refusal happened. */
  room: string | null;
  why: string;
}

export const CONNECTION = Object.freeze({
  /** Retries back off 1, 2, 4, 8 s, then every 8 s; a full server is tried every 10 s. */
  retryBase: 1,
  retryMax: 8,
  retryFull: 10,
  /** No state from the server for this long while connected: treat the connection as lost. */
  silence: 4,
  noteFor: 6,
});

/** L4.1: the menu: no connection at all (nothing to show but the menu). */
export const idleConnection = (url: string): ConnectionState => ({ ...initialConnection(url), phase: 'idle' });

export const initialConnection = (url: string, room: string | null = null): ConnectionState => ({ phase: 'connecting', url, you: null, everConnected: false, previous: null, takeover: false, attempts: 0, retryAt: 0, note: '', noteUntil: 0, room, why: '' });

/** What watching means: in a lobby room (L3) waiting for the next match; in a continuous room, all four slots are taken. */
export const watchingWords = (lobbyRoom: boolean) => (lobbyRoom ? 'waiting for next match' : 'watching (all four slots taken)');

export function onWelcome(s: ConnectionState, you: string | null, now: number, lobbyRoom = false): ConnectionState {
  const reconnected = s.everConnected;
  const note = reconnected ? (you ? `Reconnected as ${you}${s.previous && s.previous !== you ? ` (a new slot: your ${s.previous} ${s.takeover ? 'went to a bot' : 'was let go'})` : ''}` : `Reconnected: ${watchingWords(lobbyRoom)}`) : '';
  return { ...s, phase: you ? 'playing' : 'watching', you, everConnected: true, attempts: 0, note, noteUntil: note ? now + CONNECTION.noteFor : 0 };
}

/** L1: a lobby room gave this connection a seat, or took it back to watching, between matches. */
export function onSeat(s: ConnectionState, you: string | null): ConnectionState {
  if (s.phase !== 'playing' && s.phase !== 'watching') return s;
  return { ...s, phase: you ? 'playing' : 'watching', you };
}

/**
 * The socket closed (or went silent). `code`/`reason` as the close event gave them; `takeover`: whether the
 * room hands a held fighter to a bot meanwhile (L4.2: said only when it is so).
 */
export function onClose(s: ConnectionState, code: number, reason: string, now: number, takeover = false): ConnectionState {
  s = { ...s, why: reason, takeover: !!s.you && takeover };
  const attempts = s.attempts + 1;
  if (code === 4004) return { ...s, phase: 'missing', you: null, attempts, retryAt: Infinity, why: reason };
  if (code === 4003) return { ...s, phase: 'refused', you: null, attempts, retryAt: Infinity, why: reason };
  // M10: the server would not have this page (its origin, or a policy): no retry; the player picks another server.
  if (code === 4005 || code === 1008) return { ...s, phase: 'rejected', you: null, attempts, retryAt: Infinity, why: reason };
  if (s.phase === 'incompatible') return { ...s, you: null, attempts, retryAt: Infinity };
  // L4.1: the plaza is full: no retry by itself (the player chooses: try again, another room, Quick Match).
  if (code === 1013 && /plaza full/i.test(reason)) return { ...s, phase: 'plazaFull', you: null, attempts, retryAt: Infinity };
  const full = code === 1013 && /full/i.test(reason);
  const wait = full ? CONNECTION.retryFull : Math.min(CONNECTION.retryMax, CONNECTION.retryBase * 2 ** (attempts - 1));
  const phase: ConnectionPhase = full ? 'full' : s.everConnected ? 'lost' : 'failed';
  return { ...s, phase, previous: s.you ?? s.previous, you: null, attempts, retryAt: now + wait };
}

export const onRetry = (s: ConnectionState): ConnectionState => ({ ...s, phase: 'connecting' });

/**
 * M10A: the welcome said which protocol the server speaks. A number this
 * build does not know (newer) is incompatible: the page does not pretend to
 * play, and does not retry. Absent means a pre-M10 server, which still plays.
 */
export function onProtocol(s: ConnectionState, serverVersion: number | undefined, mine: number): ConnectionState {
  const v = serverVersion ?? 0;
  if (Number.isSafeInteger(v) && v <= mine) return s;
  return { ...s, phase: 'incompatible', you: null, retryAt: Infinity, why: `protocol ${String(serverVersion)}` };
}

/** What the banner shows: a picture word (`icon`: a small glyph, or 'wait' for the spinner), a headline, a line of detail, and what to offer. */
export interface Words {
  icon: string;
  title: string;
  detail: string;
  retry: boolean;
  actions: BannerAction[];
}

/** Where a connection is headed, as the player chose it (L4.2: the plaza, Quick Match, a room by its code). */
function heading(s: ConnectionState): string {
  if (s.everConnected) return 'Reconnecting…';
  if (s.room === 'PLAZA') return 'Heading to Blobbi Plaza…';
  if (s.room === 'OPEN') return 'Finding a Quick Match…';
  if (s.room) return `Joining room ${s.room}…`;
  return 'Connecting…';
}

/** What to show: a headline, a line of detail, and what to offer. Null while simply playing. */
export function describe(s: ConnectionState, now: number): Words | null {
  const inS = Math.max(0, Math.ceil(s.retryAt - now));
  const room = s.room ? `Room ${s.room}` : 'That room';
  switch (s.phase) {
    case 'plazaFull':
      return { icon: '🌸', title: 'Blobbi Plaza is full.', detail: 'Eight Blobbis are there already. Try again in a moment, make a private room for your friends, or jump into a Quick Match.', retry: false, actions: ['retry', 'private', 'quick', 'menu'] };
    case 'connecting':
      return { icon: 'wait', title: heading(s), detail: s.everConnected ? 'Getting you back in.' : 'One moment.', retry: false, actions: s.everConnected || s.attempts ? ['menu'] : [] };
    case 'failed':
      return { icon: '📡', title: 'Can’t reach the game server', detail: `It may be offline or restarting. Trying again in ${inS} s.`, retry: true, actions: ['retry', 'menu'] };
    case 'lost':
      return { icon: '🔌', title: 'Connection lost', detail: s.takeover ? `A bot plays your Blobbi until you’re back. Reconnecting in ${inS} s (you may get a different seat).` : `Reconnecting in ${inS} s.`, retry: true, actions: ['retry', 'menu'] };
    case 'full':
      // Security audit H1: one network (household, school, office) holds only so many connections.
      if (/network/i.test(s.why)) return { icon: '🏠', title: 'Too many connections from your network', detail: `Someone on the same network (or another tab of yours) already holds as many as this server allows. Trying again in ${inS} s.`, retry: true, actions: ['retry', 'open', 'menu'] };
      return { icon: '🚪', title: /room/i.test(s.why) ? `${room} is full` : 'The server is full', detail: `Trying again in ${inS} s.`, retry: true, actions: ['retry', 'open', 'menu'] };
    case 'missing':
      return { icon: '🔍', title: `${room} isn’t here`, detail: 'It may have ended (empty rooms close after a couple of minutes), or the code is mistyped.', retry: false, actions: ['open', 'host', 'menu'] };
    case 'refused':
      // Security audit M3, M2: room codes tried in vain from this network, or games it already has open.
      if (/code/.test(s.why)) return { icon: '✋', title: 'Too many room codes tried', detail: 'Wait a minute, then check the code (or the link) and try again.', retry: false, actions: ['open', 'retry', 'menu'] };
      if (/open games/.test(s.why)) return { icon: '✋', title: 'Your network already has games open', detail: 'Join one of them by its code or link, or wait a couple of minutes for an empty one to close.', retry: false, actions: ['open', 'retry', 'menu'] };
      return { icon: '✋', title: 'Couldn’t start a new game', detail: /minute/.test(s.why) ? 'Too many new games from here: wait a minute and try again.' : 'This server is hosting as many games as it can right now.', retry: false, actions: ['open', 'retry', 'menu'] };
    case 'incompatible':
      return { icon: '⬆️', title: 'This server runs a newer Blobbi Rumble', detail: 'Reload the page to update the game, or pick another server in Settings.', retry: false, actions: ['retry', 'menu'] };
    case 'rejected':
      // L1: a room this build cannot play (a newer server's room kind).
      if (/update required/i.test(s.why)) return { icon: '⬆️', title: 'This room needs a newer Blobbi Rumble', detail: 'Reload the page to update the game, then join again.', retry: false, actions: ['retry', 'open', 'menu'] };
      return { icon: '🚫', title: 'This server turned this page away', detail: /origin/i.test(s.why) ? 'It does not accept connections from this site. Pick another server in Settings.' : 'It refused the connection. Pick another server in Settings.', retry: false, actions: ['retry', 'menu'] };
    default:
      return null;
  }
}

/** The small always-visible status line (`lobbyRoom`: watching means waiting for the next match). */
export function statusLine(s: ConnectionState, rttMs: number, lobbyRoom = false): string {
  const rtt = Number.isFinite(rttMs) ? ` · ${Math.round(rttMs)} ms` : '';
  switch (s.phase) {
    case 'playing':
      return `● online · you are ${s.you}${rtt}`;
    case 'watching':
      return `● online · ${watchingWords(lobbyRoom)}${rtt}`;
    case 'connecting':
      return '○ connecting…';
    case 'full':
      return '○ server full';
    case 'incompatible':
      return '○ incompatible server';
    case 'idle':
      return '○ not connected';
    case 'plazaFull':
      return '○ plaza full';
    case 'rejected':
      return '○ server refused this page';
    default:
      return '○ offline';
  }
}
