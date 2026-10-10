/**
 * WHICH GAME SERVERS A PAGE KNOWS (M10A), and which one it uses. Pure.
 *
 *   official    built in at build time (VITE_RUMBLE_SERVERS, a JSON list, or
 *               the older VITE_RUMBLE_SERVER, one address); none by default:
 *               no production address is invented here
 *   page        the origin this page was served from, at /ws (the hosted
 *               game: `npm run serve` serves page and match on one origin)
 *   dev         the dev game server beside `npm run dev` (ws://host:8787)
 *   community   added by the player, kept in localStorage (name, address,
 *               optional region and note; never a secret), at most a few
 *   ?server=    the page's own query, for a link or a test: this page only
 *
 * An address is a WebSocket URL, strictly: ws:// or wss://, no credentials,
 * no fragment, a host; http(s) is read as the same host's /ws. A page served
 * over https may only use wss:// (a browser refuses ws:// there anyway, and
 * nothing here downgrades); plain ws:// is for local addresses in
 * development. A server from a link or a list is never connected to
 * silently from untrusted metadata: only what is built in, what the player
 * added, and what the page's own address says.
 */
import { cleanText } from '../../social/profile';
import { isLocalHost } from '../net/serverTrust';

export type ServerSource = 'official' | 'page' | 'dev' | 'community' | 'link';

export interface GameServer {
  /** Stable: the canonical WebSocket URL for built-in and page servers; `community:<url>` for added ones. */
  id: string;
  name: string;
  /** Canonical WebSocket URL (wss:// or ws://). */
  url: string;
  source: ServerSource;
  region?: string;
  /** Who runs it, as the list says (text only; what the server itself claims comes with its welcome). */
  operator?: string;
}

export const SERVERS = Object.freeze({
  maxCommunity: 12,
  maxName: 40,
  maxRegion: 40,
  maxOperator: 80,
  maxUrl: 256,
  storageKey: 'rumble:servers:v1',
  chosenKey: 'rumble:server:v1',
});

export interface EndpointRules {
  /** The page is https: only wss:// is allowed. */
  secure: boolean;
  /** Development: plain ws:// to a local address is fine. */
  dev: boolean;
}

/**
 * A server address as a canonical WebSocket URL, or null with the reason:
 * ws(s) only (http(s) meaning the same host's /ws), a host, no credentials
 * or fragment, bounded; wss:// on a secure page; ws:// only to a local
 * address, in development.
 */
export function parseEndpoint(raw: unknown, rules: EndpointRules): { url: string } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'empty' };
  const text = raw.trim();
  if (text.length > SERVERS.maxUrl) return { error: 'too long' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `wss://${text}`);
  } catch {
    return { error: 'not a URL' };
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return { error: 'not a ws:// or wss:// address' };
  if (!u.hostname) return { error: 'no host' };
  if (u.username || u.password) return { error: 'credentials are not allowed' };
  if (u.hash) return { error: 'a fragment is not allowed' };
  if (u.pathname === '/' && /^https?:/i.test(text)) u.pathname = '/ws';
  if (u.protocol === 'ws:') {
    if (rules.secure) return { error: 'this page is https: the server must be wss://' };
    if (!rules.dev && !isLocalHost(u.hostname)) return { error: 'plain ws:// only for local addresses' };
  }
  return { url: u.toString() };
}

const clean = (v: unknown, max: number): string | undefined => cleanText(v, max);

/** One server as a list or storage may describe it, checked field by field; null when it is not one. */
export function parseServerEntry(v: unknown, source: ServerSource, rules: EndpointRules): GameServer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ep = parseEndpoint(o.url, rules);
  if ('error' in ep) return null;
  const name = clean(o.name, SERVERS.maxName) ?? new URL(ep.url).host;
  const out: GameServer = { id: source === 'community' ? `community:${ep.url}` : ep.url, name, url: ep.url, source };
  const region = clean(o.region, SERVERS.maxRegion);
  const operator = clean(o.operator, SERVERS.maxOperator);
  if (region) out.region = region;
  if (operator) out.operator = operator;
  return out;
}

/**
 * The official servers, from build-time configuration: VITE_RUMBLE_SERVERS
 * as a JSON array of { name, url, region?, operator? }, or the older
 * VITE_RUMBLE_SERVER (one address). Malformed entries are dropped; a page
 * served over https drops ws:// ones.
 */
