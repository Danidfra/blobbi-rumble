/**
 * NIP-17 PRIVATE MESSAGES, the sending half: an unsigned rumor, sealed by
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
import { SignerError, type NostrSigner } from './signer';

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
