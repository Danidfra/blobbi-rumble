/**
 * NIP-17 PRIVATE MESSAGES (sending, and since M8C-B receiving): an unsigned rumor, sealed by
 * the sender (NIP-44 to the recipient, signed kind 13), gift-wrapped by a
 * one-time key (NIP-44 to the recipient, signed kind 1059). NIP-59 layers;
 * NIP-44 v2 encryption throughout. Framework-free; no Rumble imports.
 *
 *   rumor   kind 14 (or another), pubkey = sender, real created_at, id = its
 *           hash, NO signature (deniable if leaked)
 *   seal    kind 13, content = signer.nip44.encrypt(recipient, rumor JSON),
 *           tags EMPTY (NIP-59: "Tags MUST always be empty in a kind:13"),
 *           created_at randomised up to two days in the past, signed by the
 *           sender's signer (an extension: the page never sees the key)
 *   wrap    kind 1059, content = NIP-44 of the seal JSON from a fresh random
 *           key to the recipient, tags [p recipient] (+ expiration),
 *           created_at randomised likewise, signed by that one-time key
 *
 * The one-time wrapper key is protocol machinery, not an identity: made
 * here, used for one wrap, never stored or returned. The user's identity
 * key never reaches this code (the seal is signed by the signer).
 *
 * Expiration: NIP-17 puts it on the gift wrap (what relays see and may
 * delete) and suggests the seal too, but NIP-59 requires the seal's tags to
 * be empty; the MUST wins. The rumor carries the authoritative expiry for
 * whoever decrypts it. The wrap's expiry is the rumor's plus independent
 * random slack (NIP-59: independent random timestamps per layer).
 */
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, type EventTemplate, type NostrEvent, type UnsignedEvent } from 'nostr-tools/pure';
import { verifyFresh } from './verify';
import { isPubkey } from './keys';
import { SignerError, isNip44Payload, type NostrSigner } from './signer';

export const NIP17 = Object.freeze({
  /** Seal and wrap timestamps are moved back by up to this, seconds (two days). */
  maxBackdate: 2 * 24 * 60 * 60,
  /** The wrap's expiration is later than the rumor's by up to this, seconds. */
  maxExpirySlack: 60 * 60,
});

export type Rumor = UnsignedEvent & { id: string };

/** An unsigned rumor by `sender`: id is its hash; no signature, ever. */
export function makeRumor(sender: string, t: EventTemplate): Rumor {
  if (!isPubkey(sender)) throw new Error('rumor: sender is not a pubkey');
  const unsigned: UnsignedEvent = { pubkey: sender, created_at: t.created_at, kind: t.kind, tags: t.tags, content: t.content };
  return { ...unsigned, id: getEventHash(unsigned) };
}

const rand = (max: number, random: () => number) => Math.floor(random() * (max + 1));

export interface WrapOptions {
  /** Unix seconds (tests pin it). */
  now?: number;
  /** [0, 1) (tests pin it). */
  random?: () => number;
}

/**
 * Seal `rumor` for `recipient` with the sender's signer: NIP-44 encrypt,
 * then sign a tagless kind 13. Checks what the signer returns: the
 * ciphertext's shape (by the signer), and a seal that verifies, is kind 13
 * with no tags, and is by the rumor's author.
 */
export async function sealRumor(signer: NostrSigner, rumor: Rumor, recipient: string, opts: WrapOptions = {}): Promise<NostrEvent> {
  if (!signer.nip44) throw new SignerError('unavailable', 'this signer cannot encrypt (no NIP-44)');
  if (!isPubkey(recipient)) throw new Error('seal: recipient is not a pubkey');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const random = opts.random ?? Math.random;
  const content = await signer.nip44.encrypt(recipient, JSON.stringify(rumor));
  const seal = await signer.signEvent({ kind: 13, tags: [], content, created_at: now - rand(NIP17.maxBackdate, random) });
  if (seal.kind !== 13 || seal.tags.length !== 0 || seal.pubkey !== rumor.pubkey || !verifyFresh(seal)) throw new SignerError('malformed', 'the signer produced a seal that does not match the rumor');
  return seal;
}

/**
 * Gift-wrap a seal for `recipient` with a fresh one-time key (nostr-tools'
 * NIP-44 and signing). `expiration` (unix seconds) is set on the wrap, plus
 * random slack.
 */
export function giftWrap(seal: NostrEvent, recipient: string, expiration: number | null, opts: WrapOptions = {}): NostrEvent {
  if (!isPubkey(recipient)) throw new Error('wrap: recipient is not a pubkey');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const random = opts.random ?? Math.random;
  const tags: string[][] = [['p', recipient]];
  if (expiration !== null) tags.push(['expiration', String(expiration + rand(NIP17.maxExpirySlack, random))]);
  // One wrap, one key: created, used, dropped with this scope.
  const oneTime = generateSecretKey();
  const content = nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(oneTime, recipient));
  return finalizeEvent({ kind: 1059, tags, content, created_at: now - rand(NIP17.maxBackdate, random) }, oneTime);
}

