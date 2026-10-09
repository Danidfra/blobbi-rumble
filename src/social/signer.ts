/**
 * SIGNERS: whatever holds the user's key, behind one small interface. The
 * page never sees a secret key: it asks a signer for the public key and for
 * signatures, and checks what comes back (a signer is outside code too).
 *
 *   NIP-07  a browser extension at `window.nostr` (Alby, nos2x, …)
 *   NIP-46  a remote signer (phone, bunker): not wired yet; it fits the
 *           same interface (nostr-tools' BunkerSigner already does)
 *
 * The interface is nostr-tools' own `Signer`, with the method named, so a
 * BunkerSigner or `window.nostr` drop in. Every call has a timeout (a
 * prompt may sit unanswered) and its failure is classified for the UI.
 * Framework-free; no Rumble imports.
 */
import { verifyEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { WindowNostr } from 'nostr-tools/nip07';
import type { Signer } from 'nostr-tools/signer';
import { normalizePubkey } from './keys';

export type SignerMethod = 'nip07' | 'nip46';

export interface NostrSigner extends Signer {
  readonly method: SignerMethod;
}

export type SignerErrorCode =
  /** No signer to ask (no extension installed, or not yet injected). */
  | 'unavailable'
  /** The user said no (or closed the prompt). */
  | 'denied'
  /** No answer in time. */
  | 'timeout'
  /** An answer that is not what was asked for (a bad pubkey, an event that does not verify). */
  | 'malformed'
  /** Anything else the signer threw. */
  | 'failed';

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

export const SIGNER = Object.freeze({
  /** How long to wait for an extension to appear after load (they inject late), ms. */
  detectMs: 1500,
  /** How long a user may take to answer a prompt, ms. */
  promptMs: 60_000,
});

/** Wait for `x`, at most `ms`; a timeout rejects with a SignerError. */
export function withTimeout<T>(x: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignerError('timeout', `${what}: no answer from the signer`)), ms);
    x.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A signer's own error, as one of our codes (extensions word refusals in many ways). */
export function classify(e: unknown, what: string): SignerError {
  if (e instanceof SignerError) return e;
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/den(y|ied)|reject|refus|cancel|declin|not allowed|permission|user/i.test(text)) return new SignerError('denied', `${what}: refused`);
  return new SignerError('failed', `${what}: ${text.slice(0, 120) || 'the signer failed'}`);
}

/** A NIP-07 extension, if the page has one: `window.nostr` with the two calls we need. */
export function nip07From(win: unknown): WindowNostr | null {
  const n = (win as { nostr?: unknown } | null)?.nostr as Partial<WindowNostr> | undefined;
  return n && typeof n.getPublicKey === 'function' && typeof n.signEvent === 'function' ? (n as WindowNostr) : null;
}

/** Wait briefly for an extension to inject itself (they often do after load); null if none appears. */
export async function findNip07(win: unknown, waitMs: number = SIGNER.detectMs, pollMs = 100): Promise<WindowNostr | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ext = nip07From(win);
    if (ext || Date.now() >= deadline) return ext;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A signed event checked against what was asked: it verifies (id and
 * signature), it is by `pubkey`, and it is the template (kind, content,
 * tags; created_at the signer may set).
 */
export function checkSigned(ev: unknown, template: EventTemplate, pubkey: string | null): VerifiedEvent {
  const e = ev as VerifiedEvent;
  const ok =
    !!e &&
    typeof e === 'object' &&
    e.kind === template.kind &&
    e.content === template.content &&
    JSON.stringify(e.tags) === JSON.stringify(template.tags) &&
    Number.isSafeInteger(e.created_at) &&
    (pubkey === null || e.pubkey === pubkey) &&
    verifyEvent(e);
  if (!ok) throw new SignerError('malformed', 'the signer returned an event that does not verify');
  return e;
}

/**
 * The NIP-07 signer: the extension's two calls with timeouts, classified
 * errors, and checks on what they return.
 */
export function nip07Signer(ext: WindowNostr, opts: { promptMs?: number } = {}): NostrSigner {
  const promptMs = opts.promptMs ?? SIGNER.promptMs;
  let known: string | null = null;
  return {
    method: 'nip07',
    async getPublicKey() {
      let raw: unknown;
      try {
        raw = await withTimeout(Promise.resolve().then(() => ext.getPublicKey()), promptMs, 'public key');
      } catch (e) {
        throw classify(e, 'public key');
      }
      const pk = normalizePubkey(raw);
      if (!pk) throw new SignerError('malformed', 'the signer returned a malformed public key');
      known = pk;
      return pk;
    },
    async signEvent(template: EventTemplate) {
      let ev: unknown;
      try {
        ev = await withTimeout(Promise.resolve().then(() => ext.signEvent(template)), promptMs, 'signature');
      } catch (e) {
        throw classify(e, 'signature');
      }
      return checkSigned(ev, template, known);
    },
  };
}
