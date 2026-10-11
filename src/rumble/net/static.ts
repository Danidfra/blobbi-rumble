/**
 * THE BUILT GAME, SERVED: a small static file handler for the production
 * entrypoint (`serve-cli.ts`), so one Node process serves the page and the
 * WebSocket on one origin. GET and HEAD only; paths resolved inside the
 * build directory and nowhere else; `/` goes to the network game; hashed
 * assets are cached for good, the pages never. `/healthz` answers for
 * whatever platform or proxy watches the process.
 *
 * M8B: `/play/<room>` is the game page too (a share link: the page reads
 * the room from its own path; a bad or expired code is the page's to
 * explain), and `/.well-known/rumble.json` says who the server is
 * (`serverIdentity.ts`), readable from any origin.
 */
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Security audit L1: the page's Content Security Policy. What it allows and why:
 *   script-src   only this origin's own bundles, plus 'wasm-unsafe-eval' to compile the Havok physics WebAssembly
 *                (never 'unsafe-eval', never inline scripts: the built page has none)
 *   style-src    'unsafe-inline': the page, Babylon and the HUD set styles inline (no script runs from a style)
 *   img-src      any http(s) image: Nostr profile pictures live anywhere; data: and blob: for drawn textures
 *   connect-src  this server's socket, Nostr relays (wss:) and https lookups; ws: / http: for a LAN server's page
 *                (a Nostr client cannot name its relays in advance, so this is not an exfiltration barrier)
 *   worker-src   blob: for Babylon's workers
 *   frame-ancestors 'none'  no other site may frame the game (clickjacking around "Connect Nostr")
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** On every response; and, on pages, the policy above with the older frame and feature headers. */
const COMMON_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' } as const;
const PAGE_HEADERS = { 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' } as const;

/** Where `/` sends a visitor: the game, in network mode. */
export const LANDING = '/rumble.html?network=1';

/** The file a request path stands for inside `root`, or null for anything outside it (or not a plain path). */
export function resolveStatic(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  const base = resolve(root);
  const file = resolve(join(base, normalize(path)));
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}

/** The page every share link opens. */
export const GAME_PAGE = '/rumble.html';
/** Share-link paths: /play/<anything short>; the page validates the code. */
export const isPlayPath = (path: string) => /^\/play\/[^/]{0,32}$/.test(path);

export function staticHandler(root: string, health: () => object = () => ({ ok: true }), opts: { wellKnown?: () => object } = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...COMMON_HEADERS, allow: 'GET, HEAD' }).end();
      return;
    }
    const path = url.split('?')[0];
    if (path === '/' || path === '') {
      // Keep the query (?room=A7F2, ?server=…): the page reads it.
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      res.writeHead(302, { ...COMMON_HEADERS, location: query ? `${LANDING}&${query}` : LANDING }).end();
      return;
    }
    if (path === '/.well-known/rumble.json' && opts.wellKnown) {
      res.writeHead(200, { ...COMMON_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }).end(JSON.stringify(opts.wellKnown()));
      return;
    }
    if (path === '/healthz') {
      // Readable from any origin: a page on another site may show whether a server is up (M10A), nothing more is in it.
      res.writeHead(200, { ...COMMON_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(health()));
      return;
    }
    const file = resolveStatic(root, isPlayPath(path) ? GAME_PAGE : url);
    let size = -1;
    try {
      if (file) {
        const st = statSync(file);
        if (st.isFile()) size = st.size;
      }
    } catch {
      size = -1;
    }
    if (!file || size < 0) {
      res.writeHead(404, { ...COMMON_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = path.startsWith('/assets/') && !isPlayPath(path);
    res.writeHead(200, {
      ...COMMON_HEADERS,
      ...(type.startsWith('text/html') ? PAGE_HEADERS : {}),
      'content-type': type,
      'content-length': size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // pipeline, not pipe: a client that hangs up mid-download (or a read error) closes the file and its buffer. With
    // `.pipe()` every aborted transfer kept an open file and its read buffer for good (security audit H2).
    pipeline(createReadStream(file), res, () => {});
  };
}
