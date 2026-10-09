/**
 * A BLOBBI RUMBLE INVITE, sent as an ordinary NIP-17 private message (M8C-A).
 * It is a kind-14 chat message, readable in any NIP-17 messaging app:
 *
 *   content  "<name> invited you to Blobbi Rumble: <room link>"
 *   tags     ["p", <recipient>]
 *            ["r", <room link>]                    the authoritative destination
 *            ["b", "blobbi:rumble:invite:v1"]      what it is (the Blobbi
 *                                                  ecosystem's namespace-tag
 *                                                  convention, `b`)
 *            ["expiration", <now + 30 min>]
 *
 * The room link is the M8B share link (the server's PUBLIC_URL when it has
 * one); the text and the `r` tag carry the same link. Who sent it is the
 * NIP-17 structure's to prove (the seal), so no sender field; the name in
 * the text is courtesy, not identity. Nothing here grants access: room
 * codes are not secrets, and anyone with the link can join, as in M8B.
 */
import type { EventTemplate } from 'nostr-tools/pure';
import { isPubkey } from '../../social/keys';
import { normalizeRoomId } from '../net/roomId';
import { isLocalHost } from '../net/serverTrust';

export const INVITE_MARKER = Object.freeze(['b', 'blobbi:rumble:invite:v1']);
/** How long an invite is meant for, seconds. */
export const INVITE_LIFETIME = 30 * 60;

/** A room link fit to send: http(s), no credentials, query or fragment, exactly /play/<room code>. */
export function inviteLink(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const m = /^\/play\/([^/]+)$/.exec(u.pathname);
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || !m || !normalizeRoomId(m[1]) || raw.length > 256) return null;
  return u.toString();
}

/** The kind-14 rumor template of an invite (the sender is added by the NIP-17 layer). */
export function inviteTemplate(recipient: string, link: string, inviterName: string, now = Math.floor(Date.now() / 1000)): EventTemplate {
  const url = inviteLink(link);
  if (!url || !isPubkey(recipient)) throw new Error('invite: bad recipient or link');
  const name = inviterName.trim() || 'Someone';
  return {
    kind: 14,
    created_at: now,
    content: `${name} invited you to Blobbi Rumble: ${url}`,
    tags: [['p', recipient], ['r', url], [...INVITE_MARKER], ['expiration', String(now + INVITE_LIFETIME)]],
  };
}

// ─── Receiving (M8C-B) ──────────────────────────────────────────────────────

/** The namespace of the marker, without its version: other versions are recognised as unsupported, not as invites. */
const MARKER_NAMESPACE = 'blobbi:rumble:invite:';
/** An invite dated further ahead than this, seconds, is implausible. */
const MAX_FUTURE = 10 * 60;
/** An invite never lives longer than this from its creation, whatever its expiration says, seconds. */
const MAX_LIFETIME = INVITE_LIFETIME + 5 * 60;

export interface ReceivedInvite {
  /** The rumor id (one invite, however many relays delivered it). */
  id: string;
  /** Who sent it: the seal's signer, proven by NIP-17 (not the name in the text). */
  from: string;
  url: string;
  origin: string;
  room: string;
  createdAt: number;
  expiresAt: number;
}

export type InviteRejection = 'not-invite' | 'unsupported-version' | 'not-for-me' | 'destination' | 'mismatch' | 'expired' | 'future' | 'oversized';

/**
 * Read a decrypted kind-14 rumor as a Blobbi Rumble invite, or say why it
 * is not one. Only the marker this app owns makes something an invite (a
 * DM that merely contains a /play/ link is not one). The destination is
 * untrusted: http(s) only, https unless the host is local, no
 * credentials, exactly /play/<room code>; the text may name no other link.
 */
export function parseInvite(rumor: { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string }, me: string, now = Math.floor(Date.now() / 1000)): { ok: true; invite: ReceivedInvite } | { ok: false; why: InviteRejection } {
  if (rumor.kind !== 14) return { ok: false, why: 'not-invite' };
  const markers = rumor.tags.filter((t) => t[0] === 'b' && typeof t[1] === 'string' && t[1].startsWith(MARKER_NAMESPACE));
  if (!markers.length) return { ok: false, why: 'not-invite' };
  if (markers.length !== 1 || markers[0][1] !== INVITE_MARKER[1]) return { ok: false, why: 'unsupported-version' };
  if (rumor.content.length > 1000 || rumor.tags.length > 20) return { ok: false, why: 'oversized' };
  if (!rumor.tags.some((t) => t[0] === 'p' && t[1] === me)) return { ok: false, why: 'not-for-me' };
  const rs = rumor.tags.filter((t) => t[0] === 'r');
  if (rs.length !== 1) return { ok: false, why: 'destination' };
  const url = receivedLink(rs[0][1]);
  if (!url) return { ok: false, why: 'destination' };
  // The text and the structured link must name the same place, and nothing else.
  const inText = rumor.content.match(/[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? [];
  if (inText.length !== 1 || inText[0] !== url) return { ok: false, why: 'mismatch' };
  const expTag = rumor.tags.find((t) => t[0] === 'expiration')?.[1];
  const exp = expTag && /^\d{1,12}$/.test(expTag) ? Number(expTag) : NaN;
  if (!Number.isSafeInteger(exp)) return { ok: false, why: 'expired' };
  if (rumor.created_at > now + MAX_FUTURE) return { ok: false, why: 'future' };
  const expiresAt = Math.min(exp, rumor.created_at + MAX_LIFETIME);
  if (now >= expiresAt) return { ok: false, why: 'expired' };
  const u = new URL(url);
  return { ok: true, invite: { id: rumor.id, from: rumor.pubkey, url, origin: u.origin, room: normalizeRoomId(u.pathname.slice('/play/'.length))!, createdAt: rumor.created_at, expiresAt } };
}

/** A received destination: a sendable room link, and https unless its host is this machine or a local network. */
export function receivedLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = inviteLink(raw);
  if (!url || url !== raw) return null;
  const u = new URL(url);
  return u.protocol === 'https:' || isLocalHost(u.hostname) ? url : null;
}
