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
 *
 * AUTOMATIC CHECKING (M8C-B.2): the same check, started by the page instead
 * of a click, once the player has said so. The consent is one preference
 * per identity and per origin (localStorage: 'on' or 'off', nothing else;
 * 'off' also means "Not now", so the offer is not repeated). With it 'on',
 * an identity that connects with NIP-44 and a located inbox starts the
 * check by itself (the same budget, the same remembered ids, the same live
 * subscription afterwards) and the panel says it is listening. A refusal or
 * a timeout from the signer PAUSES it: nothing is asked again until the
 * player clicks Try again. Turning it off closes the subscription at once
 * and leaves the manual check available; it never touches the kind 10050.
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

export type InboxPhase = 'idle' | 'no-nip44' | 'locating' | 'no-inbox' | 'checking' | 'live' | 'declined' | 'paused' | 'error';

/** The automatic-checking preference of this identity on this origin: never answered, enabled, or off ("Not now" or turned off). */
export type AutoPref = 'unasked' | 'on' | 'off';

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
  /** M8C-B.2: whether the page may check by itself. */
  auto: AutoPref;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type PrefStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface InviteInboxDeps {
  signer: NostrSigner;
  me: string;
  lookup: BoundedPool;
  /** A pool for the inbox subscription (closed when the inbox stops). */
  subscribePool: () => SubscribePoolLike & { destroy?: () => void };
  lookupRelays?: readonly string[];
  /** Session memory: ids of wraps already judged (sessionStorage). */
  storage: Store | null;
  /** The automatic-checking preference (localStorage: one word per identity, nothing else). */
  prefs?: PrefStore | null;
  now?: () => number;
  onChange?: () => void;
  /** A new invite arrived after the first check (for a toast). */
  onLiveInvite?: (invite: ReceivedInvite) => void;
  /** Automatic checking paused because the signer refused or did not answer (for a toast). */
  onPaused?: () => void;
}

