/**
 * SENDING A RUMBLE INVITE (M8C-A): recipient → their NIP-17 inbox → kind-14
 * invite → seal (the player's extension) → gift wrap (one-time key) →
 * publish to that inbox only. Every step reports a status the session panel
 * shows. Nothing here goes to the Rumble server; nothing here touches the
 * match. Nothing is logged.
 */
import { findInbox, inboxRelayAuth, publishGiftWrap, type PublishPoolLike } from '../../social/inbox';
import { parseRecipient } from '../../social/keys';
import { wrapForRecipient } from '../../social/nip17';
import type { BoundedPool } from '../../social/pool';
import { SignerError, type NostrSigner } from '../../social/signer';
import { INVITE_LIFETIME, inviteTemplate } from './invites';

export type InviteStatus =
  | { k: 'invalid' }
  | { k: 'looking'; pubkey: string }
  | { k: 'no-inbox'; pubkey: string }
  | { k: 'sending'; pubkey: string; relays: number }
  | { k: 'sent'; pubkey: string; accepted: number; total: number }
  | { k: 'declined'; pubkey: string }
  | { k: 'failed'; pubkey: string; why: 'relays' | 'error'; detail: string };

export interface InviteDeps {
  signer: NostrSigner;
  /** The sender's pubkey (proven to the game server; the seal is checked against it). */
  sender: string;
  /** Where profiles and relay lists are looked up (the page's bounded pool). */
  lookup: BoundedPool;
  /** A short-lived pool for publishing to the inbox (closed afterwards). */
  publishPool: () => PublishPoolLike & { destroy?: () => void };
  lookupRelays?: readonly string[];
  /** The room's share link. */
  link: string;
  inviterName: string;
  onStatus: (s: InviteStatus) => void;
  now?: () => number;
}

export async function sendInvite(input: string, d: InviteDeps): Promise<InviteStatus> {
  const report = (s: InviteStatus) => (d.onStatus(s), s);
  const recipient = parseRecipient(input);
  if (!recipient) return report({ k: 'invalid' });
  const pubkey = recipient.pubkey;
  if (!d.signer.nip44) return report({ k: 'failed', pubkey, why: 'error', detail: 'your Nostr extension cannot encrypt (NIP-44)' });
  report({ k: 'looking', pubkey });
  const inbox = await findInbox(d.lookup, recipient, { lookupRelays: d.lookupRelays });
  if (!inbox) return report({ k: 'no-inbox', pubkey });
  report({ k: 'sending', pubkey, relays: inbox.relays.length });
  const now = d.now?.() ?? Math.floor(Date.now() / 1000);
  let wrap;
  try {
    ({ wrap } = await wrapForRecipient(d.signer, d.sender, inviteTemplate(pubkey, d.link, d.inviterName, now), pubkey, now + INVITE_LIFETIME, { now }));
  } catch (e) {
    if (e instanceof SignerError && e.code === 'denied') return report({ k: 'declined', pubkey });
    return report({ k: 'failed', pubkey, why: 'error', detail: e instanceof Error ? e.message.slice(0, 120) : 'could not build the invite' });
  }
  // Keep under the relay cap while the inbox connections are open.
  d.lookup.makeRoom(inbox.relays.length);
  const pool = d.publishPool();
  try {
    const r = await publishGiftWrap(pool, inbox.relays, wrap, inboxRelayAuth(d.signer, inbox.relays));
    if (r.accepted.length) return report({ k: 'sent', pubkey, accepted: r.accepted.length, total: inbox.relays.length });
    return report({ k: 'failed', pubkey, why: 'relays', detail: r.failed.map((f) => f.reason).join('; ').slice(0, 160) });
  } finally {
    pool.destroy?.();
  }
}
