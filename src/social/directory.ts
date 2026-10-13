/**
 * THE PROFILE DIRECTORY: pubkey → Profile, looked up on relays, cached.
 *
 *   ask(pubkeys)  queue lookups; within a short window they go out as one
 *                 batch: kinds 0 and 10002 for all of them from the lookup
 *                 relays; anyone still without a profile is asked on (at
 *                 most three of) their own write relays, if `ownRelaysFor`
 *                 allows it for that pubkey (L4.5B: a game asks only for
 *                 its player's own: someone else's relay list is theirs to
 *                 write, so following it would let any player send every
 *                 page that sees them to a relay they run).
 *   get(pubkey)   what is known now: a Profile, null (looked up, none
 *                 found) or undefined (not looked up yet). Never waits.
 *   onChange      called with a pubkey when what is known about it changed.
 *
 * Events are checked again here (the pool already verified signatures):
 * right kind, an author that was asked for, sane size and date; the newest
 * wins and an older event never replaces a newer one. Answers are cached
 * (a found profile for `freshMs`, a missing one for `missingMs`) and may be
 * persisted, bounded and dated, to a Storage; anything older than `maxAgeMs`
 * is dropped, so no name is stale for long.
 * Framework-free; no Rumble imports.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { isPubkey } from './keys';
import type { BoundedPool } from './pool';
import { parseProfile, type Profile } from './profile';
import { LOOKUP_RELAYS, RELAY_LIMITS, writeRelays } from './relays';

export interface DirectoryOptions {
  lookupRelays?: readonly string[];
  /** Persist answers here (localStorage); omitted: memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  storageKey?: string;
  batchMs?: number;
  /** L4.5B: whether a pubkey's own write relays may be asked (default: every pubkey's, as before). */
  ownRelaysFor?: (pubkey: string) => boolean;
  freshMs?: number;
  missingMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  profile: Profile | null;
  /** When it was last looked up, ms. */
  at: number;
}

export class ProfileDirectory {
  private readonly entries = new Map<string, Entry>();
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly listeners = new Set<(pubkey: string) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly o: Required<Omit<DirectoryOptions, 'storage'>> & { storage: DirectoryOptions['storage'] };
  lookups = 0;

  constructor(
    private readonly pool: BoundedPool,
    opts: DirectoryOptions = {},
  ) {
    this.o = {
      lookupRelays: opts.lookupRelays ?? LOOKUP_RELAYS,
      storage: opts.storage ?? null,
      storageKey: opts.storageKey ?? 'nostr:profiles:v1',
      batchMs: opts.batchMs ?? 60,
      ownRelaysFor: opts.ownRelaysFor ?? (() => true),
      freshMs: opts.freshMs ?? 30 * 60_000,
      missingMs: opts.missingMs ?? 60_000,
      maxAgeMs: opts.maxAgeMs ?? 24 * 60 * 60_000,
      maxEntries: opts.maxEntries ?? 64,
      now: opts.now ?? (() => Date.now()),
    };
    this.load();
  }

