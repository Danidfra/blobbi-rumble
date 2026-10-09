/**
 * THE REMEMBERED LOGIN: which signer someone used and the pubkey it gave,
 * so the next visit can offer "Continue as Daniel", and (M9B.1) whether
 * this browser should ask the signer again by itself on the next visit.
 * Never a secret key: the record is exactly { v, method, pubkey, auto },
 * and it proves nothing (a cached pubkey is a hint; control is proven to
 * each server, each connection, by a fresh signature). Framework-free; no
 * Rumble imports.
 */
import { normalizePubkey } from './keys';
import type { SignerMethod } from './signer';

export interface SavedLogin {
  v: 1;
  method: SignerMethod;
  pubkey: string;
  /** Reconnect by itself on the next visit (set by an explicit connection; cleared by a refusal, or by Disconnect with the whole record). */
  auto: boolean;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadLogin(store: Store | null, key: string): SavedLogin | null {
  try {
    const v = JSON.parse(store?.getItem(key) ?? 'null') as Partial<SavedLogin> | null;
    const pubkey = normalizePubkey(v?.pubkey);
    if (!v || v.v !== 1 || (v.method !== 'nip07' && v.method !== 'nip46') || !pubkey) return null;
    return { v: 1, method: v.method, pubkey, auto: v.auto === true };
  } catch {
    return null;
  }
}

export function saveLogin(store: Store | null, key: string, method: SignerMethod, pubkey: string, auto = true) {
  const record: SavedLogin = { v: 1, method, pubkey, auto };
  try {
    store?.setItem(key, JSON.stringify(record));
  } catch {
    // Blocked storage: nothing remembered, nothing broken.
  }
}

export function clearLogin(store: Store | null, key: string) {
  try {
    store?.removeItem(key);
  } catch {
    // As above.
  }
}
