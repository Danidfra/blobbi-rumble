/**
 * FINDING PEOPLE (M8C-C): who to send a private message to, from what the
 * user types or already knows. Nostr has no global name index, so this is
 * four narrow things, not one search:
 *
 *   identifier   an npub / nprofile (NIP-19) names one pubkey exactly
 *   NIP-05       name@domain → https://domain/.well-known/nostr.json?name=
 *                → a pubkey (identification, not proof: the domain says so)
 *   follows      the user's own kind-3 list (NIP-02): read only, never
 *                written; the first place a name is looked for
 *   NIP-50       a `search` filter on kind 0, sent to a few relays known to
 *                index profiles; results are re-matched here (a relay that
 *                ignores NIP-50 sends anything) and never treated as complete
 *
 * A display name is never unique: the pubkey is the identity, and the
 * interface shows a short npub beside every name. Profile text goes
 * through `parseProfile` (text only, bounded).
 * Framework-free; no Rumble imports.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { isPubkey, parseRecipient, type Recipient } from './keys';
import type { BoundedPool } from './pool';
import { parseProfile, type Profile } from './profile';
import { LOOKUP_RELAYS, RELAY_LIMITS, writeRelays } from './relays';

export const PEOPLE = Object.freeze({
  /** Follows read from a kind 3 (a list longer than this is read only up to here). */
  maxFollows: 2000,
  /** Shortest text sent to a search relay. */
  minSearch: 2,
  maxSearch: 64,
  /** Results asked of each search relay, and shown at most. */
  searchLimit: 10,
  /** NIP-05 fetch timeout, ms, and the largest nostr.json read. */
  nip05TimeoutMs: 3000,
  nip05MaxBytes: 65_536,
});

/**
 * Relays that answer NIP-50 `search` on kind 0, probed on 2026-10-09 from
 * this app (NIP-11 lists 50; searches for known names returned them in
 * about a second):
 *   relay.vertexlab.io  ranks by web of trust: the real account came first
 *                       for a much-impersonated name
 *   relay.ditto.pub     what Ditto routes every search to; a lookup relay
 *                       here already, so no extra connection
 * Rejected or not chosen: search.nos.today (works, 3-8 s), nostr.wine
 * (paid; impostors first), relay.noswhere.com (empty), relay.nostr.band
 * and antiprimal.net (dead), filter.nostr.wine (members only). See the
 * M8C-C notes.
 */
export const SEARCH_RELAYS: readonly string[] = Object.freeze(['wss://relay.vertexlab.io', 'wss://relay.ditto.pub']);
/** A search waits this long for its relays, ms (they answer in about a second). */
export const SEARCH_WAIT_MS = 3000;

// ─── What was typed ──────────────────────────────────────────────────────────

export type Query =
  | { kind: 'empty' }
  /** An npub or nprofile: exactly one pubkey (hints are where to look, nothing more). */
  | { kind: 'identifier'; recipient: Recipient }
  /** name@domain, or a bare domain (NIP-05 root `_`). */
  | { kind: 'nip05'; identifier: string }
  /** Anything else: a name to look for. */
  | { kind: 'name'; text: string }
  | { kind: 'invalid'; why: 'too-short' | 'bad-identifier' };

