/**
 * SETTING UP PRIVATE INVITES (M8C-B.1): for a connected player whose Nostr
 * identity has NO kind-10050 list (NIP-17: "where to send me private
 * messages"), create one, only when they ask.
 *
 *   open      show suggested inbox relays and probe them read-only (no
 *             signing): reachable, needs sign-in (NIP-42), or down
 *   confirm   (an explicit click) check again, strictly, that no list
 *             exists (enough lookup relays must answer; the player's NIP-65
 *             write relays are asked too); if one exists, use it and stop.
 *             Otherwise the extension signs the kind-10050 list, which is
 *             published to the lookup relays, the player's NIP-65 write
 *             relays (at most 3) and the chosen inbox relays; then it is read
 *             back from the lookup relays.
 *
 * Never touches an existing list (no overwrite, no merge), never signs or
 * publishes on its own, never retries on its own.
 *
 * Results:
 *   done / partial   the list is discoverable and at least one chosen inbox
 *                    relay accepted it (partial: not all of them)
 *   unverified       accepted somewhere, but not readable back from the
 *                    lookup relays yet
 *   failed           nothing usable (no relay accepted it, or none of the
 *                    inbox relays did)
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { findInbox, inboxListTemplate, probeRelays, publishInboxList, type ProbeAnswer, type ProbePoolLike, type PublishPoolLike } from '../../social/inbox';
import type { BoundedPool } from '../../social/pool';
import { LOOKUP_RELAYS, RELAY_LIMITS, inboxRelays, relayUrl, writeRelays } from '../../social/relays';
import { SignerError, type NostrSigner } from '../../social/signer';

/**
 * Suggested NIP-17 inbox relays (checked 2026-10-09; see the M8C-B.1 notes):
 *   auth.nostr1.com  NIP-17/42; reads and writes need AUTH (only the recipient reads its wraps)
 *   relay.nostr.net  NIP-59; reading gift wraps needs AUTH; open writes
 *   nos.lol          a widely used relay with open writes (open reads), another operator
 */
export const INBOX_SUGGESTIONS: readonly string[] = Object.freeze(['wss://auth.nostr1.com/', 'wss://relay.nostr.net/', 'wss://nos.lol/']);

export type SetupPhase = 'probing' | 'ready' | 'checking' | 'signing' | 'publishing' | 'verifying' | 'done' | 'partial' | 'unverified' | 'failed' | 'exists' | 'uncertain' | 'declined';

export interface SetupCandidate {
  url: string;
  selected: boolean;
  probe: ProbeAnswer | 'checking';
}

export interface SetupState {
  phase: SetupPhase;
  candidates: SetupCandidate[];
  /** After publishing: which chosen inbox relays accepted the list, which did not; where it was published for discovery. */
  inboxOk: string[];
  inboxFailed: string[];
  listedOn: string[];
  message: string;
}

export interface InboxSetupDeps {
  signer: NostrSigner;
  me: string;
  lookup: BoundedPool;
  /** Short-lived pools for probing and publishing (destroyed after use). */
  pools: () => ProbePoolLike & PublishPoolLike & { destroy?: () => void };
  lookupRelays?: readonly string[];
  suggestions?: readonly string[];
  /** How long a probe waits for a relay, ms. */
  probeWaitMs?: number;
  now?: () => number;
  onChange?: () => void;
  /** The player's inbox is known now (an existing list found, or the new one published): use it. */
  onInbox: (list: NostrEvent) => void;
}

export class InboxSetup {
  state: SetupState;
  private stopped = false;
  private busy = false;

