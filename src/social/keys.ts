/**
 * PUBLIC KEYS: checking and showing them. Pubkeys are 32-byte lowercase
 * hex (NIP-01); people see them as npub (NIP-19), shortened for a label.
 * Framework-free; no Rumble imports.
 */
import { decode, npubEncode, type ProfilePointer } from 'nostr-tools/nip19';

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

/** A recipient a person pasted: npub or nprofile (optionally as a nostr: URI). Relay hints are hints only (where to look), never an inbox. */
export interface Recipient {
  pubkey: string;
  hints: string[];
}

export function parseRecipient(raw: unknown): Recipient | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^nostr:/i, '');
  if (s.length > 1000 || !/^(npub1|nprofile1)[02-9ac-hj-np-z]+$/.test(s)) return null;
  try {
    const d = decode(s);
    if (d.type === 'npub') return isPubkey(d.data) ? { pubkey: d.data, hints: [] } : null;
    if (d.type === 'nprofile') {
      const p: ProfilePointer = d.data;
      return isPubkey(p.pubkey) ? { pubkey: p.pubkey, hints: (p.relays ?? []).filter((r): r is string => typeof r === 'string').slice(0, 5) } : null;
    }
  } catch {
    return null;
  }
  return null;
}
