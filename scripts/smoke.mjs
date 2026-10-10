#!/usr/bin/env node
/**
 * DEPLOYMENT SMOKE CHECK for a Blobbi Rumble server: the page, the health
 * endpoint, the well-known document, the home-screen app files, the game's
 * WebSocket from the public origin, a refused foreign origin, and a Nostr
 * identity proof bound to the public address (and one bound to another
 * address refused: the localhost / LAN mismatch of earlier tests).
 *
 *   node scripts/smoke.mjs <base> [public-origin]
 *
 *   base           where to connect: http://127.0.0.1:8080 (on the host or in
 *                  the container) or https://rumble.blobbi.pet (through the tunnel)
 *   public-origin  the server's PUBLIC_URL; default: the base's origin
 *
 * In the container (Node and the dependencies are there):
 *   docker compose exec rumble node scripts/smoke.mjs https://rumble.blobbi.pet
 *   docker compose exec rumble node scripts/smoke.mjs http://127.0.0.1:8080 https://rumble.blobbi.pet
 *
 * The Nostr key it signs with is generated for the run and never stored: it
 * proves the binding, not anyone's identity. Exit code 0 when every check
 * passes. Nothing is changed on the server (it opens and closes a few
 * connections in the open room, as a spectator would).
 */
import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { makeAuthEvent } from 'nostr-tools/nip42';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8080');
const publicOrigin = new URL(process.argv[3] ?? base.origin).origin;
const publicWs = `${publicOrigin.replace(/^http/, 'ws')}/ws`;
const socketUrl = `${base.origin.replace(/^http/, 'ws')}/ws`;
let failed = 0;
const ok = (what, detail = '') => console.log(`  ok    ${what}${detail ? ` · ${detail}` : ''}`);
const bad = (what, detail = '') => {
  failed += 1;
  console.log(`  FAIL  ${what}${detail ? ` · ${detail}` : ''}`);
};
const check = (cond, what, detail) => (cond ? ok(what, detail) : bad(what, detail));

async function get(path) {
  const r = await fetch(new URL(path, base), { redirect: 'manual', headers: { 'user-agent': 'rumble-smoke' } });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: Buffer.from(await r.arrayBuffer()) };
}

/** Open the game socket with `origin` and collect messages until `until` says done (or a close / timeout). */
function socket(origin, until, ms = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(socketUrl, { headers: origin ? { origin } : {} });
    const got = { messages: [], closed: null, ws };
    const done = () => {
      clearTimeout(timer);
      resolve(got);
    };
    const timer = setTimeout(done, ms);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      got.messages.push(m);
      if (until(m, ws, got)) done();
    });
    ws.on('close', (code, reason) => {
      got.closed = { code, reason: reason.toString() };
      done();
    });
    ws.on('error', (e) => {
      got.error = e.message;
      done();
    });
  });
}

console.log(`Blobbi Rumble smoke check: ${base.origin} (public ${publicOrigin})`);

// HTTP.
try {
  const h = await get('/healthz');
  const j = JSON.parse(h.body.toString());
  check(h.status === 200 && j.ok === true, 'GET /healthz', `${h.status} ${h.body.toString().slice(0, 80)}`);
  const page = await get('/rumble.html');
  check(page.status === 200 && page.type.startsWith('text/html') && page.body.includes('manifest.json'), 'GET /rumble.html', `${page.status} ${page.type}`);
  const root = await get('/');
  check(root.status === 200 || (root.status >= 300 && root.status < 400), 'GET /', String(root.status));
  const wk = await get('/.well-known/rumble.json');
  const w = JSON.parse(wk.body.toString());
  check(wk.status === 200 && w.url === publicOrigin, 'GET /.well-known/rumble.json names the public origin', `url ${w.url ?? '(none)'}`);
  const man = await get('/manifest.json');
  const m = JSON.parse(man.body.toString());
  check(man.status === 200 && m.start_url && Array.isArray(m.icons), 'GET /manifest.json', `${m.name} · ${m.icons?.length ?? 0} icons`);
  for (const icon of ['/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png', '/icons/favicon-32.png']) {
    const i = await get(icon);
    check(i.status === 200 && i.type === 'image/png' && i.body.subarray(1, 4).toString() === 'PNG', `GET ${icon}`, `${i.body.length} bytes`);
  }
} catch (e) {
  bad('HTTP', e.message);
}

// The game's WebSocket from the public origin: a welcome, then a Nostr proof bound to `relay` (one connection per proof:
// the server spaces challenges on a connection).
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const prove = (relay) =>
  socket(publicOrigin, (msg, ws) => {
    if (msg.t === 'welcome') ws.send(JSON.stringify({ t: 'challenge' }));
    else if (msg.t === 'challenge') ws.send(JSON.stringify({ t: 'auth', event: finalizeEvent(makeAuthEvent(relay, msg.challenge), sk) }));
    else if (msg.t === 'auth') {
      ws.close(1000, 'smoke check done');
      return true;
    }
    return false;
  });
const run = await prove(publicWs);
const welcome = run.messages.find((m) => m.t === 'welcome');
check(!!welcome, 'WebSocket from the public origin: welcome', welcome ? `protocol ${welcome.protocol} · ${welcome.you ? `playing ${welcome.you}` : 'spectating'} · room ${welcome.room?.id ?? '?'}` : run.error ?? JSON.stringify(run.closed));
check(!!welcome?.features?.includes?.('nostr-auth'), 'the server offers Nostr identity', welcome?.features?.join(', ') ?? '-');
const good = run.messages.find((m) => m.t === 'auth');
check(good?.ok === true && good?.pubkey === pk, `a proof naming ${publicWs} is accepted`, JSON.stringify(good ?? null));
// The earlier mismatch: a proof naming the address a socket happens to use (localhost, a LAN IP) instead of the public one.
const other = socketUrl === publicWs ? 'ws://127.0.0.1:8080/ws' : socketUrl;
const wrong = (await prove(other)).messages.find((m) => m.t === 'auth');
check(wrong?.ok === false && wrong?.reason === 'server', `a proof naming ${other} is refused (reason "server")`, JSON.stringify(wrong ?? null));

// A page from another origin may not open the game's socket (when ALLOWED_ORIGINS is set).
const foreign = await socket('https://evil.example', (msg) => msg.t === 'welcome', 5000);
foreign.ws.close();
if (foreign.closed?.code === 4005) ok('a foreign origin is refused', '4005 origin not allowed');
else console.log(`  note  a foreign origin was NOT refused (${foreign.messages[0]?.t ?? JSON.stringify(foreign.closed)}): set ALLOWED_ORIGINS=${publicOrigin}`);

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
