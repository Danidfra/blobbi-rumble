/**
 * THE BUILT GAME, SERVED: a small static file handler for the production
 * entrypoint (`serve-cli.ts`), so one Node process serves the page and the
 * WebSocket on one origin. GET and HEAD only; paths resolved inside the
 * build directory and nowhere else; `/` goes to the network game; hashed
 * assets are cached for good, the pages never. `/healthz` answers for
 * whatever platform or proxy watches the process.
 */
import { createReadStream, statSync } from 'node:fs';
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

export function staticHandler(root: string, health: () => object = () => ({ ok: true })) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const path = url.split('?')[0];
    if (path === '/' || path === '') {
      res.writeHead(302, { location: LANDING }).end();
      return;
    }
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(health()));
      return;
    }
    const file = resolveStatic(root, url);
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
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = path.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}
