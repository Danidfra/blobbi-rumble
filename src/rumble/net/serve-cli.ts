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
 * is its purpose), STATIC_DIR (dist), MAX_CONNECTIONS (16), TICK_HZ (60),
 * SNAPSHOT_HZ (20), PUBLIC_URL (the public address(es) of the game,
 * comma-separated, e.g. https://rumble.example: Nostr identity proofs must
 * name it; unset, the Host each connection arrives with is used).
 */
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { loadHavokNode } from '../sim/havokNode';
import { startRumbleServer } from './server';
import { LANDING, staticHandler } from './static';

const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
const port = env('PORT', 8080);
const bind = process.env.HOST ?? '0.0.0.0';
const root = resolve(process.env.STATIC_DIR ?? 'dist');
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);
/** A public page address (https://host) means its WebSocket (wss://host/ws). */
const authUrls = (process.env.PUBLIC_URL ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean)
  .map((u) => (/^https?:\/\/[^/]+\/?$/.test(u) ? `${u.replace(/\/$/, '')}/ws` : u));

const havok = await loadHavokNode();
let rumble: Awaited<ReturnType<typeof startRumbleServer>> | null = null;
const http = createServer(staticHandler(root, () => ({ ok: true, clients: rumble?.stats.clients ?? 0, tick: rumble?.host.latest.tick ?? 0 })));
await new Promise<void>((done) => http.listen(port, bind, done));
rumble = await startRumbleServer({ havok, http, path: '/ws', maxConnections: env('MAX_CONNECTIONS', 16), tickHz: env('TICK_HZ', 60), snapshotHz: env('SNAPSHOT_HZ', 20), authUrls, log });

log(`Blobbi Rumble on http://${bind}:${port} (game ${LANDING}, WebSocket /ws) · serving ${root}`);
for (const [name, addrs] of Object.entries(networkInterfaces()))
  for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) log(`  on ${name}: http://${a.address}:${port}/`);
log(`  behind TLS (proxy / platform / tunnel) the same page connects with wss:// on its own origin`);
log(authUrls.length ? `  Nostr identity proofs must name ${authUrls.join(', ')}` : `  Nostr identity proofs are bound to the Host each connection uses (set PUBLIC_URL when hosting publicly)`);

const every = 30;
setInterval(() => {
  const s = rumble!.stats;
  const snap = rumble!.host.latest;
  const control = rumble!.host.state().control;
  const humans = Object.entries(control).filter(([, c]) => c === 'human').map(([id]) => id);
  const odd = s.refused + s.malformed + s.rateDropped + s.kicked;
  const ids = Object.values(rumble!.host.roster().slots).filter((x) => x.who === 'nostr').length;
  log(
    `${(s.ticks / every).toFixed(1)} ticks/s (late ${s.lateMean.toFixed(1)}/${s.lateMax.toFixed(0)} ms, dropped ${s.dropped}) · ${s.clients} conn, humans ${humans.join(' ') || '-'} (${ids} with Nostr identity${s.authFailed ? `, ${s.authFailed} proofs refused` : ''}) · out ${(s.bytesOut / every / 1024).toFixed(1)} KB/s · round ${snap.round} ${snap.phase}${odd ? ` · refused ${s.refused} malformed ${s.malformed} rate-dropped ${s.rateDropped} kicked ${s.kicked}` : ''}`,
  );
  rumble!.resetStats();
}, every * 1000).unref();

const stop = () => rumble!.close().then(() => http.close(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
