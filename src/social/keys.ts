/**
 * PUBLIC KEYS: checking and showing them. Pubkeys are 32-byte lowercase
 * hex (NIP-01); people see them as npub (NIP-19), shortened for a label.
 * Framework-free; no Rumble imports.
 */
import { npubEncode } from 'nostr-tools/nip19';

const HEX64 = /^[0-9a-f]{64}$/;

/** A well-formed pubkey (lowercase 64-hex), from anything. */
export const isPubkey = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);

/** A pubkey as given by an outside source (an extension may use upper case): lowercase, or null if it is not one. */
export function normalizePubkey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const lower = v.trim().toLowerCase();
  return HEX64.test(lower) ? lower : null;
}

export const npubOf = (pubkey: string) => npubEncode(pubkey);

/** `npub1abcd…wxyz`: enough to tell people apart, short enough for a nameplate. */
export function shortNpub(pubkey: string, head = 4, tail = 4) {
  const npub = npubOf(pubkey);
  return `${npub.slice(0, 5 + head)}…${npub.slice(-tail)}`;
}
