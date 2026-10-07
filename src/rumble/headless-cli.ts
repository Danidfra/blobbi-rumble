/**
 * `npm run headless`: play bot-only Rumble matches in plain Node, with no
 * browser, and print what happened and how fast. Options as environment
 * variables: MATCHES (3), PLAYERS (4), HZ (60).
 */
import { loadHavokNode } from './sim/havokNode';
import { runHeadless } from './headless';

const matches = Number(process.env.MATCHES ?? 3);
const players = Number(process.env.PLAYERS ?? 4) as 2 | 3 | 4;
const hz = Number(process.env.HZ ?? 60);

const havok = await loadHavokNode();
let inconsistent = 0;
let nonFinite = 0;
const r = runHeadless({
  havok,
  players,
  matches,
  dt: 1 / hz,
  onStep: (m, s) => {
    if (!m.holdsConsistent()) inconsistent++;
    for (const f of s.fighters) if (![f.position.x, f.position.y, f.position.z, f.velocity.x, f.velocity.y, f.velocity.z].every(Number.isFinite)) nonFinite++;
  },
});
const counts: Record<string, number> = {};
for (const e of r.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
r.matches.forEach((m, i) => console.log(`match ${i + 1}: ${m.winner ?? 'unfinished'} wins after ${m.rounds} rounds, ${m.seconds.toFixed(1)} s simulated · ${JSON.stringify(m.scores)}`));
console.log(`events ${JSON.stringify(counts)}`);
console.log(`${r.ticks} ticks at ${hz} Hz = ${r.simulatedSeconds.toFixed(1)} s simulated in ${r.wallSeconds.toFixed(2)} s wall: ${(r.simulatedSeconds / r.wallSeconds).toFixed(1)}× real time, ${((r.wallSeconds * 1000) / r.ticks).toFixed(3)} ms per tick`);
console.log(`holds inconsistent on ${inconsistent} ticks · non-finite fighter state on ${nonFinite} ticks`);