const AUTO_KEY = (me: string) => `rumble:auto-invites:v1:${me}`;

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
  /** Bumped whenever listening stops: a run that awaited across it goes no further. */
  private gen = 0;
  /** Ends the wait for stored wraps early when listening stops. */
  private cancelFetch: (() => void) | null = null;
  private readonly key: string;

  constructor(private readonly d: InviteInboxDeps) {
    this.key = `rumble:invites-seen:v1:${d.me}`;
    this.state = { phase: d.signer.nip44 ? 'idle' : 'no-nip44', invites: [], checked: 0, skipped: 0, relays: 0, left: INBOX.budget, auto: this.loadAuto() };
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
    this.autoStart();
    return found;
  }

  /** The player's inbox is known now (set up just now, or found by the setup's own check). */
  adopt(list: NostrEvent) {
    const relays = inboxFromList(list);
    if (!relays.length || list.pubkey !== this.d.me) return;
    this.found = { relays, list };
    // Only an inbox-less state moves on; a check, a pause or a decline keeps its state (no second prompt from here).
    this.set({ relays: relays.length, ...(this.state.phase === 'no-inbox' || this.state.phase === 'locating' ? { phase: 'idle' as const } : {}) });
    this.autoStart();
  }

  private now() {
    return this.d.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private set(patch: Partial<InboxState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  // ─── Automatic checking (M8C-B.2) ─────────────────────────────────────────

  /** Whether to ask the player about automatic checking now: it could work (NIP-44, an inbox) and they were never asked. */
  get offersAuto(): boolean {
    return !this.stopped && !!this.d.signer.nip44 && !!this.found && this.state.auto === 'unasked';
  }

  /** "Enable automatic invites": remembered for this identity on this origin; the check starts now. */
  enableAuto() {
    if (this.stopped) return;
    this.saveAuto('on');
    this.set({ auto: 'on' });
    this.autoStart(true);
  }

  /** "Not now": remembered so the offer is not repeated; the manual check stays. Nothing is decrypted. */
  declineAuto() {
    if (this.stopped) return;
    this.saveAuto('off');
    this.set({ auto: 'off' });
  }

  /** Turn automatic checking off: the subscription closes at once; invites already shown stay; the kind 10050 is untouched. */
  disableAuto() {
    if (this.stopped) return;
    this.saveAuto('off');
    const listening = ['checking', 'live', 'paused'].includes(this.state.phase);
    if (listening) this.stopListening();
    this.set({ auto: 'off', ...(listening ? { phase: 'idle' as const, left: INBOX.budget } : {}) });
  }

  /**
   * Start the check by itself when allowed: consent given, NIP-44 there, an
   * inbox located, nothing running. By itself only from idle: a pause (a
   * refusal) or a decline is never retried without a click; the click that
   * enables automatic checking counts as one.
   */
  private autoStart(explicit = false) {
    if (this.stopped || this.state.auto !== 'on' || !this.d.signer.nip44 || !this.found || this.checking) return;
    if (this.state.phase !== 'idle' && !(explicit && (this.state.phase === 'paused' || this.state.phase === 'declined'))) return;
    void this.check();
  }

  private loadAuto(): AutoPref {
    try {
      const v = this.d.prefs?.getItem(AUTO_KEY(this.d.me));
      return v === 'on' || v === 'off' ? v : 'unasked';
    } catch {
      return 'unasked';
    }
  }

  private saveAuto(v: 'on' | 'off') {
    try {
      this.d.prefs?.setItem(AUTO_KEY(this.d.me), v);
    } catch {
      // Storage blocked: the choice holds for this page only.
    }
  }

  // ─── The check ────────────────────────────────────────────────────────────

  /** The player asked (or automatic checking did): locate the inbox, fetch recent wraps, open at most the budget, then keep listening. */
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
    const g = ++this.gen;
    if (this.locating) await this.locating;
    if (this.stopped || g !== this.gen) return;
    this.set({ phase: 'locating', checked: 0, skipped: 0, left: INBOX.budget });
    const found = this.found ?? (await this.locate());
    if (this.stopped || g !== this.gen) return;
    if (!found) return this.set({ phase: 'no-inbox' });
    this.set({ phase: 'checking', relays: found.relays.length });
    this.d.lookup.makeRoom(found.relays.length);
    this.pool = this.d.subscribePool();
    const fetched: NostrEvent[] = [];
    await new Promise<void>((done) => {
      const timer = setTimeout(done, INBOX.fetchWait);
      this.cancelFetch = () => {
        clearTimeout(timer);
        done();
      };
      this.sub = subscribeGiftWraps(this.pool!, found.relays, this.d.me, {
        since: this.now() - INBOX.window,
        limit: INBOX.fetchLimit,
        auth: inboxRelayAuth(this.d.signer, found.relays),
        maxWait: INBOX.fetchWait,
        onevent: (e) => {
          if (g !== this.gen) return;
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
    this.cancelFetch = null;
    if (this.stopped || g !== this.gen) return;
    // Newest first; one entry per wrap however many relays sent it.
    const unique = [...new Map(fetched.map((e) => [e.id, e])).values()].sort((a, b) => b.created_at - a.created_at);
    this.initialDone = true;
    await this.process(unique, 'initial', g);
    if (this.stopped || g !== this.gen) return;
    this.set({ phase: 'live' });
    void this.drain();
  }

  private async drain() {
    if (this.draining || !this.initialDone) return;
    this.draining = true;
    const g = this.gen;
    try {
      while (this.queue.length && !this.stopped && g === this.gen) await this.process(this.queue.splice(0), 'live', g);
    } finally {
      this.draining = false;
    }
  }

  /** Open each new wrap within the budget; keep valid invites, drop everything else right here. */
  private async process(wraps: NostrEvent[], pass: 'initial' | 'live', g: number) {
    for (const wrap of wraps) {
      if (this.stopped || g !== this.gen) return;
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
      // Listening stopped while the signer was busy: this wrap was not judged; let a later check open it.
      const stale = () => {
        if (!this.stopped && g === this.gen) return false;
        this.seenWraps.delete(wrap.id);
        return true;
      };
      try {
        const rumor = await unwrapGiftWrap(this.d.signer, wrap, this.d.me);
        const parsed = parseInvite(rumor, this.d.me, this.now());
        // An unrelated message (or a reject) goes no further than this line: nothing of it is kept.
        if (parsed.ok && !this.seenRumors.has(parsed.invite.id)) invite = parsed.invite;
      } catch (e) {
        if (stale()) return;
        if (e instanceof SignerError && (e.code === 'denied' || e.code === 'timeout' || e.code === 'unavailable')) {
          // The player (or their extension) said no, or nothing answered: stop asking. The wrap is not judged.
          this.seenWraps.delete(wrap.id);
          const paused = this.state.auto === 'on';
          this.stopListening();
          this.set({ phase: paused ? 'paused' : 'declined' });
          if (paused) this.d.onPaused?.();
          return;
        }
        if (!(e instanceof UnwrapError) && !(e instanceof SignerError)) throw e;
      }
      if (stale()) return;
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
    this.seenRumors.clear();
    this.inviteWrap.clear();
    this.dismissed.clear();
    this.state = { phase: 'idle', invites: [], checked: 0, skipped: 0, relays: 0, left: 0, auto: this.state.auto };
  }

  /** Close the subscription and its pool; anything still in flight for them stops at its next step. */
  private stopListening() {
    this.gen++;
    this.initialDone = false;
    this.queue.length = 0;
    this.cancelFetch?.();
    this.cancelFetch = null;
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
