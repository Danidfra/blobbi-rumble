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
 * Nothing here runs on page load except reading the remembered login: the
 * signer is asked only after a click. Once someone connected in this page,
 * a new game connection (after a drop) is proven again automatically: the
 * server forgets identities with their connection, on purpose.
 */
import type { ClientMessage, AuthReply } from '../net/protocol';
import { authTemplate } from '../../social/auth';
import { clearLogin, loadLogin, saveLogin } from '../../social/login';
import { SignerError, type NostrSigner, type SignerMethod } from '../../social/signer';

export type IdentityPhase = 'guest' | 'known' | 'asking' | 'proving' | 'verified' | 'error';

export interface IdentityState {
  phase: IdentityPhase;
  /** The pubkey in play (remembered, or given by the signer); proven only when phase is 'verified'. */
  pubkey: string | null;
  method: SignerMethod | null;
  error: string | null;
  /** Whether the game server offers the handshake (null: not connected yet). */
  serverSupports: boolean | null;
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
  private readonly key: string;

  constructor(private readonly d: IdentityDeps) {
    this.key = d.storageKey ?? 'rumble:nostr-login';
    const saved = loadLogin(d.storage, this.key);
    this.state = { phase: saved ? 'known' : 'guest', pubkey: saved?.pubkey ?? null, method: saved?.method ?? null, error: null, serverSupports: null };
  }

  /** The signer, while this connection's identity is proven (for sending invites; null otherwise). */
  get provenSigner(): NostrSigner | null {
    return this.state.phase === 'verified' ? this.signer : null;
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
    this.set({ phase: 'asking', error: null });
    try {
      const signer = await this.d.findSigner();
      if (!signer) throw new SignerError('unavailable', 'no signer');
      const pubkey = await signer.getPublicKey();
      this.signer = signer;
      saveLogin(this.d.storage, this.key, signer.method, pubkey);
      this.set({ pubkey, method: signer.method });
      this.retried = false;
      this.prove();
    } catch (e) {
      const code = e instanceof SignerError ? e.code : 'failed';
      this.set({ phase: 'error', error: SIGNER_WORDS[code] ?? SIGNER_WORDS.failed });
    }
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

  /** The user chose to stop using Nostr: forget the login, tell the server, keep playing. */
  disconnect() {
    this.signer = null;
    clearLogin(this.d.storage, this.key);
    this.d.send({ t: 'logout' });
    this.set({ phase: 'guest', pubkey: null, method: null, error: null });
  }

  /** Back to guest after an error (keeps the remembered login as a hint). */
  dismissError() {
    if (this.state.phase !== 'error') return;
    const saved = loadLogin(this.d.storage, this.key);
    this.signer = null;
    this.set({ phase: saved ? 'known' : 'guest', pubkey: saved?.pubkey ?? null, method: saved?.method ?? null, error: null });
  }
}
