/**
 * RECEIVING RUMBLE INVITES (M8C-B), inside Rumble, for the connected player.
 *
 * NIP-17 hides what a private message is until it is decrypted, so finding
 * invites means decrypting recent gift wraps addressed to the player. That
 * happens only after the player asks ("Check invites"), only on this
 * device (the signer's NIP-44; nothing goes to the Rumble server), for a
 * bounded number of wraps, newest first:
 *
 *   locate    the player's own kind-10050 inbox (no list: nothing to check)
 *   fetch     kind 1059 #p me, a recent window, from those relays (at most 3)
 *   open      unwrapGiftWrap (every NIP-17 check), then parseInvite (only
 *             the blobbi:rumble:invite:v1 marker makes an invite)
 *   keep      valid invites only, in memory, de-duplicated by wrap and
 *             rumor id; everything else is dropped where it was opened
 *   live      after the first pass, new wraps keep arriving while the page
 *             is open and the identity is connected (a second budget)
 *
 * What is remembered across reloads (sessionStorage, this identity only):
 * the ids of wraps already looked at that are NOT live invites (unrelated
 * messages, rejects, dismissed or expired invites), so a reload does not ask
 * the signer to decrypt them again. Ids only: no content, no sender, no
 * time. A live invite's wrap is not remembered: after a reload it is opened
 * again (it must be, to show it, since its content is not stored).
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { findInbox, inboxFromList, inboxRelayAuth, subscribeGiftWraps, type FoundInbox, type GiftWrapSubscription, type SubscribePoolLike } from '../../social/inbox';
import { NIP17, UnwrapError, unwrapGiftWrap } from '../../social/nip17';
import type { BoundedPool } from '../../social/pool';
import { SignerError, type NostrSigner } from '../../social/signer';
import { INVITE_LIFETIME, parseInvite, type ReceivedInvite } from './invites';

export const INBOX = Object.freeze({
  /** Gift wraps decrypted in the first check, newest first. */
  budget: 30,
  /** Gift wraps decrypted live afterwards, in this page. */
  liveBudget: 30,
  /** How many wraps to ask each relay for (more than the budget: some are already known). */
  fetchLimit: 60,
  /** How far back to look, seconds: wraps are backdated up to two days, invites live 30 minutes. */
  window: NIP17.maxBackdate + INVITE_LIFETIME + 10 * 60,
  /** Remembered wrap ids per identity. */
  maxRemembered: 300,
  /** Waiting for the inbox relays' stored wraps, ms. */
  fetchWait: 6000,
});

export type InboxPhase = 'idle' | 'no-nip44' | 'locating' | 'no-inbox' | 'checking' | 'live' | 'declined' | 'error';

export interface InboxState {
  phase: InboxPhase;
  /** Valid, unexpired, undismissed invites, newest first. */
  invites: ReceivedInvite[];
  /** What the last check did (counts only). */
  checked: number;
  skipped: number;
  relays: number;
  /** Decryptions left in the current budget. */
  left: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface InviteInboxDeps {
  signer: NostrSigner;
  me: string;
  lookup: BoundedPool;
  /** A pool for the inbox subscription (closed when the inbox stops). */
  subscribePool: () => SubscribePoolLike & { destroy?: () => void };
  lookupRelays?: readonly string[];
  storage: Store | null;
  now?: () => number;
  onChange?: () => void;
  /** A new invite arrived after the first check (for a toast). */
  onLiveInvite?: (invite: ReceivedInvite) => void;
}

export class InviteInbox {
  state: InboxState;
  private readonly seenWraps = new Set<string>();
  private readonly seenRumors = new Set<string>();
  private readonly dismissed = new Set<string>();
  private readonly inviteWrap = new Map<string, string>();
  private readonly queue: NostrEvent[] = [];
  private sub: GiftWrapSubscription | null = null;
  private pool: (SubscribePoolLike & { destroy?: () => void }) | null = null;
  private draining = false;
  /** The player's inbox, once located (or set up). */
  private found: FoundInbox | null = null;
  private locating: Promise<FoundInbox | null> | null = null;
  private checking = false;
  private stopped = false;
  private initialDone = false;
  private live = INBOX.liveBudget;
  private readonly key: string;

  constructor(private readonly d: InviteInboxDeps) {
    this.key = `rumble:invites-seen:v1:${d.me}`;
    this.state = { phase: d.signer.nip44 ? 'idle' : 'no-nip44', invites: [], checked: 0, skipped: 0, relays: 0, left: INBOX.budget };
    for (const id of this.loadSeen()) this.seenWraps.add(id);
    // Where the player's private messages arrive is public: look it up now (nothing is decrypted).
    if (d.signer.nip44) {
      this.state = { ...this.state, phase: 'locating' };
      this.locating = this.locate();
    }
  }

  /** Find the player's own kind-10050 inbox (public data; no decryption). */
  private async locate(): Promise<FoundInbox | null> {
    const found = await findInbox(this.d.lookup, { pubkey: this.d.me, hints: [] }, { lookupRelays: this.d.lookupRelays });
    if (this.stopped) return null;
    this.found = found;
    if (this.state.phase === 'locating') this.set(found ? { phase: 'idle', relays: found.relays.length } : { phase: 'no-inbox' });
    return found;
  }

  /** The player's inbox is known now (set up just now, or found by the setup's own check). */
  adopt(list: NostrEvent) {
    const relays = inboxFromList(list);
    if (!relays.length || list.pubkey !== this.d.me) return;
    this.found = { relays, list };
    this.set({ phase: 'idle', relays: relays.length });
  }