  onChange(fn: (pubkey: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What is known now: a Profile, null (none found) or undefined (not looked up yet). */
  get(pubkey: string): Profile | null | undefined {
    return this.entries.get(pubkey)?.profile;
  }

  /** Every profile known now (for a local name search); never waits. */
  known(): Profile[] {
    const out: Profile[] = [];
    for (const e of this.entries.values()) if (e.profile) out.push(e.profile);
    return out;
  }

  /** A kind-0 event that arrived another way (a search result): kept if it is newer than what is known. Cleaned like any other. */
  offer(ev: NostrEvent) {
    if (!ev || ev.kind !== 0 || !isPubkey(ev.pubkey)) return;
    const t = this.o.now();
    const profile = parseProfile(ev, Math.floor(t / 1000));
    if (!profile) return;
    const prev = this.entries.get(ev.pubkey);
    if (prev?.profile && prev.profile.createdAt >= profile.createdAt) return;
    this.entries.set(ev.pubkey, { profile, at: t });
    for (const fn of this.listeners) fn(ev.pubkey);
    this.save();
  }

  /** Look these up (those not known, or known but due for a refresh), batched. */
  ask(pubkeys: Iterable<string>) {
    const t = this.o.now();
    for (const pk of pubkeys) {
      if (!isPubkey(pk) || this.inFlight.has(pk)) continue;
      const e = this.entries.get(pk);
      if (e && t - e.at < (e.profile ? this.o.freshMs : this.o.missingMs)) continue;
      this.queued.add(pk);
    }
    if (this.queued.size && !this.timer) this.timer = setTimeout(() => void this.flush(), this.o.batchMs);
  }

  /** Run the queued lookups now (the batch timer calls this; tests may too). */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.queued].slice(0, 50);
    for (const pk of batch) {
      this.queued.delete(pk);
      this.inFlight.add(pk);
    }
    if (!batch.length) return;
    this.lookups += 1;
    try {
      const asked = new Set(batch);
      const found = new Map<string, NostrEvent>();
      const lists = new Map<string, NostrEvent>();
      const take = (events: NostrEvent[]) => {
        for (const ev of events) {
          if (!ev || !asked.has(ev.pubkey)) continue;
          const into = ev.kind === 0 ? found : ev.kind === 10002 ? lists : null;
          if (!into) continue;
          const prev = into.get(ev.pubkey);
          if (!prev || ev.created_at > prev.created_at) into.set(ev.pubkey, ev);
        }
      };
      take(await this.pool.query(this.o.lookupRelays, { kinds: [0, 10002], authors: batch }));
      // Not on the lookup relays: try (a few of) their own.
      const byRelays = new Map<string, string[]>();
      for (const pk of batch) {
        if (found.has(pk) || !this.o.ownRelaysFor(pk)) continue;
        const relays = writeRelays(lists.get(pk), RELAY_LIMITS.perUser);
        if (!relays.length) continue;
        const key = relays.join(' ');
        byRelays.set(key, [...(byRelays.get(key) ?? []), pk]);
      }
      for (const [key, authors] of byRelays) take(await this.pool.query(key.split(' '), { kinds: [0], authors }));
      const t = this.o.now();
      for (const pk of batch) {
        const ev = found.get(pk);
        const profile = ev ? parseProfile(ev, Math.floor(t / 1000)) : null;
        const prev = this.entries.get(pk);
        // Never back in time: an older event than the one known does not replace it.
        const keep = prev?.profile && (!profile || profile.createdAt < prev.profile.createdAt) ? prev.profile : profile;
        this.entries.set(pk, { profile: keep, at: t });
        if (JSON.stringify(prev?.profile ?? null) !== JSON.stringify(keep)) for (const fn of this.listeners) fn(pk);
      }
      this.save();
    } finally {
      for (const pk of batch) this.inFlight.delete(pk);
      if (this.queued.size && !this.timer) this.timer = setTimeout(() => void this.flush(), this.o.batchMs);
    }
  }

  private load() {
    const s = this.o.storage;
    if (!s) return;
    let raw: unknown;
    try {
      raw = JSON.parse(s.getItem(this.o.storageKey) ?? 'null');
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    const t = this.o.now();
    for (const item of raw.slice(0, this.o.maxEntries)) {
      const [pk, at, profile] = Array.isArray(item) ? item : [];
      if (!isPubkey(pk) || typeof at !== 'number' || t - at > this.o.maxAgeMs || at > t) continue;
      // Stored profiles go through the same cleaning as fresh ones (storage is not trusted either).
      const p = profile && typeof profile === 'object' ? parseProfile({ kind: 0, pubkey: pk, created_at: Number(profile.createdAt) || 0, content: JSON.stringify({ name: profile.name, display_name: profile.displayName, picture: profile.picture, nip05: profile.nip05 }), tags: [], id: '', sig: '' }, Math.floor(t / 1000)) : null;
      this.entries.set(pk, { profile: p, at });
    }
  }

  private save() {
    const s = this.o.storage;
    if (!s) return;
    const newest = [...this.entries.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, this.o.maxEntries);
    try {
      s.setItem(this.o.storageKey, JSON.stringify(newest.map(([pk, e]) => [pk, e.at, e.profile])));
    } catch {
      // Storage full or blocked: memory only.
    }
  }
}