/** The whole send-side construction: rumor (by `sender`) → seal (signer) → wrap (one-time key). */
export async function wrapForRecipient(signer: NostrSigner, sender: string, template: EventTemplate, recipient: string, expiration: number | null, opts: WrapOptions = {}) {
  const rumor = makeRumor(sender, template);
  const seal = await sealRumor(signer, rumor, recipient, opts);
  return { rumor, wrap: giftWrap(seal, recipient, expiration, opts) };
}

// ─── Receiving ──────────────────────────────────────────────────────────────

export type UnwrapFailure =
  | 'wrap-invalid' /** not a verified kind-1059 event */
  | 'not-for-me' /** its p tag names someone else */
  | 'undecryptable' /** a layer would not decrypt, or is not JSON */
  | 'seal-invalid' /** not a verified, tagless kind 13 */
  | 'rumor-invalid' /** not a well-formed unsigned event whose id is its hash */
  | 'author-mismatch'; /** the rumor claims another author than the seal's signer */

export class UnwrapError extends Error {
  constructor(readonly reason: UnwrapFailure) {
    super(`gift wrap rejected: ${reason}`);
    this.name = 'UnwrapError';
  }
}

/** Largest layer accepted before decryption, characters (a NIP-44 payload is at most 87 472). */
const MAX_LAYER = 90_000;

const HEX64 = /^[0-9a-f]{64}$/;
/** A rumor read from untrusted JSON: exactly the unsigned-event fields, sane sizes, id = hash, no signature. */
function readRumor(v: unknown): Rumor {
  const r = v as Record<string, unknown>;
  const ok =
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    !('sig' in r) &&
    typeof r.id === 'string' &&
    HEX64.test(r.id) &&
    isPubkey(r.pubkey) &&
    Number.isSafeInteger(r.kind) &&
    Number.isSafeInteger(r.created_at) &&
    typeof r.content === 'string' &&
    r.content.length <= 16_384 &&
    Array.isArray(r.tags) &&
    r.tags.length <= 64 &&
    r.tags.every((t) => Array.isArray(t) && t.length <= 16 && t.every((x) => typeof x === 'string' && x.length <= 1024));
  if (!ok) throw new UnwrapError('rumor-invalid');
  const rumor: Rumor = { id: r.id as string, pubkey: r.pubkey as string, created_at: r.created_at as number, kind: r.kind as number, tags: r.tags as string[][], content: r.content as string };
  const { id, ...unsigned } = rumor;
  if (getEventHash(unsigned) !== id) throw new UnwrapError('rumor-invalid');
  return rumor;
}

/**
 * Open a gift wrap addressed to `me` with the signer's NIP-44 (two decrypt
 * calls: the wrap from its one-time key, the seal from its author), with
 * every NIP-17 / NIP-59 check:
 *   wrap   verified (on a fresh copy), kind 1059, p-tagged to me, a NIP-44 payload
 *   seal   verified, kind 13, no tags (NIP-59 MUST), a NIP-44 payload
 *   rumor  well-formed, unsigned, id = hash, author = the seal's signer (NIP-17 MUST)
 * Returns the rumor, whatever its kind; what it means is the caller's to
 * decide (and an unrelated rumor is the caller's to drop at once).
 */
export async function unwrapGiftWrap(signer: NostrSigner, wrap: unknown, me: string): Promise<Rumor> {
  if (!signer.nip44) throw new SignerError('unavailable', 'this signer cannot decrypt (no NIP-44)');
  if (!verifyFresh(wrap) || wrap.kind !== 1059) throw new UnwrapError('wrap-invalid');
  if (!wrap.tags.some((t) => t[0] === 'p' && t[1] === me)) throw new UnwrapError('not-for-me');
  if (wrap.content.length > MAX_LAYER || !isNip44Payload(wrap.content)) throw new UnwrapError('undecryptable');
  const open = async (from: string, payload: string): Promise<unknown> => {
    let text: string;
    try {
      text = await signer.nip44!.decrypt(from, payload);
    } catch (e) {
      // A refusal or a timeout is the signer's to report; anything else is a layer that does not open.
      if (e instanceof SignerError && (e.code === 'denied' || e.code === 'timeout' || e.code === 'unavailable')) throw e;
      throw new UnwrapError('undecryptable');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new UnwrapError('undecryptable');
    }
  };
  const seal = await open(wrap.pubkey, wrap.content);
  if (!verifyFresh(seal) || seal.kind !== 13 || seal.tags.length !== 0) throw new UnwrapError('seal-invalid');
  if (seal.content.length > MAX_LAYER || !isNip44Payload(seal.content)) throw new UnwrapError('undecryptable');
  const rumor = readRumor(await open(seal.pubkey, seal.content));
  if (rumor.pubkey !== seal.pubkey) throw new UnwrapError('author-mismatch');
  return rumor;
}
