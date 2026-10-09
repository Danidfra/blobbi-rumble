/**
 * PROVING A PUBKEY TO A SERVICE: NIP-42's challenge and response, reused
 * over any WebSocket (here: a game server, not a relay).
 *
 *   server  issues a challenge: 32 random bytes, hex; one per connection,
 *           short-lived, consumed by the first answer (right or wrong)
 *   client  signs a kind-22242 event (nostr-tools `makeAuthEvent`) with
 *           tags ["relay", <the exact URL it connected to>] and
 *           ["challenge", <challenge>]
 *   server  verifies: well-formed, kind 22242, id and signature
 *           (nostr-tools `verifyEvent`), the challenge it issued, its own
 *           URL, created_at near now; then the connection controls that key
 *
 * Replay: a proof names one challenge, which works once and only on the
 * connection it was issued to, for `ttlMs`; and it names the server's URL,
 * so a proof given to one server (a malicious one included) is refused by
 * another. No custom cryptography: hashing and Schnorr signatures are
 * nostr-tools'. Framework-free; no Rumble imports; never touches relays.
 */
import { bytesToHex } from 'nostr-tools/utils';
import { makeAuthEvent } from 'nostr-tools/nip42';
import { validateEvent, verifyEvent, type EventTemplate, type NostrEvent } from 'nostr-tools/pure';
import { isPubkey } from './keys';

export const AUTH_KIND = 22242;

export const AUTH = Object.freeze({
  /** A challenge is good for this long after it is issued, ms. */
  ttlMs: 120_000,
  /** How far a proof's created_at may be from the server's clock, seconds (clocks on players' machines drift). */
  maxSkew: 300,
  /** At most this many challenges outstanding at once, whole server. */
  maxOutstanding: 256,
});

/** The event a client signs to answer a challenge from the server at `url`. */
export const authTemplate = (url: string, challenge: string): EventTemplate => makeAuthEvent(url, challenge);

/**
 * The server's address as the proof must name it: host (and port, unless
 * the default) and path, case-folded. The scheme is left out on purpose:
 * behind a TLS-terminating proxy the server sees http while the client
 * used wss, and the same host and path is the same server.
 */
export function authAddress(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  const port = u.port && !(secure && u.port === '443') && !(!secure && u.port === '80') ? `:${u.port}` : '';
  const path = u.pathname.replace(/\/+/g, '/').replace(/\/$/, '');
  return `${u.hostname.toLowerCase()}${port}${path}`;
}

/** The issued challenges: bounded, expiring, one use each. Keyed by connection. */
export class ChallengeBook {
  private readonly issued = new Map<unknown, { value: string; expires: number }>();

  constructor(
    private readonly opts: { ttlMs?: number; max?: number; now?: () => number; random?: () => string } = {},
  ) {}

  private get now() {
    return (this.opts.now ?? Date.now)();
  }

  get size() {
    return this.issued.size;
  }

  /** A fresh challenge for `key` (replacing any it had), or null when the book is full of live ones. */
  issue(key: unknown): string | null {
    this.sweep();
    this.issued.delete(key);
    if (this.issued.size >= (this.opts.max ?? AUTH.maxOutstanding)) return null;
    const value = (this.opts.random ?? (() => bytesToHex(crypto.getRandomValues(new Uint8Array(32)))))();
    this.issued.set(key, { value, expires: this.now + (this.opts.ttlMs ?? AUTH.ttlMs) });
    return value;
  }

  /** Use `key`'s challenge: it is gone after this whatever happens. 'none' if there was none, 'expired' if too old. */
  take(key: unknown): { value: string } | 'none' | 'expired' {
    const c = this.issued.get(key);
    this.issued.delete(key);
    if (!c) return 'none';
    return this.now > c.expires ? 'expired' : { value: c.value };
  }

  /** Forget `key` (its connection closed). */
  drop(key: unknown) {
    this.issued.delete(key);
  }

  /** Forget every expired challenge. */
  sweep() {
    const t = this.now;
    for (const [k, c] of this.issued) if (t > c.expires) this.issued.delete(k);
  }
}

export type AuthFailure = 'malformed' | 'kind' | 'signature' | 'challenge' | 'server' | 'stale';
export type AuthResult = { ok: true; pubkey: string } | { ok: false; reason: AuthFailure };

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const ID = HEX(64);
const SIG = HEX(128);

/** Whether `v` has the shape of a signed event (before any crypto), within sane sizes. */
export function isEventShape(v: unknown): v is NostrEvent {
  if (!validateEvent(v)) return false;
  const e = v as NostrEvent;
  return (
    isPubkey(e.pubkey) &&
    typeof e.id === 'string' &&
    ID.test(e.id) &&
    typeof e.sig === 'string' &&
    SIG.test(e.sig) &&
    Number.isSafeInteger(e.kind) &&
    Number.isSafeInteger(e.created_at) &&
    e.content.length <= 1024 &&
    e.tags.length <= 16 &&
    e.tags.every((t) => t.length <= 8 && t.every((x) => x.length <= 512))
  );
}

/**
 * Check a proof against the challenge issued and the addresses this server
 * answers to (any of `addresses`, as `authAddress` gives them).
 */
export function verifyAuth(ev: unknown, expect: { challenge: string; addresses: readonly string[]; now?: number }): AuthResult {
  if (!isEventShape(ev)) return { ok: false, reason: 'malformed' };
  if (ev.kind !== AUTH_KIND) return { ok: false, reason: 'kind' };
  // Fresh object: nostr-tools caches a verification result on the event itself.
  const e: NostrEvent = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig };
  if (!verifyEvent(e)) return { ok: false, reason: 'signature' };
  const tag = (name: string) => e.tags.find((t) => t[0] === name)?.[1];
  if (tag('challenge') !== expect.challenge) return { ok: false, reason: 'challenge' };
  const named = authAddress(tag('relay') ?? '');
  if (!named || !expect.addresses.includes(named)) return { ok: false, reason: 'server' };
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(e.created_at - now) > AUTH.maxSkew) return { ok: false, reason: 'stale' };
  return { ok: true, pubkey: e.pubkey };
}
