/**
 * WHERE THE RUMBLE SERVER IS, from the page's point of view. Pure.
 *
 *   1. `?server=ws://host:port` (or wss://, or an http(s) URL meaning the same host): as given, always wins;
 *   2. a server configured at build time (VITE_RUMBLE_SERVER);
 *   3. the Vite dev server (`npm run dev`): the dev game server beside it, on this host, port 8787;
 *   4. otherwise (the built game served by `npm run serve`): this page's own origin, path /ws,
 *      wss:// when the page is https:// (a browser refuses ws:// from a secure page).
 */
export interface PageLocation {
  protocol: string;
  host: string;
  hostname: string;
}

export const DEV_SERVER_PORT = 8787;
export const WS_PATH = '/ws';

/** An explicit server address as a WebSocket URL, or null if it is not one. */
export function asWebSocketUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  if (u.pathname === '/' && raw.startsWith('http')) u.pathname = WS_PATH;
  return u.toString();
}

export function resolveServerUrl(loc: PageLocation, search: string, opts: { dev: boolean; configured?: string } = { dev: false }): string {
  const asked = new URLSearchParams(search).get('server');
  const explicit = asked ? asWebSocketUrl(asked) : null;
  if (explicit) return explicit;
  const configured = opts.configured ? asWebSocketUrl(opts.configured) : null;
  if (configured) return configured;
  const secure = loc.protocol === 'https:';
  // (`hostname` already brackets an IPv6 address, as a URL needs.)
  if (opts.dev) return `${secure ? 'wss' : 'ws'}://${loc.hostname}:${DEV_SERVER_PORT}`;
  return `${secure ? 'wss' : 'ws'}://${loc.host}${WS_PATH}`;
}
