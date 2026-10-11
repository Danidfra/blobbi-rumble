/**
 * The static handler under aborted downloads (security audit H2): a client
 * that hangs up mid-transfer must not leave the file open. Before the fix
 * (`createReadStream(file).pipe(res)`) every aborted download kept one file
 * descriptor and its read buffer for the life of the process.
 */
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticHandler } from './static';

let http: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
});

/** Open file descriptors of this process (Linux and macOS both list them in /dev/fd). */
const openFds = () => readdirSync('/dev/fd').length;

async function serve() {
  const root = mkdtempSync(join(tmpdir(), 'rumble-static-'));
  mkdirSync(join(root, 'assets'));
  // Far larger than the socket buffers: a transfer is still running when the client hangs up.
  writeFileSync(join(root, 'assets', 'big-abc.wasm'), Buffer.alloc(4 * 1024 * 1024, 7));
  writeFileSync(join(root, 'rumble.html'), '<!doctype html><title>Blobbi Rumble</title>');
  http = createServer(staticHandler(root));
  http.keepAliveTimeout = 1;
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
  return (http.address() as { port: number }).port;
}

/** GET a path, read the first chunk, then hang up. */
const abortedDownload = (port: number, path: string) =>
  new Promise<void>((resolve) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => resolve());
  });

describe('aborted downloads (H2)', () => {
  it('release the file and its buffer: repeated aborts leave the open descriptors bounded', async () => {
    const port = await serve();
    // Warm up (lazy handles of the runtime, the listening socket's first accept).
    for (let i = 0; i < 3; i++) await abortedDownload(port, '/assets/big-abc.wasm');
    await new Promise((r) => setTimeout(r, 200));
    const before = openFds();
    const n = 60;
    for (let i = 0; i < n; i++) await abortedDownload(port, `/assets/big-abc.wasm?bust=${i}`);
    await new Promise((r) => setTimeout(r, 300));
    // Leaking, this grows by one per abort (60); bounded, it stays where it was (a few sockets in teardown at most).
    expect(openFds() - before).toBeLessThan(10);
    // And the server still answers whole files.
    const page = await fetch(`http://127.0.0.1:${port}/rumble.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Blobbi Rumble');
    const whole = await fetch(`http://127.0.0.1:${port}/assets/big-abc.wasm`);
    expect((await whole.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024);
  });
});

describe('security headers (L1)', () => {
  it('pages carry the CSP, no framing and the feature policy; every response says nosniff and a referrer policy', async () => {
    const port = await serve();
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/rumble.html?network=1`);
    const csp = page.headers.get('content-security-policy') ?? '';
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
    // Scripts: this origin only, WebAssembly compilation allowed, never eval or inline script.
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    // What the game needs: Nostr relays and profile pictures from anywhere, drawn textures, Babylon's workers.
    expect(directive('connect-src')).toMatch(/wss:/);
    expect(directive('img-src')).toMatch(/https:.*|data:/);
    expect(directive('worker-src')).toMatch(/blob:/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
    for (const path of ['/rumble.html', '/assets/big-abc.wasm', '/healthz', '/nope', '/']) {
      const r = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
    }
    // Files that are not pages carry no page policy (the wasm is fetched, not framed).
    expect((await fetch(`${base}/assets/big-abc.wasm`)).headers.get('content-security-policy')).toBeNull();
  });
});
