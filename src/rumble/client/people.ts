/**
 * WHO TO INVITE (M8C-C): the people part of "Invite a friend". The player
 * picks a recipient instead of pasting an npub; the invite itself still
 * goes through the M8C-A sender, unchanged, on an explicit Send.
 *
 *   follows   the player's own kind-3 list (read only), most recently
 *             followed first, a compact window with "Show more"; profiles
 *             are asked only for the rows shown
 *   search    what the box says, after a short debounce:
 *               npub / nprofile  one exact person, selected at once
 *               name@domain      resolved by that domain (NIP-05), then the
 *                                person it names, selected at once
 *               a name           matched locally first (follows and cached
 *                                profiles), then on the search relays
 *                                (NIP-50), merged, ranked, capped; never
 *                                complete, and the panel says so
 *   NIP-05    a profile's claimed identifier is shown only once its domain
 *             confirmed it (checked lazily for rows on screen, bounded)
 *   select    one person, shown with avatar, name and short npub; Send is
 *             a separate click; the choice can be changed
 *
 * No inbox (kind 10050) is looked up here: the sender does that for the
 * one chosen recipient, when Send is clicked. A stale search (the text
 * changed, the panel closed, the identity went) updates nothing.
 */
import { npubEncode, nprofileEncode } from 'nostr-tools/nip19';
import type { ProfileDirectory } from '../../social/directory';
import { classifyQuery, findFollowList, matchTier, nip05Label, parseFollows, rankMatches, resolveNip05, searchProfiles, type Query } from '../../social/people';
import type { BoundedPool } from '../../social/pool';
import type { Profile } from '../../social/profile';

export const FINDER = Object.freeze({
  /** Follows shown at first, and added per "Show more", and at most. */
  page: 8,
  maxShown: 40,
  /** Typing pause before a relay or a domain is asked, ms. */
  debounceMs: 300,
  /** NIP-05 confirmations in flight at once. */
  nip05Concurrency: 3,
  /** Rows shown for a search. */
  maxResults: 10,
});

export type Nip05Status = 'verified' | 'unverified' | 'checking';

export interface PersonRow {
  pubkey: string;
  followed: boolean;
  /** The profile's claimed identifier as it should be shown, with whether its domain confirmed it. */
  nip05: { label: string; status: Nip05Status } | null;
  /** Relay hints that came with the identifier or the NIP-05 answer (where to look, nothing more). */
  hints: string[];
}

export type FollowsPhase = 'idle' | 'loading' | 'ready' | 'none' | 'empty';
export type SearchPhase = 'idle' | 'short' | 'invalid' | 'resolving' | 'searching' | 'done' | 'not-found';

export interface PeopleState {
  follows: { phase: FollowsPhase; total: number; rows: PersonRow[]; more: boolean };
  query: string;
  search: { phase: SearchPhase; rows: PersonRow[]; remote: boolean };
  selected: PersonRow | null;
}

type FetchLike = Parameters<typeof resolveNip05>[0];

export interface PeopleDeps {
  me: string;
  lookup: BoundedPool;
  directory: ProfileDirectory;
  lookupRelays?: readonly string[];
  searchRelays?: readonly string[];
  /** For NIP-05 (null: no NIP-05 at all). */
  fetch: FetchLike | null;
  debounceMs?: number;
  now?: () => number;
  onChange?: () => void;
}

export class PeopleFinder {
  state: PeopleState;
  private follows: string[] = [];
  private readonly followSet = new Set<string>();
  private shown = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private stopped = false;
  private readonly hints = new Map<string, string[]>();
  /** NIP-05 confirmations: "pubkey identifier" → status. */
  private readonly nip05 = new Map<string, Nip05Status>();
  private nip05Busy = 0;
  private readonly nip05Queue: { pubkey: string; id: string }[] = [];
  private readonly unlisten: () => void;

  constructor(private readonly d: PeopleDeps) {
    this.state = { follows: { phase: 'idle', total: 0, rows: [], more: false }, query: '', search: { phase: 'idle', rows: [], remote: false }, selected: null };
    this.unlisten = d.directory.onChange(() => this.refresh());
  }