export function officialServers(env: { VITE_RUMBLE_SERVERS?: string; VITE_RUMBLE_SERVER?: string }, rules: EndpointRules): GameServer[] {
  const out: GameServer[] = [];
  if (env.VITE_RUMBLE_SERVERS) {
    try {
      const list = JSON.parse(env.VITE_RUMBLE_SERVERS) as unknown;
      if (Array.isArray(list)) for (const item of list.slice(0, 16)) {
        const s = parseServerEntry(item, 'official', rules);
        if (s && !out.some((x) => x.url === s.url)) out.push(s);
      }
    } catch {
      // Not JSON: ignored (a warning belongs in the build, not in the page).
    }
  }
  if (!out.length && env.VITE_RUMBLE_SERVER) {
    const ep = parseEndpoint(env.VITE_RUMBLE_SERVER, rules);
    if ('url' in ep) out.push({ id: ep.url, name: new URL(ep.url).host, url: ep.url, source: 'official' });
  }
  return out;
}

export interface PageLocation {
  protocol: string;
  host: string;
  hostname: string;
}

/** The server the page itself came from (the hosted game), and, in development, the dev server beside the page. */
export function ownServers(loc: PageLocation, dev: boolean): GameServer[] {
  const secure = loc.protocol === 'https:';
  if (dev) return [{ id: `${secure ? 'wss' : 'ws'}://${loc.hostname}:8787/`, name: 'Development server (this machine)', url: `${secure ? 'wss' : 'ws'}://${loc.hostname}:8787/`, source: 'dev' }];
  const url = `${secure ? 'wss' : 'ws'}://${loc.host}/ws`;
  return [{ id: url, name: `This site (${loc.host})`, url, source: 'page' }];
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Community servers the player added, from storage, re-checked (storage is not trusted either). */
export function loadCommunityServers(store: Store | null, rules: EndpointRules): GameServer[] {
  try {
    const raw = JSON.parse(store?.getItem(SERVERS.storageKey) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const out: GameServer[] = [];
    for (const item of raw.slice(0, SERVERS.maxCommunity)) {
      const s = parseServerEntry(item, 'community', rules);
      if (s && !out.some((x) => x.url === s.url)) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveCommunityServers(store: Store | null, servers: readonly GameServer[]) {
  try {
    store?.setItem(SERVERS.storageKey, JSON.stringify(servers.slice(0, SERVERS.maxCommunity).map((s) => ({ name: s.name, url: s.url, ...(s.region ? { region: s.region } : {}), ...(s.operator ? { operator: s.operator } : {}) }))));
  } catch {
    // Storage blocked: the list holds for this page only.
  }
}

/** Add a community server (bounded; a known address is updated, not duplicated). Returns the new list, or the reason it was refused. */
export function addCommunityServer(current: readonly GameServer[], input: { name?: string; url: string; region?: string; operator?: string }, rules: EndpointRules): { servers: GameServer[] } | { error: string } {
  const ep = parseEndpoint(input.url, rules);
  if ('error' in ep) return { error: ep.error };
  const entry = parseServerEntry({ ...input, url: ep.url }, 'community', rules);
  if (!entry) return { error: 'not a server entry' };
  const rest = current.filter((s) => s.url !== entry.url);
  if (rest.length >= SERVERS.maxCommunity) return { error: `at most ${SERVERS.maxCommunity} community servers` };
  return { servers: [...rest, entry] };
}

export const removeCommunityServer = (current: readonly GameServer[], id: string): GameServer[] => current.filter((s) => s.id !== id);

export function loadChosenServer(store: Store | null): string | null {
  try {
    const v = store?.getItem(SERVERS.chosenKey);
    return typeof v === 'string' && v.length <= SERVERS.maxUrl + 16 ? v : null;
  } catch {
    return null;
  }
}

export function saveChosenServer(store: Store | null, id: string | null) {
  try {
    if (id === null) store?.removeItem(SERVERS.chosenKey);
    else store?.setItem(SERVERS.chosenKey, id);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

/**
 * Which server this page connects to, in order: the page's own `?server=`
 * (a link or a test; this page only), the player's chosen server if it is
 * still known, the first official server, then the page's own (or, in
 * development, the dev server). A `?server=` that fails the rules is
 * reported, not used.
 */
export function chooseServer(known: readonly GameServer[], chosenId: string | null, search: string, rules: EndpointRules): { server: GameServer; linkError?: string } {
  const asked = new URLSearchParams(search).get('server');
  let linkError: string | undefined;
  if (asked) {
    const ep = parseEndpoint(asked, rules);
    if ('url' in ep) {
      const existing = known.find((s) => s.url === ep.url);
      return { server: existing ?? { id: `link:${ep.url}`, name: new URL(ep.url).host, url: ep.url, source: 'link' } };
    }
    linkError = ep.error;
  }
  const chosen = chosenId ? known.find((s) => s.id === chosenId) : undefined;
  const server = chosen ?? known.find((s) => s.source === 'official') ?? known.find((s) => s.source === 'page' || s.source === 'dev') ?? known[0];
  return linkError ? { server, linkError } : { server };
}
