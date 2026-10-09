/**
 * WHICH RELAYS: a small fixed lookup set, plus at most a few of a user's
 * own (their NIP-65 kind-10002 write relays, where their profile lives).
 * Never a fan-out to every relay someone lists. Framework-free; no Rumble
 * imports.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { normalizeURL } from 'nostr-tools/utils';

/** Where profiles and relay lists are looked up first (indexers that keep kinds 0 and 10002 for everyone). */
export const LOOKUP_RELAYS: readonly string[] = Object.freeze(['wss://purplepag.es', 'wss://relay.damus.io', 'wss://relay.ditto.pub']);

export const RELAY_LIMITS = Object.freeze({
  /** At most this many of one user's own relays are asked. */
  perUser: 3,
  /** At most this many relay connections open at once, all purposes. */
  maxOpen: 8,
  /** At most this many of someone's NIP-17 inbox relays get a private message. */
  inbox: 3,
  /** A relay list with more tags than this is read only up to here. */
  maxListTags: 50,
});

/** A relay URL made canonical (wss/ws only, no credentials, no fragment), or null. */
export function relayUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 256) return null;
  let n: string;
  try {
    n = normalizeURL(v.trim());
  } catch {
    return null;
  }
  let u: URL;
  try {
    u = new URL(n);
  } catch {
    return null;
  }
  if ((u.protocol !== 'wss:' && u.protocol !== 'ws:') || !u.hostname || u.username || u.password) return null;
  return n;
}

/**
 * A NIP-17 kind-10050 list's inbox relays: ["relay", url] tags, secure
 * (wss) only, canonical, de-duplicated, in the list's order, at most `max`
 * (NIP-17 asks for 1-3). This, and only this, is where a private message to
 * its author may be sent.
 */
export function inboxRelays(ev: NostrEvent | null | undefined, max = RELAY_LIMITS.inbox): string[] {
  if (!ev || ev.kind !== 10050 || !Array.isArray(ev.tags)) return [];
  const out: string[] = [];
  for (const t of ev.tags.slice(0, RELAY_LIMITS.maxListTags)) {
    // A relay tag must say wss:// itself (normalising would turn https:// into wss://).
    if (!Array.isArray(t) || t[0] !== 'relay' || typeof t[1] !== 'string' || !/^wss:\/\//i.test(t[1].trim())) continue;
    const url = relayUrl(t[1]);
    if (url && url.startsWith('wss://') && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** A NIP-65 relay list's write relays (where its author publishes), canonical and de-duplicated, at most `max`. */
export function writeRelays(ev: NostrEvent | null | undefined, max = RELAY_LIMITS.perUser): string[] {
  if (!ev || ev.kind !== 10002 || !Array.isArray(ev.tags)) return [];
  const out: string[] = [];
  for (const t of ev.tags.slice(0, RELAY_LIMITS.maxListTags)) {
    if (!Array.isArray(t) || t[0] !== 'r') continue;
    // No marker: read and write; 'read' only: not where they write.
    if (t[2] !== undefined && t[2] !== 'write') continue;
    const url = relayUrl(t[1]);
    // Only secure relays from someone else's list (a page on https cannot open ws:// anyway).
    if (url && url.startsWith('wss://') && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
