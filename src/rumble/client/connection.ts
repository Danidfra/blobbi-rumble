/**
 * THE CONNECTION, AS A PLAYER SEES IT: a small state machine over what the
 * socket does, and the words for each state. Pure, so the rules (when to
 * retry, what to say) are tested without a browser.
 *
 *   connecting ──open+welcome──► playing (as P1..P4) | watching (all slots taken)
 *        │                            │
 *        └─close, never connected─► failed      └─close / silence─► lost ──retry──► connecting
 *   refused as full ──► full (retrying slowly)
 *
 * A reconnect is a new connection: it gets whatever slot is free, never a
 * promise of the fighter it had (that fighter went to a bot).
 */
export type ConnectionPhase = 'connecting' | 'playing' | 'watching' | 'lost' | 'failed' | 'full';

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

export const initialConnection = (url: string): ConnectionState => ({ phase: 'connecting', url, you: null, everConnected: false, previous: null, attempts: 0, retryAt: 0, note: '', noteUntil: 0 });

export function onWelcome(s: ConnectionState, you: string | null, now: number): ConnectionState {
  const reconnected = s.everConnected;
  const note = reconnected ? (you ? `Reconnected as ${you}${s.previous && s.previous !== you ? ` (a new slot: your ${s.previous} went to a bot)` : ''}` : 'Reconnected: watching (all four slots are taken)') : '';
  return { ...s, phase: you ? 'playing' : 'watching', you, everConnected: true, attempts: 0, note, noteUntil: note ? now + CONNECTION.noteFor : 0 };
}

/** The socket closed (or went silent). `code`/`reason` as the close event gave them. */
export function onClose(s: ConnectionState, code: number, reason: string, now: number): ConnectionState {
  const attempts = s.attempts + 1;
  const full = code === 1013 && /full/i.test(reason);
  const wait = full ? CONNECTION.retryFull : Math.min(CONNECTION.retryMax, CONNECTION.retryBase * 2 ** (attempts - 1));
  const phase: ConnectionPhase = full ? 'full' : s.everConnected ? 'lost' : 'failed';
  return { ...s, phase, previous: s.you ?? s.previous, you: null, attempts, retryAt: now + wait };
}

export const onRetry = (s: ConnectionState): ConnectionState => ({ ...s, phase: 'connecting' });

/** What to show: a headline, a line of detail, and whether to offer a Retry button. Null while simply playing. */
export function describe(s: ConnectionState, now: number): { title: string; detail: string; retry: boolean } | null {
  const inS = Math.max(0, Math.ceil(s.retryAt - now));
  switch (s.phase) {
    case 'connecting':
      return { title: s.everConnected ? 'Reconnecting…' : 'Connecting to the Rumble server…', detail: s.url, retry: false };
    case 'failed':
      return { title: 'Unable to connect to the Rumble server', detail: `Is it running? Trying again in ${inS} s.`, retry: true };
    case 'lost':
      return { title: 'Connection lost', detail: `Your Blobbi is now played by a bot. Reconnecting in ${inS} s (you will get a free slot, maybe a different one).`, retry: true };
    case 'full':
      return { title: 'The server is full', detail: `Trying again in ${inS} s.`, retry: true };
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
    default:
      return '○ offline';
  }
}