const NIP05_ID = /^(?:([a-z0-9._+-]{1,64})@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** Read what the user typed into one of the four things it can be. */
export function classifyQuery(raw: unknown): Query {
  if (typeof raw !== 'string') return { kind: 'empty' };
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  const bare = s.replace(/^nostr:/i, '').replace(/^@/, '');
  if (/^(npub1|nprofile1)/i.test(bare)) {
    const r = parseRecipient(bare.toLowerCase());
    return r ? { kind: 'identifier', recipient: r } : { kind: 'invalid', why: 'bad-identifier' };
  }
  const lower = bare.toLowerCase();
  if (lower.length <= 120 && NIP05_ID.test(lower)) return { kind: 'nip05', identifier: lower };
  const text = Array.from(s.replace(/\s+/g, ' ')).slice(0, PEOPLE.maxSearch).join('');
  if (Array.from(text).length < PEOPLE.minSearch) return { kind: 'invalid', why: 'too-short' };
  return { kind: 'name', text };
}

// ─── NIP-05 ─────────────────────────────────────────────────────────────────

export interface Nip05Result {
  pubkey: string;
  /** Relay hints the domain gave for that pubkey (wss only), at most 3. */
  relays: string[];
}

type FetchLike = (url: string, init: { redirect: 'manual'; signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

/** `_@domain` shows as `domain`; otherwise the identifier as given. */
export function nip05Label(identifier: string): string {
  return identifier.startsWith('_@') ? identifier.slice(2) : identifier;
}

/**
 * Resolve a NIP-05 identifier to the pubkey its domain names, or null: no
 * redirects, a short timeout, a bounded body, exact then case-insensitive
 * name match, hex pubkeys only. Null on anything else. The domain learns
 * that this app asked; the caller decides when that is worth it.
 */
export async function resolveNip05(fetchFn: FetchLike, identifier: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Nip05Result | null> {
  const m = identifier.trim().toLowerCase().match(NIP05_ID);
  if (!m) return null;
  const name = m[1] ?? '_';
  const domain = m[2];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PEOPLE.nip05TimeoutMs);
  try {
    const res = await fetchFn(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json' } });
    // A redirect (opaque, status 0, or 3xx) is a refusal by the NIP: never followed.
    if (res.status !== 200) return null;
    const text = await res.text();
    if (text.length > (opts.maxBytes ?? PEOPLE.nip05MaxBytes)) return null;
    const json = JSON.parse(text) as { names?: Record<string, unknown>; relays?: Record<string, unknown> };
    const names = json && typeof json === 'object' && json.names && typeof json.names === 'object' ? json.names : null;
    if (!names) return null;
    let pk = names[name];
    if (typeof pk !== 'string') pk = Object.entries(names).find(([k]) => k.toLowerCase() === name)?.[1];
    if (!isPubkey(pk)) return null;
    const hinted = json.relays && typeof json.relays === 'object' ? (json.relays as Record<string, unknown>)[pk] : undefined;
    const relays = Array.isArray(hinted) ? hinted.filter((r): r is string => typeof r === 'string' && /^wss:\/\//i.test(r) && r.length <= 256).slice(0, RELAY_LIMITS.perUser) : [];
    return { pubkey: pk, relays };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Follows (NIP-02, read only) ────────────────────────────────────────────

/** The pubkeys a kind-3 list follows: well-formed `p` tags, de-duplicated, in list order, never the author, bounded. */
export function parseFollows(ev: NostrEvent | null | undefined, me?: string): string[] {
  if (!ev || ev.kind !== 3 || !Array.isArray(ev.tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of ev.tags) {
    if (!Array.isArray(t) || t[0] !== 'p' || typeof t[1] !== 'string') continue;
    const pk = t[1].toLowerCase();
    if (!isPubkey(pk) || pk === (me ?? ev.pubkey) || seen.has(pk)) continue;
    seen.add(pk);
    out.push(pk);
    if (out.length >= PEOPLE.maxFollows) break;
  }
  return out;
}

/**
 * The user's current kind-3 list: from the lookup relays, then (not there)
 * from their own NIP-65 write relays. The newest wins; on a tie the lowest
 * id. Never published, never modified. Null when none is found (or no relay
 * answered: the caller cannot tell those apart and should say so).
 */
export async function findFollowList(pool: BoundedPool, me: string, opts: { lookupRelays?: readonly string[]; now?: number } = {}): Promise<NostrEvent | null> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const newest = (events: NostrEvent[], kind: number) =>
    events
      .filter((e) => e && e.kind === kind && e.pubkey === me && Number.isSafeInteger(e.created_at) && e.created_at <= now + 600)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
  const first = await pool.query(opts.lookupRelays ?? LOOKUP_RELAYS, { kinds: [3, 10002], authors: [me] });
  let list = newest(first, 3);
  if (!list) {
    const outbox = writeRelays(newest(first, 10002), RELAY_LIMITS.perUser);
    if (outbox.length) list = newest(await pool.query(outbox, { kinds: [3], authors: [me] }), 3);
  }
  return list;
}

// ─── Matching and ranking ───────────────────────────────────────────────────

/** How well a profile matches typed text: 0 exact name, 1 name prefix, 2 name contains, 3 NIP-05 local part, 4 NIP-05 contains; null: no match. */
export function matchTier(p: Profile | null | undefined, text: string): number | null {
  if (!p) return null;
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const names = [p.name, p.displayName].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q))) return 2;
  const nip05 = p.nip05 ?? '';
  const local = nip05.split('@')[0];
  if (nip05 && (local === q || local.startsWith(q))) return 3;
  if (nip05 && nip05.includes(q)) return 4;
  return null;
}

export interface Ranked {
  pubkey: string;
  tier: number;
  followed: boolean;
}

/** Best match first; among equals, people the user follows; then by pubkey (stable). */
export function rankMatches(items: Ranked[]): Ranked[] {
  return [...items].sort((a, b) => a.tier - b.tier || Number(b.followed) - Number(a.followed) || (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
}

// ─── NIP-50 (remote) ────────────────────────────────────────────────────────

/**
 * Ask the search relays for profiles matching `text` (kind 0, `search`,
 * a small limit) and keep only those that match here too: a relay that
 * does not implement NIP-50 answers with whatever it has. Newest per
 * pubkey. Never complete; never an error (an empty list is a normal answer).
 */
export async function searchProfiles(pool: BoundedPool, text: string, opts: { relays?: readonly string[]; limit?: number; now?: number } = {}): Promise<{ profile: Profile; event: NostrEvent }[]> {
  const q = text.trim();
  if (Array.from(q).length < PEOPLE.minSearch) return [];
  const limit = opts.limit ?? PEOPLE.searchLimit;
  const events = await pool.query(opts.relays ?? SEARCH_RELAYS, { kinds: [0], search: q.slice(0, PEOPLE.maxSearch), limit }, { maxWait: SEARCH_WAIT_MS });
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const byPubkey = new Map<string, { profile: Profile; event: NostrEvent }>();
  for (const ev of events) {
    if (!ev || ev.kind !== 0 || !isPubkey(ev.pubkey)) continue;
    const p = parseProfile(ev, now);
    if (!p || matchTier(p, q) === null) continue;
    const prev = byPubkey.get(p.pubkey);
    if (!prev || p.createdAt > prev.profile.createdAt) byPubkey.set(p.pubkey, { profile: p, event: ev });
  }
  return [...byPubkey.values()].slice(0, limit * 2);
}
