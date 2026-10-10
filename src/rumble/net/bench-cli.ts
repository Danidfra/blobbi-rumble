/**
 * `npm run bench`: how many rooms one process can simulate. Runs ROOMS
 * (8) rooms of bot-only Rumble, each its own Havok world and RumbleHost,
 * for SECONDS (10) of simulated time at 60 Hz, with four connected
 * "players" per room so the roster and state messages are built as for
 * real spectators (serialised, not sent), and prints wall time per tick per
 * room. A tick budget at 60 Hz is 16.7 ms for ALL rooms together: the
 * printed total per tick must stay well under it, with headroom for the
 * sockets. Capacity is what this says on the machine it runs on, nothing
 * promised beyond it. ARENA (M11A) names the arena the rooms play (the
 * classic island by default), so the cost of pieces, belts and ledges shows.
 */
import { arenaById } from '../arena/arenas';
import { loadHavokNode } from '../sim/havokNode';
import { RoomManager } from './rooms';

const roomsWanted = Number(process.env.ROOMS ?? 8);
const seconds = Number(process.env.SECONDS ?? 10);
const arena = arenaById(process.env.ARENA) ?? undefined;
const havok = await loadHavokNode();
const manager = new RoomManager({ havok, maxRooms: Math.max(roomsWanted, 1) + 2 });
const rooms = [];
for (let i = 0; i < roomsWanted; i++) {
  const r = manager.create({ listed: true, ...(arena ? { arena } : {}) });
  if (r) rooms.push(r);
}
console.log(`arena: ${rooms[0]?.host.arena.id ?? '-'}`);
let conn = 1;
for (const r of rooms) for (let p = 0; p < 4; p++) r.host.connect(conn++);
const ticks = Math.round(seconds * 60);
const start = performance.now();
let serialised = 0;
for (let t = 0; t < ticks; t++) {
  for (const r of rooms) {
    r.host.tick();
    if (t % 3 === 0) serialised += JSON.stringify(r.host.state()).length;
  }
}
const wall = performance.now() - start;
const perTick = wall / ticks;
console.log(`${rooms.length} rooms × ${ticks} ticks (${seconds} s at 60 Hz, 4 players each) in ${(wall / 1000).toFixed(2)} s wall`);
console.log(`${perTick.toFixed(2)} ms per tick for all rooms (${(perTick / rooms.length).toFixed(3)} ms per room per tick) · budget 16.67 ms · ${(wall / 1000 / seconds).toFixed(2)}× real time`);
console.log(`state messages: ${(serialised / (ticks / 3) / rooms.length).toFixed(0)} B each, ${((serialised / seconds) * 8 / rooms.length / 1e6).toFixed(2)} Mbit/s per room to 8 connections at 20 Hz`);
console.log(`listing: ${JSON.stringify(manager.listing()).length} B for ${manager.listing().length} rooms`);
manager.dispose();
