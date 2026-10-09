/**
 * WHO AND WHERE A SERVER IS: its one canonical public address, an optional
 * display name and an optional operator Nostr pubkey, and the small
 * well-known document that says so. Pure.
 *
 *   PUBLIC_URL        the address people open, e.g. https://rumble.example.
 *                     From it, and only from it: the WebSocket address
 *                     (wss://rumble.example/ws) that identity proofs must
 *                     name, share links (https://rumble.example/play/A7F2),
 *                     and the well-known document. Never taken from
 *                     forwarded headers. Unset (LAN, dev): proofs are bound
 *                     to the Host each connection arrived with, and pages
 *                     build share links from their own address.
 *   SERVER_NAME       how the server calls itself (shown, never trusted)
 *   OPERATOR_PUBKEY   who runs it, as the server claims (npub or hex). It is
 *                     a claim: nothing here proves the key's owner agreed.
 *                     The process is the game's authority either way.
 *
 * `/.well-known/rumble.json` (served by `npm run serve`, CORS-open so a
 * page elsewhere, e.g. an invite, can read it):
 *   { protocol: 'blobbi-rumble', version: 1, websocket, capabilities,
 *     name?, operator?, url? }
 */
import { decode } from 'nostr-tools/nip19';
import { normalizePubkey } from '../../social/keys';
import { cleanText } from '../../social/profile';
import { OPEN_ROOM } from './roomId';
import { isLocalHost } from './serverTrust';

export interface PublicAddress {
  /** https://host[:port] */
  origin: string;
  /** wss://host[:port]/ws */
  websocket: string;
}

export interface ServerIdentity {
  name: string | null;
  /** Hex pubkey, as claimed. */
  operator: string | null;
  public: PublicAddress | null;
}

export type Parsed<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

/** PUBLIC_URL read strictly: http(s) (or ws(s)) origin, no credentials, query, fragment or path beyond /ws. */
export function parsePublicUrl(raw: string): Parsed<PublicAddress> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: `PUBLIC_URL is not a URL: ${raw}` };
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return { ok: false, error: 'PUBLIC_URL must be an http(s) address, e.g. https://rumble.example' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'PUBLIC_URL must not carry credentials, a query or a fragment' };
  if (!['', '/', '/ws', '/ws/'].includes(u.pathname)) return { ok: false, error: 'PUBLIC_URL must be the site root (e.g. https://rumble.example), not a page' };
  if (raw.length > 256) return { ok: false, error: 'PUBLIC_URL is too long' };
  const origin = `${secure ? 'https' : 'http'}://${u.host}`;
  const value = { origin, websocket: `${secure ? 'wss' : 'ws'}://${u.host}/ws` };
  return !secure && !isLocalHost(u.hostname) ? { ok: true, value, warning: 'PUBLIC_URL is plain http on a public host: put HTTPS in front (browsers on https pages refuse ws://)' } : { ok: true, value };
}

/** OPERATOR_PUBKEY as hex, from npub or hex. */
export function parseOperator(raw: string): Parsed<string> {
  const s = raw.trim();
  let hex: string | null = null;
  if (s.startsWith('npub1')) {
    try {
      const d = decode(s as `npub1${string}`);
      hex = d.type === 'npub' ? normalizePubkey(d.data) : null;
    } catch {
      hex = null;
    }
  } else hex = normalizePubkey(s);
  return hex ? { ok: true, value: hex } : { ok: false, error: 'OPERATOR_PUBKEY must be an npub or a 64-character hex pubkey' };
}

/** The identity from the environment; an invalid setting is an error (the operator should know at once, not discover it later). */
export function identityFromEnv(env: Record<string, string | undefined>): { identity: ServerIdentity; authUrls: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const urls = (env.PUBLIC_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  const parsed = urls.map(parsePublicUrl);
  const bad = parsed.find((p) => !p.ok);
  if (bad && !bad.ok) throw new Error(bad.error);
  const addrs = parsed.flatMap((p) => (p.ok ? [p.value] : []));
  for (const p of parsed) if (p.ok && p.warning) warnings.push(p.warning);
  let operator: string | null = null;
  if (env.OPERATOR_PUBKEY?.trim()) {
    const op = parseOperator(env.OPERATOR_PUBKEY);
    if (!op.ok) throw new Error(op.error);
    operator = op.value;
  }
  return {
    identity: { name: cleanText(env.SERVER_NAME, 40) ?? null, operator, public: addrs[0] ?? null },
    // Every listed address is accepted in proofs (an old name, a LAN name); the first is canonical.
    authUrls: addrs.map((a) => a.websocket),
    warnings,
  };
}

/** The share link for a room on a server known by its public origin. */
export const roomShareUrl = (origin: string, roomId: string) => (roomId === OPEN_ROOM ? `${origin}/` : `${origin}/play/${roomId}`);

export const CAPABILITIES = Object.freeze(['rooms', 'nostr-auth']);

/** The well-known document. Only what is true and useful now. */
export function wellKnown(id: ServerIdentity) {
  return {
    protocol: 'blobbi-rumble',
    version: 1,
    websocket: id.public?.websocket ?? '/ws',
    capabilities: [...CAPABILITIES],
    ...(id.name ? { name: id.name } : {}),
    ...(id.operator ? { operator: id.operator } : {}),
    ...(id.public ? { url: id.public.origin } : {}),
  };
}
