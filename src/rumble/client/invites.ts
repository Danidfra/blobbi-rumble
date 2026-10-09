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