  private now() {
    return this.d.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private set(patch: Partial<InboxState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  /** The player asked: locate the inbox, fetch recent wraps, open at most the budget, then keep listening. */
  async check(): Promise<void> {
    if (this.stopped || !this.d.signer.nip44 || this.checking || ['checking', 'live'].includes(this.state.phase)) return;
    this.checking = true;
    try {
      await this.runCheck();
    } finally {
      this.checking = false;
    }
  }

  private async runCheck(): Promise<void> {
    if (this.locating) await this.locating;
    this.set({ phase: 'locating', checked: 0, skipped: 0, left: INBOX.budget });
    const found = this.found ?? (await this.locate());
    if (this.stopped) return;
    if (!found) return this.set({ phase: 'no-inbox' });
    this.set({ phase: 'checking', relays: found.relays.length });
    this.d.lookup.makeRoom(found.relays.length);
    this.pool = this.d.subscribePool();
    const fetched: NostrEvent[] = [];
    await new Promise<void>((done) => {
      const timer = setTimeout(done, INBOX.fetchWait);
      this.sub = subscribeGiftWraps(this.pool!, found.relays, this.d.me, {
        since: this.now() - INBOX.window,
        limit: INBOX.fetchLimit,
        auth: inboxRelayAuth(this.d.signer, found.relays),
        maxWait: INBOX.fetchWait,
        onevent: (e) => {
          if (this.initialDone) {
            this.queue.push(e);
            void this.drain();
          } else fetched.push(e);
        },
        oneose: () => {
          clearTimeout(timer);
          done();
        },
      });
    });
    if (this.stopped) return;
    // Newest first; one entry per wrap however many relays sent it.
    const unique = [...new Map(fetched.map((e) => [e.id, e])).values()].sort((a, b) => b.created_at - a.created_at);
    this.initialDone = true;
    await this.process(unique, 'initial');
    if (this.stopped || this.state.phase === 'declined') return;
    this.set({ phase: 'live' });
    void this.drain();
  }

  private async drain() {
    if (this.draining || !this.initialDone) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) await this.process(this.queue.splice(0), 'live');
    } finally {
      this.draining = false;
    }
  }

  /** Open each new wrap within the budget; keep valid invites, drop everything else right here. */
  private async process(wraps: NostrEvent[], pass: 'initial' | 'live') {
    for (const wrap of wraps) {
      if (this.stopped) return;
      if (this.seenWraps.has(wrap.id)) {
        if (pass === 'initial') this.set({ skipped: this.state.skipped + 1 });
        continue;
      }
      const left = pass === 'initial' ? this.state.left : this.live;
      if (left <= 0) return;
      if (pass === 'initial') this.set({ left: left - 1 });
      else this.live -= 1;
      this.seenWraps.add(wrap.id);
      let invite: ReceivedInvite | null = null;
      try {
        const rumor = await unwrapGiftWrap(this.d.signer, wrap, this.d.me);
        const parsed = parseInvite(rumor, this.d.me, this.now());
        // An unrelated message (or a reject) goes no further than this line: nothing of it is kept.
        if (parsed.ok && !this.seenRumors.has(parsed.invite.id)) invite = parsed.invite;
      } catch (e) {
        if (e instanceof SignerError && e.code === 'denied') {
          // The player said no: stop asking.
          this.seenWraps.delete(wrap.id);
          this.set({ phase: 'declined' });
          this.stopListening();
          return;
        }
        if (!(e instanceof UnwrapError) && !(e instanceof SignerError)) throw e;
      }
      if (this.stopped) return;
      if (pass === 'initial') this.set({ checked: this.state.checked + 1 });
      if (!invite) {
        this.remember(wrap.id);
        continue;
      }
      this.seenRumors.add(invite.id);
      this.inviteWrap.set(invite.id, wrap.id);
      if (this.dismissed.has(invite.id)) continue;
      this.set({ invites: [invite, ...this.state.invites].sort((a, b) => b.createdAt - a.createdAt) });
      if (pass === 'live') this.d.onLiveInvite?.(invite);
    }
  }

  /** Hide an invite (this page and this session; nothing is sent). */
  dismiss(id: string) {
    this.dismissed.add(id);
    const wrap = this.inviteWrap.get(id);
    if (wrap) this.remember(wrap);
    this.set({ invites: this.state.invites.filter((i) => i.id !== id) });
  }

  /** Drop invites that have expired since they arrived (and remember their wraps). */
  expire() {
    const now = this.now();
    const gone = this.state.invites.filter((i) => now >= i.expiresAt);
    if (!gone.length) return;
    for (const i of gone) {
      const wrap = this.inviteWrap.get(i.id);
      if (wrap) this.remember(wrap);
    }
    this.set({ invites: this.state.invites.filter((i) => now < i.expiresAt) });
  }

  /** The identity went away (or changed): stop listening and forget everything held in memory. */
  stop() {
    this.stopListening();
    this.stopped = true;
    this.queue.length = 0;
    this.seenRumors.clear();
    this.inviteWrap.clear();
    this.dismissed.clear();
    this.state = { phase: 'idle', invites: [], checked: 0, skipped: 0, relays: 0, left: 0 };
  }

  private stopListening() {
    this.sub?.close();
    this.sub = null;
    this.pool?.destroy?.();
    this.pool = null;
  }

  private loadSeen(): string[] {
    try {
      const v = JSON.parse(this.d.storage?.getItem(this.key) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)).slice(-INBOX.maxRemembered) : [];
    } catch {
      return [];
    }
  }

  private remember(wrapId: string) {
    try {
      const ids = this.loadSeen().filter((x) => x !== wrapId);
      ids.push(wrapId);
      this.d.storage?.setItem(this.key, JSON.stringify(ids.slice(-INBOX.maxRemembered)));
    } catch {
      // Storage blocked: the next reload asks again.
    }
  }
}
