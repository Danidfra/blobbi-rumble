/**
 * THE PLAYER'S NOSTR IDENTITY, in network mode: optional, and separate from
 * the game connection. A guest plays from the first state on; connecting
 * Nostr only proves to the server which key this connection holds, so the
 * slot it plays gets that person's name.
 *
 *   guest     no identity (the default; always fine)
 *   known     a remembered login (method + pubkey): a hint, proves nothing;
 *             one click ("Continue as …") asks the signer again
 *   asking    waiting for the extension (its permission prompt)
 *   proving   waiting for the server: challenge → signature → verdict
 *             (also while the game connection is down and comes back)
 *   verified  the server accepted a fresh proof on THIS connection
 *   error     something said no; the message says what, play goes on
 *
 * Once someone connected in this page, a new game connection (after a
 * drop) is proven again automatically: the server forgets identities with
 * their connection, on purpose.
 *
 * RESTORING (M9B.1): a remembered login made by an explicit connection
 * carries `auto`; on the next visit the page asks the SAME signer for its
 * public key (the extension may prompt once; nothing is signed for this)
 * and, if it is the remembered one, continues exactly as a click would
 * (`restoring` → `proving`). Any other answer stops it: no extension or
 * no answer keeps `known` (a Reconnect button); a refusal keeps `known`
 * and turns `auto` off; another pubkey is `changed`, shown, never
 * switched to without a click. A click or Disconnect during it wins.
 */
import type { ClientMessage, AuthReply } from '../net/protocol';
import { authTemplate } from '../../social/auth';
import { clearLogin, loadLogin, saveLogin } from '../../social/login';
import { SignerError, type NostrSigner, type SignerErrorCode, type SignerMethod } from '../../social/signer';

export type IdentityPhase = 'guest' | 'known' | 'restoring' | 'changed' | 'asking' | 'proving' | 'verified' | 'error';

export interface IdentityState {
  phase: IdentityPhase;
  /** The pubkey in play (remembered, or given by the signer); proven only when phase is 'verified'. */
  pubkey: string | null;
  method: SignerMethod | null;
  error: string | null;
  /** Whether the game server offers the handshake (null: not connected yet). */
  serverSupports: boolean | null;
  /** M9B.1: whether this browser reconnects by itself on the next visit (a remembered, explicit connection). */
  auto: boolean;
  /** M9B.1: the pubkey the extension holds now, when it is not the remembered one (phase 'changed'). */
  other: string | null;
}

export interface IdentityDeps {
  /** The game server's WebSocket URL, exactly as connected to (the proof names it). */
  url: string;
  /** Send to the game server; false when not connected. */
  send: (m: ClientMessage) => boolean;
  /** The signer to use, found when the user asks (null: none available). */
  findSigner: () => Promise<NostrSigner | null>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  storageKey?: string;
  onChange?: () => void;
}

const SIGNER_WORDS: Record<string, string> = {
  unavailable: 'No Nostr extension found. Install one (Alby, nos2x…) or keep playing as a guest.',
  denied: 'Your Nostr extension declined. You are playing as a guest.',
  timeout: 'No answer from your Nostr extension. Check its popup and try again.',
  malformed: 'Your Nostr extension returned something invalid.',
  failed: 'Your Nostr extension reported an error.',
};
const SERVER_WORDS: Record<string, string> = {
  server: "The proof named a different address than this server's (behind a proxy, the host should set PUBLIC_URL).",
  stale: "The proof's time is far from the server's. Is this computer's clock right?",
  signature: 'The server could not verify the signature.',
  expired: 'The sign-in took too long. Try again.',
  busy: 'The server is busy. Try again in a moment.',
};

export class IdentitySession {
  state: IdentityState;
  private signer: NostrSigner | null = null;
  private connected = false;
  private retried = false;
  /** Bumped by every click and by Disconnect: an asynchronous step that outlived it changes nothing. */
  private gen = 0;
  /** The signer that answered with another pubkey during a restore, kept for an explicit "connect as" only. */
  private pending: { signer: NostrSigner; pubkey: string } | null = null;
  private readonly key: string;

