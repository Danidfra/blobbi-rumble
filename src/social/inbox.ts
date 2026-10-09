/**
 * NIP-17 INBOXES, the sending half: where a private message to someone may
 * go, and the one narrow way this app publishes anything.
 *
 *   findInbox     the recipient's kind-10050 list: looked up on the lookup
 *                 relays (and an nprofile's hints), then, if not there, on
 *                 their NIP-65 write relays. Those relays only LOCATE the
 *                 list; the inbox is the list's own `relay` tags (wss, at
 *                 most 3). No list, or an empty one: no inbox, and nothing
 *                 is sent anywhere (NIP-17: the user is not ready to receive).
 *   publishGiftWrap  a kind-1059 gift wrap, to an inbox set made by this
 *                 module from a 10050 list (checked at run time), nothing
 *                 else. Done when at least one relay accepts.
 *   relay AUTH    some inbox relays require NIP-42 AUTH before accepting a
 *                 gift wrap. The callback signs ONLY a kind-22242 whose relay
 *                 tag is one of that inbox's relays (nostr-tools builds it
 *                 from the relay's own challenge, on that relay's
 *                 connection). It never sees, and cannot produce, the game
 *                 server's identity proof, which goes over the game socket
 *                 and nowhere else (`client/identity.ts`).
 *
 * Framework-free; no Rumble imports.
 */
import type { EventTemplate, NostrEvent, VerifiedEvent } from 'nostr-tools/pure';
import { verifyFresh } from './verify';
import { AUTH_KIND } from './auth';
import type { Recipient } from './keys';
import type { BoundedPool } from './pool';
import { LOOKUP_RELAYS, RELAY_LIMITS, inboxRelays, relayUrl, writeRelays } from './relays';
import type { NostrSigner } from './signer';

/** Relays from a recipient's kind-10050 list, as made by this module. */
export type InboxSet = readonly string[];
const issued = new WeakSet<object>();

/** The inbox set of a kind-10050 event (empty if it names no usable relay). */
export function inboxFromList(list: NostrEvent): InboxSet {
  const set = Object.freeze(inboxRelays(list));
  issued.add(set);
  return set;
}

export interface FoundInbox {
  relays: InboxSet;
  list: NostrEvent;
}

/** The recipient's NIP-17 inbox, or null if they have none (or none usable). Never throws. */
export async function findInbox(pool: BoundedPool, recipient: Recipient, opts: { lookupRelays?: readonly string[]; now?: number } = {}): Promise<FoundInbox | null> {
  const pk = recipient.pubkey;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const hints = recipient.hints.map(relayUrl).filter((u): u is string => !!u && u.startsWith('wss://')).slice(0, 2);
  const newest = (events: NostrEvent[], kind: number) =>
    events
      .filter((e) => e && e.kind === kind && e.pubkey === pk && Number.isSafeInteger(e.created_at) && e.created_at <= now + 600)
      .sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  const first = await pool.query([...(opts.lookupRelays ?? LOOKUP_RELAYS), ...hints], { kinds: [10050, 10002], authors: [pk] });
  let list = newest(first, 10050);
  if (!list) {
    const outbox = writeRelays(newest(first, 10002), RELAY_LIMITS.perUser);
    if (outbox.length) list = newest(await pool.query(outbox, { kinds: [10050], authors: [pk] }), 10050);
  }
  if (!list) return null;
  const relays = inboxFromList(list);
  return relays.length ? { relays, list } : null;
}

/** The part of nostr-tools' SimplePool publishing needs (and tests fake). */
export interface PublishPoolLike {
  publish(relays: string[], event: NostrEvent, params?: { onauth?: (t: EventTemplate) => Promise<VerifiedEvent>; maxWait?: number }): Promise<string>[];
}

export type RelayAuth = (template: EventTemplate) => Promise<VerifiedEvent>;

/**
 * NIP-42 AUTH for an inbox: signs a kind-22242 only if it is exactly a
 * relay AUTH for one of `inbox`'s relays (empty content, a relay tag naming
 * that relay, a bounded challenge, nothing else).
 */
export function inboxRelayAuth(signer: NostrSigner, inbox: InboxSet): RelayAuth {
  return async (t) => {
    const relay = t.tags.find((x) => x[0] === 'relay')?.[1];
    const challenge = t.tags.find((x) => x[0] === 'challenge')?.[1];
    const named = typeof relay === 'string' ? relayUrl(relay) : null;
    const ok = t.kind === AUTH_KIND && t.content === '' && t.tags.length === 2 && !!named && inbox.includes(named) && typeof challenge === 'string' && challenge.length > 0 && challenge.length <= 256;
    if (!ok) throw new Error('refused: not an AUTH for this inbox');
    return signer.signEvent(t);
  };
}

export interface PublishResult {
  accepted: string[];
  failed: { relay: string; reason: string }[];
}

/** Publish a gift wrap to an inbox. Only kind 1059, only to an inbox set from `inboxFromList`. */
export async function publishGiftWrap(pool: PublishPoolLike, inbox: InboxSet, wrap: NostrEvent, auth: RelayAuth | null, opts: { maxWait?: number } = {}): Promise<PublishResult> {
  if (!issued.has(inbox) || inbox.length === 0 || inbox.length > RELAY_LIMITS.inbox) throw new Error('publish: not an inbox from a kind-10050 list');
  if (wrap.kind !== 1059 || !wrap.tags.some((t) => t[0] === 'p') || !verifyFresh(wrap)) throw new Error('publish: only a valid kind-1059 gift wrap may be published');
  const maxWait = opts.maxWait ?? 8000;
  const relays = [...inbox];
  const tries = pool.publish(relays, wrap, { ...(auth ? { onauth: auth } : {}), maxWait });
  const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), maxWait + 1000))]);
  const settled = await Promise.allSettled(tries.map(timeout));
  const result: PublishResult = { accepted: [], failed: [] };
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') result.accepted.push(relays[i]);
    else result.failed.push({ relay: relays[i], reason: String((s.reason as Error)?.message ?? s.reason).slice(0, 160) });
  });
  return result;
}
