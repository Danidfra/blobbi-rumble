/**
 * `npm run server`: the authoritative Rumble server on ws://127.0.0.1:8787,
 * for development beside `npm run dev` (HOST=0.0.0.0 for LAN play). For a
 * hosted game (page and WebSocket on one origin) use `npm run serve`.
 * Environment: PORT (8787), HOST (127.0.0.1), TICK_HZ (60), SNAPSHOT_HZ (20),
 * and, DEV ONLY, LAG_MS / JITTER_MS (added one-way delay on every message,
 * each way), PUBLIC_URL (the ws:// address identity proofs must name;
 * unset, the Host each connection uses). Prints the loop's health every 10 seconds.
 */
import { networkInterfaces } from 'node:os';
import { loadHavokNode } from '../sim/havokNode';
import { startRumbleServer } from './server';
import { identityFromEnv } from './serverIdentity';

const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
const stamp = () => new Date().toISOString().slice(11, 19);
const { identity, authUrls, warnings } = identityFromEnv(process.env);
for (const w of warnings) console.log(`WARNING ${w}`);
const havok = await loadHavokNode();
const server = await startRumbleServer({
  log: (line) => console.log(`[${stamp()}] ${line}`),
  havok,
  port: env('PORT', 8787),
  host: process.env.HOST ?? '127.0.0.1',
  tickHz: env('TICK_HZ', 60),
  snapshotHz: env('SNAPSHOT_HZ', 20),
  lagMs: env('LAG_MS', 0),
  jitterMs: env('JITTER_MS', 0),
  identity,
  authUrls,
});
const lag = env('LAG_MS', 0);
const jitter = env('JITTER_MS', 0);
console.log(`Blobbi Rumble server on ws://${process.env.HOST ?? '127.0.0.1'}:${server.port} · ${server.host.tickHz} Hz simulation · ${server.host.snapshotHz} Hz state${lag || jitter ? ` · DEV LAG ${lag} ms + up to ${jitter} ms each way` : ''}`);
console.log(`play: http://127.0.0.1:5177/rumble.html?network=1  (npm run dev) · rooms: http://127.0.0.1:5177/play/<code>`);
if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1')
  for (const [name, addrs] of Object.entries(networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  LAN (${name}): http://${a.address}:5177/rumble.html?network=1  (npm run dev -- --host 0.0.0.0)`);

const every = 10;
setInterval(() => {
  const s = server.stats;
  const snap = server.host.latest;
  const control = server.host.state().control;
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] ${(s.ticks / every).toFixed(1)} ticks/s (late mean ${s.lateMean.toFixed(2)} ms, max ${s.lateMax.toFixed(1)} ms, dropped ${s.dropped}) · ${(s.statesSent / every).toFixed(1)} states/s, ${s.lastStateBytes} B each · out ${(s.bytesOut / every / 1024).toFixed(1)} KB/s, in ${(s.bytesIn / every / 1024).toFixed(2)} KB/s · ${s.clients} client(s) · ${Object.entries(control).map(([id, c]) => `${id}:${c}`).join(' ')} · round ${snap.round} ${snap.phase} · ${snap.fighters.map((f) => `${f.id}=${f.score}`).join(' ')}`,
  );
  server.resetStats();
}, every * 1000);

const stop = () => server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
