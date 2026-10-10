/**
 * LOOKS ON THE WIRE (M9C): the Rumble form a player's fighter wears, as the
 * server binds it to the player's proven identity and tells everyone.
 *
 *   client → server   { t: 'look', form: { v: 1, d, gen, colors?, name? } | null }
 *                     "my fighter wears the form of MY Blobbi at address d"
 *   server → all      roster slot: { who: 'nostr', pubkey, form?: { v, d, gen, seed, colors?, name? } }
 *
 * The server never asks a relay. What it can check cheaply, it does: the
 * sender has proven a pubkey on this connection; `d` is a canonical Blobbi
 * address whose owner prefix is that pubkey's; the seed is DERIVED here from
 * (pubkey, d) with the kit's own rule, never taken from the client. So a
 * form always names a Blobbi address owned by the authenticated player (the
 * ecosystem's ownership rule: the author of a kind 31124 is its owner), and
 * nobody can wear another player's Blobbi or set another slot's look.
 *
 * What is NOT verified here: that a kind 31124 exists at that address, its
 * stage, or (for V1 / V2) that the stated colours are the Blobbi's own. Those
 * are the client's declaration, cosmetic only; a client that lies about
 * them changes nothing but its own fighter's paint. Nothing here reaches
 * the match: a look is a label on a slot, like a pubkey.
 */
import { deriveBlobbiV3Seed } from '@blobbi-kit/core';
import { cleanText } from '../../social/profile';

export const LOOKS = Object.freeze({
  /** The one form version this protocol knows; another is refused (a client that does not know it shows the default). */
  version: 1,
  maxName: 32,
});

export type LookGeneration = 'v1' | 'v2' | 'v3';

/** What a client declares. */
export interface LookDeclaration {
  v: 1;
  /** The Blobbi's address part: blobbi-<12 hex of its owner>-<10 hex>. */
  d: string;
  gen: LookGeneration;
  /** V1 / V2 only: the Blobbi's own colours, worn by the form. */
  colors?: { base: string; secondary: string; eye: string };
  name?: string;
}

/** What the roster carries: the declaration, bound to the owner by the derived seed. */
export interface SlotForm extends LookDeclaration {
  /** Derived by the server from (owner pubkey, d): the form's identity under the kit's rule. */
  seed: string;
}

const D_SHAPE = /^blobbi-[0-9a-f]{12}-[0-9a-f]{10}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;
const HEX_SEED = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a declaration from untrusted data: exactly the fields above, bounded; null for anything else. */
const FIELDS = new Set(['v', 'd', 'gen', 'colors', 'name']);

export function parseLookDeclaration(v: unknown): LookDeclaration | null {
  if (!isObject(v) || v.v !== LOOKS.version) return null;
  // Exactly these fields: a seed, an address, a pubkey or anything else sent along is not a declaration.
  for (const k of Object.keys(v)) if (!FIELDS.has(k)) return null;
  if (typeof v.d !== 'string' || !D_SHAPE.test(v.d)) return null;
  if (v.gen !== 'v1' && v.gen !== 'v2' && v.gen !== 'v3') return null;
  const out: LookDeclaration = { v: 1, d: v.d, gen: v.gen };
  if (v.colors !== undefined) {
    if (!isObject(v.colors)) return null;
    const c = ['base', 'secondary', 'eye'].map((k) => v.colors && typeof (v.colors as Record<string, unknown>)[k] === 'string' ? ((v.colors as Record<string, string>)[k] as string).toLowerCase() : null);
    if (!c.every((x): x is string => x !== null && HEX_COLOR.test(x))) return null;
    if (v.gen === 'v3') return null;
    out.colors = { base: c[0], secondary: c[1], eye: c[2] };
  }
  if (v.name !== undefined) {
    if (typeof v.name !== 'string' || v.name.length > LOOKS.maxName * 8) return null;
    const name = cleanText(v.name, LOOKS.maxName);
    if (name) out.name = name;
  }
  return out;
}

/** Bind a declaration to the proven owner: the address must be the owner's, and the seed is derived here. Null when it is not theirs. */
export function bindLook(pubkey: string, decl: LookDeclaration): SlotForm | null {
  if (!HEX_SEED.test(pubkey) || !D_SHAPE.test(decl.d) || decl.d.slice(7, 19) !== pubkey.slice(0, 12)) return null;
  let seed: string;
  try {
    seed = deriveBlobbiV3Seed(pubkey, decl.d);
  } catch {
    return null;
  }
  if (!HEX_SEED.test(seed)) return null;
  return { ...decl, seed };
}

/** Whether two slot forms are the same look (idempotence: the roster is re-sent only on a change). */
export const sameForm = (a: SlotForm | null | undefined, b: SlotForm | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
