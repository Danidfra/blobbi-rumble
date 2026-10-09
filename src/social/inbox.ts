/**
 * NIP-17 INBOXES: where a private message to someone may go, the one
 * narrow way this app publishes anything, and (M8C-B) reading the gift
 * wraps addressed to the player from their own inbox.
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
      // NIP-01 replaceable: the newest wins; on a tie, the lowest id.
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
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
  return relayAuthFor(signer, inbox);
}

/** NIP-42 AUTH signed only for one of `relays` (canonical URLs this module chose), as `inboxRelayAuth`. */
function relayAuthFor(signer: NostrSigner, inbox: readonly string[]): RelayAuth {
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
  return publishTo(pool, [...inbox], wrap, auth, opts.maxWait);
}

/** The one place this app hands an event to relays. Callers check what and where first. */
async function publishTo(pool: PublishPoolLike, relays: string[], event: NostrEvent, auth: RelayAuth | null, wait?: number): Promise<PublishResult> {
  const maxWait = wait ?? 8000;
  const tries = pool.publish(relays, event, { ...(auth ? { onauth: auth } : {}), maxWait });
  const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), maxWait + 1000))]);
  const settled = await Promise.allSettled(tries.map(timeout));
  const result: PublishResult = { accepted: [], failed: [] };
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') result.accepted.push(relays[i]);
    else result.failed.push({ relay: relays[i], reason: String((s.reason as Error)?.message ?? s.reason).slice(0, 160) });
  });
  return result;
}

// ─── Receiving (M8C-B) ──────────────────────────────────────────────────────

/** The part of nostr-tools' SimplePool a gift-wrap subscription needs (and tests fake). */
export interface SubscribePoolLike {
  subscribeMany(
    relays: string[],
    filter: { kinds: number[]; '#p': string[]; since: number; limit: number },
    params: { onevent: (e: NostrEvent) => void; oneose?: () => void; onauth?: RelayAuth; maxWait?: number },
  ): { close: (reason?: string) => void };
}

export interface GiftWrapSubscription {
  close(): void;
}

/**
 * Subscribe to gift wraps addressed to `me` on `me`'s own inbox (from
 * their kind-10050 list): kind 1059, #p me, a bounded window and count.
 * Stored wraps arrive first (then `oneose`), new ones live after. An inbox
 * relay that requires it gets NIP-42 AUTH through `auth`, signed for that
 * relay only. Reading only: nothing is published here.
 */
export function subscribeGiftWraps(
  pool: SubscribePoolLike,
  inbox: InboxSet,
  me: string,
  opts: { since: number; limit: number; onevent: (e: NostrEvent) => void; oneose?: () => void; auth: RelayAuth | null; maxWait?: number },
): GiftWrapSubscription {
  if (!issued.has(inbox) || inbox.length === 0 || inbox.length > RELAY_LIMITS.inbox) throw new Error('subscribe: not an inbox from a kind-10050 list');
  const sub = pool.subscribeMany([...inbox], { kinds: [1059], '#p': [me], since: opts.since, limit: opts.limit }, {
    onevent: (e) => {
      // Only gift wraps for me get through, whatever a relay sends.
      if (e && e.kind === 1059 && Array.isArray(e.tags) && e.tags.some((t) => t[0] === 'p' && t[1] === me)) opts.onevent(e);
    },
    oneose: opts.oneose,
    ...(opts.auth ? { onauth: opts.auth } : {}),
    maxWait: opts.maxWait ?? 6000,
  });
  return { close: () => sub.close('done') };
}

// ─── Inbox setup (M8C-B.1) ──────────────────────────────────────────────────

/**
 * The player's own kind-10050 list naming `relays` (secure, canonical,
 * de-duplicated, 1-3): what "set up private invites" signs. Throws on
 * anything else.
 */
