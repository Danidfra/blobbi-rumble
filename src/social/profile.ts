/**
 * PROFILES (kind 0, NIP-01 / NIP-24): read from hostile data into a small,
 * safe shape. A profile event comes from any relay and anyone; its content
 * is JSON someone typed. Nothing in it is trusted: text is cleaned and
 * bounded (no control, direction-override or invisible characters, no
 * piles of combining marks) and must only ever be shown as text; a picture
 * is kept only as a plain https URL. No profile at all is normal: the
 * display falls back to a short npub.
 * Framework-free; no Rumble imports.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { shortNpub } from './keys';

export const PROFILE_LIMITS = Object.freeze({
  /** Content longer than this, characters, is not parsed at all. */
  maxContent: 16_384,
  /** Longest kept name / display name, code points. */
  maxName: 48,
  maxNip05: 120,
  maxUrl: 1024,
  /** A profile dated further ahead of now than this, seconds, is ignored. */
  maxFuture: 600,
});

export interface Profile {
  pubkey: string;
  /** The profile event's created_at (the newest wins). */
  createdAt: number;
  name?: string;
  displayName?: string;
  /** An https URL, if one was given. */
  picture?: string;
  /** As claimed: unverified. */
  nip05?: string;
}

// C0/C1 controls, bidi embeddings/overrides/isolates and marks, zero-width characters, the BOM, line/paragraph separators.
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g');
const MARK_PILES = /(\p{M}{2})\p{M}+/gu;

/** Untrusted text made safe to show as text: cleaned, whitespace collapsed, at most `max` code points (or undefined if nothing is left). */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.slice(0, max * 8).replace(UNSAFE, ' ').replace(MARK_PILES, '$1').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : s;
}

/** A picture URL made safe: https only, no credentials, bounded; else undefined. */
export function safeImageUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > PROFILE_LIMITS.maxUrl) return undefined;
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return undefined;
  return u.href;
}

const NIP05 = /^(?:[a-z0-9._-]{1,64}@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** Read a kind-0 event (already signature-checked by the relay layer) into a Profile, or null if it is not a usable one. */
export function parseProfile(ev: NostrEvent, now = Math.floor(Date.now() / 1000)): Profile | null {
  if (ev.kind !== 0 || typeof ev.content !== 'string' || ev.content.length > PROFILE_LIMITS.maxContent) return null;
  if (!Number.isSafeInteger(ev.created_at) || ev.created_at > now + PROFILE_LIMITS.maxFuture) return null;
  let v: unknown;
  try {
    v = JSON.parse(ev.content);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p: Profile = { pubkey: ev.pubkey, createdAt: ev.created_at };
  const name = cleanText(o.name, PROFILE_LIMITS.maxName);
  // NIP-24: display_name; older clients wrote displayName.
  const displayName = cleanText(o.display_name ?? o.displayName, PROFILE_LIMITS.maxName);
  const picture = safeImageUrl(o.picture);
  const nip05Raw = typeof o.nip05 === 'string' && o.nip05.length <= PROFILE_LIMITS.maxNip05 ? o.nip05.trim().toLowerCase() : '';
  if (name) p.name = name;
  if (displayName) p.displayName = displayName;
  if (picture) p.picture = picture;
  if (NIP05.test(nip05Raw)) p.nip05 = nip05Raw;
  return p;
}

/** What to call someone: display name, then name, then a short npub. */
export function displayName(profile: Profile | null | undefined, pubkey: string): string {
  return profile?.displayName ?? profile?.name ?? shortNpub(pubkey);
}

/** A label cut to `max` code points (for nameplates). */
export function clip(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : text;
}