  private set(patch: Partial<PeopleState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  // ─── Follows ──────────────────────────────────────────────────────────────

  /** Read the player's follow list once (the first time the invite section is on screen). */
  ensureFollows() {
    if (this.stopped || this.state.follows.phase !== 'idle') return;
    this.set({ follows: { ...this.state.follows, phase: 'loading' } });
    void (async () => {
      const list = await findFollowList(this.d.lookup, this.d.me, { lookupRelays: this.d.lookupRelays });
      if (this.stopped) return;
      // Most recently followed first (NIP-02: new follows are appended).
      this.follows = parseFollows(list, this.d.me).reverse();
      for (const pk of this.follows) this.followSet.add(pk);
      this.shown = Math.min(FINDER.page, this.follows.length);
      this.set({ follows: { phase: !list ? 'none' : this.follows.length ? 'ready' : 'empty', total: this.follows.length, rows: this.rows(this.follows.slice(0, this.shown)), more: this.follows.length > this.shown } });
      this.ask(this.follows.slice(0, this.shown));
    })();
  }

  showMore() {
    if (this.stopped || this.state.follows.phase !== 'ready') return;
    const next = Math.min(this.shown + FINDER.page, FINDER.maxShown, this.follows.length);
    const added = this.follows.slice(this.shown, next);
    this.shown = next;
    this.set({ follows: { ...this.state.follows, rows: this.rows(this.follows.slice(0, this.shown)), more: this.follows.length > this.shown && this.shown < FINDER.maxShown } });
    this.ask(added);
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  /** The box changed: an identifier resolves at once; a name is matched locally now and remotely after a pause. */
  setQuery(text: string) {
    if (this.stopped) return;
    const gen = ++this.gen;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const q = classifyQuery(text);
    const state = (phase: SearchPhase, rows: PersonRow[] = [], remote = false) => this.set({ query: text, search: { phase, rows, remote } });
    switch (q.kind) {
      case 'empty':
        return state('idle');
      case 'invalid':
        return state(q.why === 'too-short' ? 'short' : 'invalid');
      case 'identifier': {
        this.hints.set(q.recipient.pubkey, q.recipient.hints);
        const row = this.row(q.recipient.pubkey);
        state('done', [row]);
        this.ask([row.pubkey]);
        this.select(row.pubkey);
        return;
      }
      case 'nip05':
        state('resolving');
        this.timer = setTimeout(() => void this.resolve(q, gen), this.d.debounceMs ?? FINDER.debounceMs);
        return;
      case 'name': {
        const local = this.local(q.text);
        state('searching', local);
        this.timer = setTimeout(() => void this.remote(q, local, gen), this.d.debounceMs ?? FINDER.debounceMs);
      }
    }
  }

  private async resolve(q: Extract<Query, { kind: 'nip05' }>, gen: number) {
    const r = this.d.fetch ? await resolveNip05(this.d.fetch, q.identifier) : null;
    if (this.stopped || gen !== this.gen) return;
    if (!r) return this.set({ search: { phase: 'not-found', rows: [], remote: false } });
    // The domain named this pubkey for this identifier: that is what "confirmed" means.
    this.nip05.set(`${r.pubkey} ${q.identifier}`, 'verified');
    this.hints.set(r.pubkey, r.relays);
    const row = this.row(r.pubkey);
    this.set({ search: { phase: 'done', rows: [row], remote: false } });
    this.ask([r.pubkey]);
    this.select(r.pubkey);
  }

  /** Matches among follows and cached profiles, best first, capped. */
  private local(text: string): PersonRow[] {
    const ranked = rankMatches(
      this.d.directory
        .known()
        .filter((p) => p.pubkey !== this.d.me)
        .map((p) => ({ pubkey: p.pubkey, tier: matchTier(p, text), followed: this.followSet.has(p.pubkey) }))
        .filter((x): x is { pubkey: string; tier: number; followed: boolean } => x.tier !== null),
    );
    return this.rows(ranked.slice(0, FINDER.maxResults).map((x) => x.pubkey));
  }

  private async remote(q: Extract<Query, { kind: 'name' }>, local: PersonRow[], gen: number) {
    const found = await searchProfiles(this.d.lookup, q.text, { relays: this.d.searchRelays });
    if (this.stopped || gen !== this.gen) return;
    for (const f of found) this.d.directory.offer(f.event);
    const candidates = new Map<string, { pubkey: string; tier: number; followed: boolean }>();
    const add = (p: Profile | null | undefined, pk: string) => {
      if (pk === this.d.me) return;
      const tier = matchTier(p, q.text);
      if (tier === null) return;
      const prev = candidates.get(pk);
      if (!prev || tier < prev.tier) candidates.set(pk, { pubkey: pk, tier, followed: this.followSet.has(pk) });
    };
    for (const r of local) add(this.d.directory.get(r.pubkey), r.pubkey);
    for (const f of found) add(this.d.directory.get(f.profile.pubkey) ?? f.profile, f.profile.pubkey);
    const rows = this.rows(rankMatches([...candidates.values()]).slice(0, FINDER.maxResults).map((x) => x.pubkey));
    this.set({ search: { phase: rows.length ? 'done' : 'not-found', rows, remote: true } });
  }

  // ─── Selection ────────────────────────────────────────────────────────────

  select(pubkey: string) {
    if (this.stopped) return;
    this.set({ selected: this.row(pubkey) });
    this.ask([pubkey]);
  }

  clearSelection() {
    this.set({ selected: null });
  }

  /** The chosen person as the sender's own input format: an nprofile with hints when there are any, else an npub. */
  get recipient(): string | null {
    const s = this.state.selected;
    if (!s) return null;
    return s.hints.length ? nprofileEncode({ pubkey: s.pubkey, relays: s.hints }) : npubEncode(s.pubkey);
  }

  // ─── Rows ─────────────────────────────────────────────────────────────────

  private rows(pubkeys: string[]): PersonRow[] {
    return pubkeys.map((pk) => this.row(pk));
  }

  private row(pubkey: string): PersonRow {
    const p = this.d.directory.get(pubkey);
    let nip05: PersonRow['nip05'] = null;
    if (p?.nip05) {
      const key = `${pubkey} ${p.nip05}`;
      if (!this.nip05.has(key)) this.queueNip05(pubkey, p.nip05);
      nip05 = { label: nip05Label(p.nip05), status: this.nip05.get(key) ?? 'checking' };
    }
    return { pubkey, followed: this.followSet.has(pubkey), nip05, hints: this.hints.get(pubkey) ?? [] };
  }

  /** Profiles arrived or a confirmation came back: rebuild what is shown from the same pubkeys. */
  private refresh() {
    if (this.stopped) return;
    const f = this.state.follows;
    const s = this.state.search;
    this.set({
      follows: { ...f, rows: this.rows(f.rows.map((r) => r.pubkey)) },
      search: { ...s, rows: this.rows(s.rows.map((r) => r.pubkey)) },
      selected: this.state.selected ? this.row(this.state.selected.pubkey) : null,
    });
  }

  private ask(pubkeys: string[]) {
    if (pubkeys.length) this.d.directory.ask(pubkeys);
  }

  // ─── NIP-05 confirmation (lazy, bounded) ──────────────────────────────────

  private queueNip05(pubkey: string, id: string) {
    const key = `${pubkey} ${id}`;
    if (!this.d.fetch) {
      this.nip05.set(key, 'unverified');
      return;
    }
    this.nip05.set(key, 'checking');
    this.nip05Queue.push({ pubkey, id });
    this.pumpNip05();
  }

  private pumpNip05() {
    while (this.nip05Busy < FINDER.nip05Concurrency && this.nip05Queue.length && !this.stopped) {
      const { pubkey, id } = this.nip05Queue.shift()!;
      this.nip05Busy++;
      void resolveNip05(this.d.fetch!, id)
        .then((r) => this.nip05.set(`${pubkey} ${id}`, r?.pubkey === pubkey ? 'verified' : 'unverified'))
        .finally(() => {
          this.nip05Busy--;
          if (this.stopped) return;
          this.refresh();
          this.pumpNip05();
        });
    }
  }

  /** The identity went away: nothing here updates again. */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.gen++;
    this.nip05Queue.length = 0;
    this.unlisten();
  }
}