  constructor(private readonly d: IdentityDeps) {
    this.key = d.storageKey ?? 'rumble:nostr-login';
    const saved = loadLogin(d.storage, this.key);
    this.state = { phase: saved ? 'known' : 'guest', pubkey: saved?.pubkey ?? null, method: saved?.method ?? null, error: null, serverSupports: null, auto: saved?.auto ?? false, other: null };
  }

  /** The signer, while this connection's identity is proven (for sending invites; null otherwise). */
  get provenSigner(): NostrSigner | null {
    return this.state.phase === 'verified' ? this.signer : null;
  }

  /**
   * The signer this page holds for the player's Nostr identity (connected by
   * a click in this page), whether or not the current game connection has
   * proven it yet; null once disconnected. For reading the player's own
   * private invites, which does not involve the game server.
   */
  get connectedSigner(): NostrSigner | null {
    return this.signer && this.state.pubkey && (this.state.phase === 'verified' || this.state.phase === 'proving') ? this.signer : null;
  }

  /** The pubkey this connection has proven to the server, or null. */
  get verified(): string | null {
    return this.state.phase === 'verified' ? this.state.pubkey : null;
  }

  private set(patch: Partial<IdentityState>) {
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  /** The user clicked Connect (or Continue as …): ask the signer, then prove it to the server. */
  async connect(): Promise<void> {
    if (this.state.phase === 'asking') return;
    const g = ++this.gen;
    this.pending = null;
    this.set({ phase: 'asking', error: null, other: null });
    try {
      const signer = await this.d.findSigner();
      if (!signer) throw new SignerError('unavailable', 'no signer');
      const pubkey = await signer.getPublicKey();
      if (g !== this.gen) return;
      this.adopt(signer, pubkey);
    } catch (e) {
      if (g !== this.gen) return;
      const code = e instanceof SignerError ? e.code : 'failed';
      this.set({ phase: 'error', error: SIGNER_WORDS[code] ?? SIGNER_WORDS.failed });
    }
  }

  /** A signer that answered: remember it (with reconnection on), and prove it to the server. The one path to a connected identity. */
  private adopt(signer: NostrSigner, pubkey: string) {
    this.signer = signer;
    this.pending = null;
    saveLogin(this.d.storage, this.key, signer.method, pubkey, true);
    this.set({ pubkey, method: signer.method, auto: true, other: null });
    this.retried = false;
    this.prove();
  }

  /**
   * M9B.1: on page load, with a remembered login that asked for it, ask
   * the same kind of signer for its public key (no signature) and continue
   * as a click would when it is the remembered one. Once per page; a click
   * or Disconnect meanwhile wins.
   */
  async restore(): Promise<void> {
    const saved = loadLogin(this.d.storage, this.key);
    if (!saved?.auto || this.state.phase !== 'known') return;
    const g = ++this.gen;
    this.set({ phase: 'restoring', error: null });
    let signer: NostrSigner | null = null;
    let pubkey: string | null = null;
    let why: SignerErrorCode | 'other' = 'unavailable';
    try {
      signer = await this.d.findSigner();
      if (signer && signer.method === saved.method) pubkey = await signer.getPublicKey();
    } catch (e) {
      why = e instanceof SignerError ? e.code : 'failed';
      signer = null;
    }
    if (g !== this.gen) return;
    if (signer && pubkey === saved.pubkey) return this.adopt(signer, pubkey);
    if (signer && pubkey) {
      // The extension holds another identity: shown, never switched to by itself.
      this.pending = { signer, pubkey };
      this.set({ phase: 'changed', other: pubkey });
      return;
    }
    // No extension (yet), or no usable answer: back to the hint. A refusal or a time-out also turns reconnection off, so no prompt repeats by itself.
    const keep = why === 'unavailable';
    if (!keep) saveLogin(this.d.storage, this.key, saved.method, saved.pubkey, false);
    this.set({ phase: 'known', auto: keep });
  }

  /** The extension holds another identity than the remembered one, and the user said to use it. */
  connectOther() {
    if (this.state.phase !== 'changed' || !this.pending) return;
    ++this.gen;
    this.adopt(this.pending.signer, this.pending.pubkey);
  }

  /** The extension holds another identity, and the user said not now: stay a hint, without reconnecting by itself. */
  dismissChanged() {
    if (this.state.phase !== 'changed') return;
    ++this.gen;
    this.pending = null;
    const saved = loadLogin(this.d.storage, this.key);
    if (saved) saveLogin(this.d.storage, this.key, saved.method, saved.pubkey, false);
    this.set({ phase: 'known', other: null, auto: false });
  }

  /** Ask the server for a challenge (now, or as soon as the game connection is up). */
  private prove() {
    if (!this.signer) return;
    if (this.connected && this.state.serverSupports === false) {
      this.set({ phase: 'error', error: 'This game server does not support Nostr identity.' });
      return;
    }
    this.set({ phase: 'proving', error: null });
    if (this.connected) this.d.send({ t: 'challenge' });
  }

  /** A new game connection said welcome. */
  onWelcome(features: readonly string[] | undefined) {
    this.connected = true;
    this.state = { ...this.state, serverSupports: !!features?.includes('nostr-auth') };
    // Connected in this page before: prove it again on the new connection.
    if (this.signer && (this.state.phase === 'proving' || this.state.phase === 'verified')) {
      this.retried = false;
      this.prove();
    } else this.d.onChange?.();
  }

  /** The game connection closed: the server has forgotten this connection's identity with it. */
  onClose() {
    this.connected = false;
    if (this.state.phase === 'verified') this.set({ phase: 'proving' });
  }

  /** The server's challenge: sign it (the extension may prompt), send the proof. */
  async onChallenge(challenge: string) {
    const signer = this.signer;
    if (!signer || this.state.phase !== 'proving') return;
    try {
      const event = await signer.signEvent(authTemplate(this.d.url, challenge));
      if (this.signer !== signer || this.state.phase !== 'proving') return;
      if (!this.d.send({ t: 'auth', event: event as unknown as Record<string, unknown> })) return;
    } catch (e) {
      const code = e instanceof SignerError ? e.code : 'failed';
      this.set({ phase: 'error', error: SIGNER_WORDS[code] ?? SIGNER_WORDS.failed });
    }
  }

  /** The server's verdict on a proof. */
  onAuth(r: AuthReply) {
    if (r.reason === 'logged-out') return;
    if (this.state.phase !== 'proving') return;
    if (r.ok && r.pubkey === this.state.pubkey) {
      this.set({ phase: 'verified', error: null });
      return;
    }
    // A slow prompt outlived the challenge: one fresh try.
    if ((r.reason === 'expired' || r.reason === 'no-challenge') && !this.retried) {
      this.retried = true;
      this.prove();
      return;
    }
    this.set({ phase: 'error', error: SERVER_WORDS[r.reason ?? ''] ?? `The server refused the identity (${r.reason ?? 'unknown'}).` });
  }

  /** The user chose to stop using Nostr: forget the login (and with it reconnection), tell the server, keep playing. */
  disconnect() {
    ++this.gen;
    this.signer = null;
    this.pending = null;
    clearLogin(this.d.storage, this.key);
    this.d.send({ t: 'logout' });
    this.set({ phase: 'guest', pubkey: null, method: null, error: null, auto: false, other: null });
  }

  /** Back to guest after an error (keeps the remembered login as a hint, without reconnecting by itself). */
  dismissError() {
    if (this.state.phase !== 'error') return;
    const saved = loadLogin(this.d.storage, this.key);
    if (saved?.auto) saveLogin(this.d.storage, this.key, saved.method, saved.pubkey, false);
    this.signer = null;
    this.set({ phase: saved ? 'known' : 'guest', pubkey: saved?.pubkey ?? null, method: saved?.method ?? null, error: null, auto: false });
  }
}
