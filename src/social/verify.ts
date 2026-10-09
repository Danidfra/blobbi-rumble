/**
 * VERIFYING AN EVENT, on a fresh copy. nostr-tools caches a verdict on the
 * event object under a symbol, and object spread copies symbol keys: a
 * modified copy of a verified event (`{ ...ev, content: 'x' }`) would still
 * read as verified. So: copy exactly the NIP-01 fields into a new object,
 * then verify. Framework-free; no Rumble imports.
 */
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure';

export function verifyFresh(ev: unknown): ev is NostrEvent {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.sig !== 'string' || typeof e.content !== 'string' || !Number.isSafeInteger(e.kind) || !Number.isSafeInteger(e.created_at) || !Array.isArray(e.tags)) return false;
  if (!e.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  return verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at as number, kind: e.kind as number, tags: e.tags as string[][], content: e.content, sig: e.sig });
}
