/**
 * `npm run serve`: Blobbi Rumble as one ordinary Node process, for LAN and
 * Internet test hosting. It serves the built game (`npm run build` → dist/)
 * and runs the authoritative match on the same port, WebSocket at `/ws`:
 *
 *   browser ──https──► (TLS: a reverse proxy, platform or tunnel) ──http──► this process
 *           ──wss /ws──►                                            ──ws──►  RumbleHost @ 60 Hz
 *
 * TLS is not this process's job: whatever sits in front terminates it. The
 * page derives its WebSocket from its own origin, so https gives wss.
 *
 * Environment: PORT (8080), HOST (0.0.0.0: reachable from the network, this
 * is its purpose), STATIC_DIR (dist), MAX_CONNECTIONS (64), TICK_HZ (60),
 * ROOM_IDLE_MINUTES (20: a private room nobody plays or moves in closes after this, with warnings),
 * TRUSTED_PROXIES (which peers may set CLIENT_IP_HEADER: loopback, private, addresses, IPv4 CIDRs; unset: any),
 * SNAPSHOT_HZ (20), MAX_ROOMS (16), and the server's identity
 * (`serverIdentity.ts`):
 *   PUBLIC_URL       the one address people open, e.g. https://rumble.example
 *                    (identity proofs must name it, share links and the
 *                    well-known document use it; extra comma-separated
 *                    addresses are accepted in proofs only). Unset: proofs
 *                    use the Host each connection arrives with; pages build
 *                    share links from their own address.
 *   SERVER_NAME      a display name
 *   OPERATOR_PUBKEY  who runs it (npub or hex), as claimed
 *   ALLOWED_ORIGINS  (M10D) browser origins that may connect, comma-separated
 *                    (e.g. https://rumble.example); unset: any origin. A
 *                    browser from another origin is refused (4005); clients
 *                    without an Origin header (not browsers) are let in.
 *   CLIENT_IP_HEADER  a header a trusted proxy sets to the player's address
 *                    (cf-connecting-ip behind Cloudflare Tunnel), for the
 *                    per-address limits; unset: the socket's address. Only
 *                    when nothing but that proxy can reach this port.
 * A malformed setting stops the server at start, with the reason (L4.7B.1:
 * the numeric ones too, `settings.ts`).
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { loadHavokNode } from '../sim/havokNode';
import { startRumbleServer } from './server';
import { identityFromEnv, wellKnown } from './serverIdentity';
import { LANDING, staticHandler } from './static';
import { numberSettings } from './settings';

const bind = process.env.HOST ?? '0.0.0.0';
const root = resolve(process.env.STATIC_DIR ?? 'dist');
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);
let configured: ReturnType<typeof identityFromEnv>;
// L4.7B.1: numeric settings are checked too (a typo used to become NaN: no limit at all).
let settings: ReturnType<typeof numberSettings>;
try {
  configured = identityFromEnv(process.env);
  settings = numberSettings(process.env);
} catch (e) {
  console.error(`Blobbi Rumble: ${(e as Error).message}`);
  process.exit(1);
}
const { identity, authUrls, warnings } = configured;

const havok = await loadHavokNode();
let rumble: Awaited<ReturnType<typeof startRumbleServer>> | null = null;
const http = createServer(staticHandler(root, () => ({ ok: true, clients: rumble?.stats.clients ?? 0, rooms: rumble?.rooms.size ?? 0, tick: rumble?.host.latest.tick ?? 0 }), { wellKnown: () => wellKnown(identity) }));
const port = settings.PORT;
await new Promise<void>((done) => http.listen(port, bind, done));
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const clientIpHeader = process.env.CLIENT_IP_HEADER?.trim() || undefined;
const trustedProxyList = process.env.TRUSTED_PROXIES?.trim() ? process.env.TRUSTED_PROXIES.trim() : undefined;
rumble = await startRumbleServer({ havok, http, path: '/ws', maxConnections: settings.MAX_CONNECTIONS, maxRooms: settings.MAX_ROOMS, roomIdleMs: settings.ROOM_IDLE_MINUTES * 60_000, tickHz: settings.TICK_HZ, snapshotHz: settings.SNAPSHOT_HZ, identity, authUrls, allowedOrigins, clientIpHeader, trustedProxies: trustedProxyList, log });

log(`Blobbi Rumble on http://${bind}:${port} (game ${LANDING}, WebSocket /ws) · serving ${root}`);
for (const [name, addrs] of Object.entries(networkInterfaces()))
  for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) log(`  on ${name}: http://${a.address}:${port}/`);
log(`  behind TLS (proxy / platform / tunnel) the same page connects with wss:// on its own origin`);
if (identity.public) log(`  public address ${identity.public.origin} · share links ${identity.public.origin}/play/<room> · proofs must name ${authUrls.join(', ')}`);
else log(`  no PUBLIC_URL: identity proofs are bound to the Host each connection uses, share links to the address each player opened (set PUBLIC_URL when hosting publicly)`);
log(`  identity: ${identity.name ?? 'no SERVER_NAME'} · operator ${identity.operator ? `${identity.operator.slice(0, 12)}… (claimed)` : 'none'} · /.well-known/rumble.json`);
log(allowedOrigins.length ? `  browser origins allowed: ${allowedOrigins.join(', ')}` : `  any browser origin may connect (set ALLOWED_ORIGINS when hosting publicly)`);
if (clientIpHeader) log(`  player addresses from the ${clientIpHeader} header (trusted proxy in front)${trustedProxyList ? `, believed only from ${trustedProxyList}` : ''}`);
if (clientIpHeader && !trustedProxyList) log(`  WARNING ${clientIpHeader} is believed from any peer: only safe if nothing but the proxy can reach this port (set TRUSTED_PROXIES, e.g. "private" behind Docker)`);
for (const w of warnings) log(`  WARNING ${w}`);

const every = 30;
setInterval(() => {
  const s = rumble!.stats;
  const snap = rumble!.host.latest;
  const control = rumble!.host.state().control;
  const humans = Object.entries(control).filter(([, c]) => c === 'human').map(([id]) => id);
  const odd = s.refused + s.malformed + s.rateDropped + s.kicked;
  const ids = Object.values(rumble!.host.roster().slots).filter((x) => x.who === 'nostr').length;
  const busy = rumble!.rooms.all().filter((r) => r.connections.size > 0).map((r) => `${r.id}:${r.connections.size}`);
  log(
    `rooms ${s.rooms} (${busy.join(' ') || 'all empty'}${s.roomsCreated || s.roomsClosed ? `, +${s.roomsCreated} −${s.roomsClosed}` : ''}) · ${(s.ticks / every).toFixed(1)} ticks/s (late ${s.lateMean.toFixed(1)}/${s.lateMax.toFixed(0)} ms, dropped ${s.dropped}) · ${s.clients} conn, open room humans ${humans.join(' ') || '-'} (${ids} with Nostr identity${s.authFailed ? `, ${s.authFailed} proofs refused` : ''}) · out ${(s.bytesOut / every / 1024).toFixed(1)} KB/s · round ${snap.round} ${snap.phase}${odd ? ` · refused ${s.refused} malformed ${s.malformed} rate-dropped ${s.rateDropped} kicked ${s.kicked}` : ''}`,
  );
  rumble!.resetStats();
}, every * 1000).unref();

// Graceful stop: the match sockets close, then the HTTP server; browsers keep idle keep-alive connections open, which
// `http.close` alone would wait for (the process lingered on SIGTERM with a page attached: found in local validation),
// so they are closed too, and a lingering exit is forced after 5 s.
const stop = () => {
  setTimeout(() => process.exit(0), 5000).unref();
  void rumble!.close().then(() => {
    http.close(() => process.exit(0));
    http.closeAllConnections();
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