  constructor(private readonly d: InboxSetupDeps) {
    // Canonical, secure, de-duplicated (probe answers and the list itself use canonical URLs).
    const urls = [...new Set((d.suggestions ?? INBOX_SUGGESTIONS).map((u) => (/^wss:\/\//i.test(u.trim()) ? relayUrl(u) : null)).filter((u): u is string => !!u))].slice(0, RELAY_LIMITS.inbox);
    this.state = { phase: 'probing', candidates: urls.map((url) => ({ url, selected: true, probe: 'checking' })), inboxOk: [], inboxFailed: [], listedOn: [], message: '' };
  }

  private set(patch: Partial<SetupState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  private lookups() {
    return this.d.lookupRelays ?? LOOKUP_RELAYS;
  }

  /** Probe the suggestions (read-only; nothing signed). Unreachable ones start unselected. */
  async open(): Promise<void> {
    const pool = this.d.pools();
    try {
      const { answers } = await probeRelays(pool, this.state.candidates.map((c) => c.url), { kinds: [1059], '#p': [this.d.me], limit: 1 }, this.d.probeWaitMs);
      if (this.stopped) return;
      this.set({ phase: 'ready', candidates: this.state.candidates.map((c) => ({ ...c, probe: answers.get(c.url) ?? 'down', selected: (answers.get(c.url) ?? 'down') !== 'down' })) });
    } finally {
      pool.destroy?.();
    }
  }

  toggle(url: string) {
    if (this.state.phase !== 'ready' && this.state.phase !== 'failed' && this.state.phase !== 'declined' && this.state.phase !== 'uncertain') return;
    this.set({ candidates: this.state.candidates.map((c) => (c.url === url ? { ...c, selected: !c.selected } : c)) });
  }

  /** The player confirmed: check, sign, publish, verify. Runs only on this call; never repeats by itself. */
  async confirm(): Promise<void> {
    if (this.busy || this.stopped) return;
    const chosen = this.state.candidates.filter((c) => c.selected).map((c) => c.url);
    if (!chosen.length) return this.set({ message: 'Choose at least one relay.' });
    this.busy = true;
    const pool = this.d.pools();
    try {
      // 1. Strictly: is there a list already? (A lookup that failed must not look like "none".)
      this.set({ phase: 'checking', message: '' });
      const lookups = [...this.lookups()];
      const first = await probeRelays(pool, lookups, { kinds: [10050, 10002], authors: [this.d.me] }, this.d.probeWaitMs);
      if (this.stopped) return;
      const answered = [...first.answers.values()].filter((a) => a === 'answered').length;
      let events = first.events.filter((e) => e.pubkey === this.d.me);
      const outbox = writeRelays(newest(events, 10002), RELAY_LIMITS.perUser);
      if (outbox.length) events = [...events, ...(await probeRelays(pool, outbox, { kinds: [10050], authors: [this.d.me] }, this.d.probeWaitMs)).events.filter((e) => e.pubkey === this.d.me)];
      if (this.stopped) return;
      const existing = newest(events, 10050);
      if (existing && inboxRelays(existing).length) {
        this.set({ phase: 'exists', message: 'You already have private-message relays; Rumble uses them as they are.' });
        this.d.onInbox(existing);
        return;
      }
      if (existing || answered < Math.min(2, lookups.length)) {
        return this.set({ phase: 'uncertain', message: existing ? 'Your existing private-message relay list has no usable relays; Rumble won’t replace it.' : 'Couldn’t reach enough relays to confirm you have no private-message relays yet. Try again in a moment.' });
      }
      // 2. Sign (the extension asks).
      this.set({ phase: 'signing' });
      let list: NostrEvent;
      try {
        list = await this.d.signer.signEvent(inboxListTemplate(chosen, this.d.now?.()));
      } catch (e) {
        if (e instanceof SignerError && e.code === 'denied') return this.set({ phase: 'declined', message: 'Your extension declined; nothing was published.' });
        return this.set({ phase: 'failed', message: 'Your extension couldn’t sign the relay list.' });
      }
      if (this.stopped) return;
      // 3. Publish where others look for it, and to the inbox relays themselves.
      this.set({ phase: 'publishing' });
      const inbox = inboxRelays(list);
      const discovery = [...new Set([...lookups, ...outbox])];
      const r = await publishInboxList(pool, list, this.d.me, [...new Set([...discovery, ...inbox])], this.d.signer);
      if (this.stopped) return;
      const inboxOk = inbox.filter((u) => r.accepted.includes(u));
      const inboxFailed = inbox.filter((u) => !r.accepted.includes(u));
      const listedOn = r.accepted.filter((u) => discovery.includes(u));
      if (!r.accepted.length) return this.set({ phase: 'failed', inboxOk, inboxFailed, listedOn, message: 'No relay accepted your relay list; nothing changed.' });
      // 4. Read it back where senders look.
      this.set({ phase: 'verifying', inboxOk, inboxFailed, listedOn });
      const back = await findInbox(this.d.lookup, { pubkey: this.d.me, hints: [] }, { lookupRelays: lookups });
      if (this.stopped) return;
      const discoverable = !!back && back.list.id === list.id;
      if (!discoverable) return this.set({ phase: 'unverified', message: 'Published, but not readable back from the lookup relays yet; others may not find it for a while.' });
      if (!inboxOk.length) return this.set({ phase: 'failed', message: 'Your relay list is published, but none of the chosen inbox relays accepted it, so invites may not arrive.' });
      this.set({ phase: inboxFailed.length ? 'partial' : 'done', message: '' });
      this.d.onInbox(list);
    } finally {
      this.busy = false;
      pool.destroy?.();
    }
  }

  /** Disconnect or another identity: ignore anything still in flight. */
  stop() {
    this.stopped = true;
  }
}

/** NIP-01 replaceable: the newest of a kind; on a tie, the lowest id. */
function newest(events: NostrEvent[], kind: number): NostrEvent | null {
  return events.filter((e) => e.kind === kind).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}