export function inboxListTemplate(relays: readonly string[], now = Math.floor(Date.now() / 1000)): EventTemplate {
  const clean: string[] = [];
  for (const r of relays) {
    const u = typeof r === 'string' && /^wss:\/\//i.test(r.trim()) ? relayUrl(r) : null;
    if (!u) throw new Error(`not a secure relay URL: ${String(r).slice(0, 80)}`);
    if (!clean.includes(u)) clean.push(u);
  }
  if (clean.length < 1 || clean.length > RELAY_LIMITS.inbox) throw new Error(`an inbox needs 1 to ${RELAY_LIMITS.inbox} relays`);
  return { kind: 10050, created_at: now, tags: clean.map((u) => ['relay', u]), content: '' };
}

/** At most this many relays receive the player's kind-10050 list. */
export const MAX_LIST_TARGETS = 9;

/**
 * Publish the player's own kind-10050 list so others can find it: only a
 * verified kind 10050 by `me` whose tags are exactly its relay tags (1-3,
 * wss), only to canonical wss `targets` (discovery relays and the inbox
 * relays themselves), with relay AUTH for exactly those relays.
 */
export async function publishInboxList(pool: PublishPoolLike, list: NostrEvent, me: string, targets: readonly string[], signer: NostrSigner | null, opts: { maxWait?: number } = {}): Promise<PublishResult> {
  const named = inboxRelays(list);
  if (!verifyFresh(list) || list.kind !== 10050 || list.pubkey !== me || list.content !== '' || named.length === 0 || named.length !== list.tags.length) throw new Error('publish: only the player’s own valid kind-10050 list may be published');
  const to: string[] = [];
  for (const t of targets) {
    const u = typeof t === 'string' && /^wss:\/\//i.test(t.trim()) ? relayUrl(t) : null;
    if (u && !to.includes(u)) to.push(u);
  }
  if (!to.length || to.length > MAX_LIST_TARGETS) throw new Error('publish: bad targets for the inbox list');
  return publishTo(pool, to, list, signer ? relayAuthFor(signer, to) : null, opts.maxWait);
}

/** The part of nostr-tools' SimplePool a read-only probe needs (and tests fake). */
export interface ProbePoolLike {
  subscribeMany(relays: string[], filter: Record<string, unknown>, params: { onevent: (e: NostrEvent) => void; oneose?: () => void; onclose?: (reasons: { url: string; reason: string }[]) => void; maxWait?: number }): { close: (reason?: string) => void };
}

export type ProbeAnswer = 'answered' | 'auth' | 'down';

/**
 * Ask each relay one read-only question and note how it answered: with its
 * stored events ('answered'), by requiring AUTH first ('auth'; no AUTH is
 * attempted, nothing is signed), or not at all ('down'). Never publishes.
 */
export async function probeRelays(pool: ProbePoolLike, relays: readonly string[], filter: Record<string, unknown>, maxWait = 5000): Promise<{ answers: Map<string, ProbeAnswer>; events: NostrEvent[] }> {
  const answers = new Map<string, ProbeAnswer>();
  const events: NostrEvent[] = [];
  const clean = relays.map((r) => (typeof r === 'string' && /^wss:\/\//i.test(r.trim()) ? relayUrl(r) : null)).filter((u): u is string => !!u);
  await Promise.all(
    [...new Set(clean)].map(
      (url) =>
        new Promise<void>((done) => {
          let settled = false;
          let sub: { close: (reason?: string) => void } | null = null;
          const finish = (a: ProbeAnswer) => {
            if (settled) return;
            settled = true;
            answers.set(url, a);
            clearTimeout(timer);
            try {
              sub?.close();
            } catch {
              // Already closed.
            }
            done();
          };
          const timer = setTimeout(() => finish('down'), maxWait + 500);
          sub = pool.subscribeMany([url], filter, {
            onevent: (e) => void events.push(e),
            // nostr-tools reports a CLOSED as an EOSE first, then the close: let the close have its say.
            oneose: () => void setTimeout(() => finish('answered'), 0),
            onclose: (reasons) => finish(reasons.some((r) => /auth-required/i.test(r.reason)) ? 'auth' : 'down'),
            maxWait,
          });
          // A pool that answered synchronously: close what it opened.
          if (settled) sub.close();
        }),
    ),
  );
  return { answers, events };
}
