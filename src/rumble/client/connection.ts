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
 * A reconnect is a new connection: it gets whatever slot is free, never a
 * promise of the fighter it had (that fighter went to a bot).
 */
export type ConnectionPhase = 'connecting' | 'playing' | 'watching' | 'lost' | 'failed' | 'full' | 'missing' | 'refused' | 'incompatible' | 'rejected';
/** What the banner may offer: try again, go to the open room, make a new room. */
export type BannerAction = 'retry' | 'open' | 'host';

export interface ConnectionState {
  phase: ConnectionPhase;
  url: string;
  you: string | null;
  /** Whether any connection ever got through (decides "lost" versus "failed"). */
  everConnected: boolean;
  /** The slot held before the last loss, for the reconnect note. */
  previous: string | null;
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

export const initialConnection = (url: string, room: string | null = null): ConnectionState => ({ phase: 'connecting', url, you: null, everConnected: false, previous: null, attempts: 0, retryAt: 0, note: '', noteUntil: 0, room, why: '' });

export function onWelcome(s: ConnectionState, you: string | null, now: number): ConnectionState {
  const reconnected = s.everConnected;
  const note = reconnected ? (you ? `Reconnected as ${you}${s.previous && s.previous !== you ? ` (a new slot: your ${s.previous} went to a bot)` : ''}` : 'Reconnected: watching (all four slots are taken)') : '';
  return { ...s, phase: you ? 'playing' : 'watching', you, everConnected: true, attempts: 0, note, noteUntil: note ? now + CONNECTION.noteFor : 0 };
}

/** The socket closed (or went silent). `code`/`reason` as the close event gave them. */
export function onClose(s: ConnectionState, code: number, reason: string, now: number): ConnectionState {
  s = { ...s, why: reason };
  const attempts = s.attempts + 1;
  if (code === 4004) return { ...s, phase: 'missing', you: null, attempts, retryAt: Infinity, why: reason };
  if (code === 4003) return { ...s, phase: 'refused', you: null, attempts, retryAt: Infinity, why: reason };
  // M10: the server would not have this page (its origin, or a policy): no retry; the player picks another server.
  if (code === 4005 || code === 1008) return { ...s, phase: 'rejected', you: null, attempts, retryAt: Infinity, why: reason };
  if (s.phase === 'incompatible') return { ...s, you: null, attempts, retryAt: Infinity };
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

/** What to show: a headline, a line of detail, and what to offer. Null while simply playing. */
export function describe(s: ConnectionState, now: number): { title: string; detail: string; retry: boolean; actions: BannerAction[] } | null {
  const inS = Math.max(0, Math.ceil(s.retryAt - now));
  const room = s.room ? `Room ${s.room}` : 'That room';
  switch (s.phase) {
    case 'connecting':
      return { title: s.everConnected ? 'Reconnecting…' : 'Connecting to the Rumble server…', detail: s.url.replace(/\?.*$/, ''), retry: false, actions: [] };
    case 'failed':
      return { title: 'Unable to connect to the Rumble server', detail: `Is it running? Trying again in ${inS} s.`, retry: true, actions: ['retry'] };
    case 'lost':
      return { title: 'Connection lost', detail: `Your Blobbi is now played by a bot. Reconnecting in ${inS} s (you will get a free slot, maybe a different one).`, retry: true, actions: ['retry'] };
    case 'full':
      return { title: /room/i.test(s.why) ? `${room} is full` : 'The server is full', detail: `Trying again in ${inS} s.`, retry: true, actions: ['retry', 'open'] };
    case 'missing':
      return { title: `${room} isn’t here`, detail: 'It may have ended (empty rooms close after a couple of minutes), or the code is mistyped.', retry: false, actions: ['open', 'host'] };
    case 'refused':
      return { title: 'Couldn’t start a new game', detail: /minute/.test(s.why) ? 'Too many new games from here: wait a minute and try again.' : 'This server is hosting as many games as it can right now.', retry: false, actions: ['open', 'retry'] };
    case 'incompatible':
      return { title: 'This server speaks a newer Rumble', detail: 'Update the game (reload a newer page) or pick another server in the session panel.', retry: false, actions: ['retry'] };
    case 'rejected':
      return { title: 'This server turned this page away', detail: /origin/i.test(s.why) ? 'It does not accept connections from this site. Pick another server in the session panel.' : `It refused the connection${s.why ? ` (${s.why})` : ''}. Pick another server in the session panel.`, retry: false, actions: ['retry'] };
    default:
      return null;
  }
}

/** The small always-visible status line. */
export function statusLine(s: ConnectionState, rttMs: number): string {
  const rtt = Number.isFinite(rttMs) ? ` · ${Math.round(rttMs)} ms` : '';
  switch (s.phase) {
    case 'playing':
      return `● online · you are ${s.you}${rtt}`;
    case 'watching':
      return `● online · watching (all four slots taken)${rtt}`;
    case 'connecting':
      return '○ connecting…';
    case 'full':
      return '○ server full';
    case 'incompatible':
      return '○ incompatible server';
    case 'rejected':
      return '○ server refused this page';
    default:
      return '○ offline';
  }
}
