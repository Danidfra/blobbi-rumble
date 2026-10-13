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
 *
 * WHICH SERVER (L4.5B): a proof tells the game server who the player is,
 * so it only goes by itself to a server this page trusts (`trusted`: built
 * in, this site's own, or an exact address approved before). On any other
 * server, a remembered login is NOT restored (`held`: no extension is even
 * asked), and Connect first asks (`confirm`): only a yes (`confirmServer`)
 * approves that exact address (`approve`) and goes on as a click would.
 * No proof ever leaves without the player having said yes to that server.
 */
import type { ClientMessage, AuthReply } from '../net/protocol';
import { authTemplate } from '../../social/auth';
import { clearLogin, loadLogin, saveLogin } from '../../social/login';
import { SignerError, withTimeout, type NostrSigner, type SignerErrorCode, type SignerMethod } from '../../social/signer';

export const RESTORE = Object.freeze({
  /** How long a restore waits for the extension to be found and to answer with its public key, ms (a click waits longer: it may be a prompt). */
  waitMs: 15_000,
});

export type IdentityPhase = 'guest' | 'known' | 'restoring' | 'changed' | 'confirm' | 'asking' | 'proving' | 'verified' | 'error';

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
  /** L4.5B: a remembered login was not restored by itself because this server is not trusted with it (yet). */
  held: boolean;
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
  /** How long a restore waits for the extension, ms (tests shorten it). */
  restoreMs?: number;
  onChange?: () => void;
  /** Development diagnostics: the stage a connection or restore reached and why (never a key, a signature, a challenge or a message). */
  diag?: (stage: string, detail?: string) => void;
  /** M12: what to say when no signer is found, if not the desktop words (a phone has no extension store of the same kind). */
  unavailable?: string;
  /** L4.5B: whether this game server may be sent a proof without asking (absent: yes, as before). */
  trusted?: () => boolean;
  /** L4.5B: the player said yes to proving to this server: remember that exact address. */
  approve?: () => void;
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
    this.state = { phase: saved ? 'known' : 'guest', pubkey: saved?.pubkey ?? null, method: saved?.method ?? null, error: null, serverSupports: null, auto: saved?.auto ?? false, other: null, held: false };
  }

  /** L4.5B: whether proofs may go to this server without asking. */
  private get trusted(): boolean {
    return this.d.trusted ? this.d.trusted() : true;
  }

  /** L4.5B: where Connect was clicked from, to go back to on "Stay a guest". */
  private beforeConfirm: 'guest' | 'known' = 'guest';

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

  /** What to tell the player about a signer failure. */
  private words(code: string): string {
    if (code === 'unavailable' && this.d.unavailable) return this.d.unavailable;
    return SIGNER_WORDS[code] ?? SIGNER_WORDS.failed;
  }

  private set(patch: Partial<IdentityState>) {
    this.state = { ...this.state, ...patch };
    this.d.onChange?.();
  }

  /** The user clicked Connect (or Continue as …): ask the signer, then prove it to the server. */
  async connect(): Promise<void> {
    if (this.state.phase === 'asking') return;
    // L4.5B: a server not trusted with the identity: ask first (nothing is asked of the extension, nothing is sent).
    if (!this.trusted) {
      if (this.state.phase === 'confirm') return;
      ++this.gen;
      this.beforeConfirm = this.state.pubkey && loadLogin(this.d.storage, this.key) ? 'known' : 'guest';
      this.d.diag?.('connect:confirm', 'this server is not trusted with the identity yet: asking first');
      this.set({ phase: 'confirm', error: null, other: null });
      return;
    }
    const g = ++this.gen;
    this.pending = null;
    this.d.diag?.('connect:start', `gen ${g}, from ${this.state.phase}`);
    this.set({ phase: 'asking', error: null, other: null });
    try {
      const signer = await this.d.findSigner();
      this.d.diag?.('connect:signer', signer ? signer.method : 'none');
      if (!signer) throw new SignerError('unavailable', 'no signer');
      const pubkey = await signer.getPublicKey();
      this.d.diag?.('connect:pubkey', `${pubkey.slice(0, 8)}…`);
      if (g !== this.gen) return this.d.diag?.('connect:superseded', `gen ${g} → ${this.gen}`);
      this.adopt(signer, pubkey);
    } catch (e) {
      if (g !== this.gen) return this.d.diag?.('connect:superseded', `gen ${g} → ${this.gen}`);
      const code = e instanceof SignerError ? e.code : 'failed';
      this.d.diag?.('connect:failed', code);
      this.set({ phase: 'error', error: this.words(code) });
    }
  }

  /**
   * L4.5B: the player said yes to this server (the `confirm` question, or
   * "Connect" on a held login): remember the exact address, then connect as
   * a click on a trusted server does.
   */
  async confirmServer(): Promise<void> {
    if (this.state.phase !== 'confirm' && !(this.state.phase === 'known' && this.state.held)) return;
    this.d.approve?.();
    this.set({ held: false });
    if (!this.trusted) {
      // The approval could not be kept (storage refused it): nothing goes without it.
      this.set({ phase: 'error', error: 'This browser could not remember the server; your identity was not shared.' });
      return;
    }
    this.d.diag?.('connect:approved', 'the player approved this server');
    await this.connect();
  }

  /** L4.5B: "Stay a guest": nothing was shared; back to where Connect was clicked. */
  cancelConfirm() {
    if (this.state.phase !== 'confirm') return;
    ++this.gen;
    this.set({ phase: this.beforeConfirm, error: null });
  }

  /** A signer that answered: remember it (with reconnection on), and prove it to the server. The one path to a connected identity. */
  private adopt(signer: NostrSigner, pubkey: string) {
    this.signer = signer;
    this.pending = null;
    saveLogin(this.d.storage, this.key, signer.method, pubkey, true);
    this.set({ pubkey, method: signer.method, auto: true, other: null });
    this.retried = false;
    this.d.diag?.('adopted', `${pubkey.slice(0, 8)}… → proving (game ${this.connected ? 'connected' : 'not connected yet'})`);
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
    this.d.diag?.('restore:start', !saved ? 'no remembered login' : !saved.auto ? 'remembered, auto off' : this.state.phase !== 'known' ? `phase ${this.state.phase}, not known` : `remembered ${saved.pubkey.slice(0, 8)}…, auto on`);
    if (!saved?.auto || this.state.phase !== 'known') return;
    // L4.5B: another server than the trusted ones: the login is kept for them, and not used here without a yes.
    if (!this.trusted) {
      this.d.diag?.('restore:held', 'this server is not trusted with the identity: not restored by itself');
      this.set({ held: true });
      return;
    }
    const g = ++this.gen;
    this.set({ phase: 'restoring', error: null });
    let signer: NostrSigner | null = null;
    let pubkey: string | null = null;
    let why: SignerErrorCode | 'other' = 'unavailable';
    // Bounded, whatever the extension does: a restore must settle, and it is silent work, not a prompt the player is answering.
    const wait = this.d.restoreMs ?? RESTORE.waitMs;
    const t0 = Date.now();
    try {
      signer = await withTimeout(this.d.findSigner(), wait, 'restore');
      this.d.diag?.('restore:signer', `${signer ? `found (${signer.method})` : 'NOT FOUND (no NIP-07 provider within the detection window)'} after ${Date.now() - t0} ms`);
      if (signer && signer.method !== saved.method) this.d.diag?.('restore:method', `remembered ${saved.method}, found ${signer.method}: not asked`);
      if (signer && signer.method === saved.method) {
        const t1 = Date.now();
        try {
          pubkey = await withTimeout(signer.getPublicKey(), wait, 'restore');
          this.d.diag?.('restore:pubkey', `answered after ${Date.now() - t1} ms: ${pubkey.slice(0, 8)}… (${pubkey === saved.pubkey ? 'the remembered one' : 'ANOTHER identity'})`);
        } catch (e) {
          this.d.diag?.('restore:pubkey', `${e instanceof SignerError ? e.code : 'failed'} after ${Date.now() - t1} ms`);
          throw e;
        }
      }
    } catch (e) {
      why = e instanceof SignerError ? e.code : 'failed';
      if (!signer) this.d.diag?.('restore:signer', `${why} after ${Date.now() - t0} ms`);
      signer = null;
    }
    if (g !== this.gen) return this.d.diag?.('restore:superseded', `gen ${g} → ${this.gen} (a click or Disconnect meanwhile)`);
    if (signer && pubkey === saved.pubkey) return this.adopt(signer, pubkey);
    if (signer && pubkey) {
      // The extension holds another identity: shown, never switched to by itself.
      this.pending = { signer, pubkey };
      this.d.diag?.('restore:end', 'changed (another identity in the extension)');
      this.set({ phase: 'changed', other: pubkey });
      return;
    }
    // No extension (yet), or no usable answer: back to the hint. A refusal or a time-out also turns reconnection off, so no prompt repeats by itself.
    const keep = why === 'unavailable';
    if (!keep) saveLogin(this.d.storage, this.key, saved.method, saved.pubkey, false);
    this.d.diag?.('restore:end', `known (${why}); auto ${keep ? 'kept' : 'turned off'}`);
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
    // L4.5B: the last guard: no challenge, so no proof, to a server the player has not said yes to.
    if (!this.trusted) {
      this.d.diag?.('prove:refused', 'this server is not trusted with the identity');
      this.set({ phase: 'confirm', error: null });
      return;
    }
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
    this.d.diag?.('game:welcome', `nostr-auth ${features?.includes('nostr-auth') ? 'offered' : 'NOT offered'}; identity ${this.state.phase}`);
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
    this.d.diag?.('game:challenge', 'received; asking the extension to sign');
    try {
      const event = await signer.signEvent(authTemplate(this.d.url, challenge));
      if (this.signer !== signer || this.state.phase !== 'proving') return this.d.diag?.('game:proof', 'signed, but the identity moved on meanwhile');
      const sent = this.d.send({ t: 'auth', event: event as unknown as Record<string, unknown> });
      this.d.diag?.('game:proof', sent ? 'signed and sent' : 'signed, but the game connection is down');
    } catch (e) {
      const code = e instanceof SignerError ? e.code : 'failed';
      this.d.diag?.('game:proof', `signing ${code}`);
      this.set({ phase: 'error', error: this.words(code) });
    }
  }

  /** The server's verdict on a proof. */
  onAuth(r: AuthReply) {
    if (r.reason === 'logged-out') return;
    this.d.diag?.('game:auth', r.ok ? 'accepted' : `refused (${r.reason ?? 'unknown'})`);
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
