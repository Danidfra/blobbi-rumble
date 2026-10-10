/**
 * THE ARENAS (M11A): what each arena IS, as data, in one registry. The
 * server picks one for a room; the match builds its colliders from it,
 * the client its visuals, the bots their map. Everything that used to be
 * "the arena" (`layout.ts`, the sweeper's pivot, the orbs' points, the
 * spawns, the fall line) is a field here, so Floating Islands Classic is
 * exactly what it was, and the others are other data, not other code.
 *
 *   platforms   rectangular floors with a top height and a thickness; the
 *               union in the plane is "the floor" for walking, the heights
 *               are for standing and for ledges (M11C)
 *   dynamics    platforms that change during a round (M11B): a FALLING pad
 *               (stable → warning → falling → gone → back) or a BREAKABLE
 *               bridge (heavy impacts, or time, make it warn, then go)
 *   conveyors   platforms that carry what stands on them (M11D)
 *   ice         platforms with little grip (M11E; a kind, not a flag)
 *   sweeper     the rotating bar, where an arena has one (its own tuning)
 *   orbs, spawns, fallY (the elimination boundary), camera bounds, theme
 *
 * Ids are stable and short; a room asks for one, a link carries one.
 */
import { ORBS, SWEEPER } from '../tuning';
import type { Platform } from './geometry';
import type { SweeperTuning } from './sweeper';
import { ARENA, type Planar } from './layout';

export type ArenaId = 'floating-islands-classic' | 'floating-islands-skyfall' | 'blobbi-factory' | 'frozen-lake';

/** How a dynamic platform behaves. Seconds. */
export type PieceRule =
  | {
      kind: 'falling';
      /** A fighter standing on it for this long (accumulated while anyone stands on it) arms it. */
      arm: number;
      /** The warning (shaking) lasts this long, then it falls for `fall` seconds, then it is gone, back after `back`. */
      warn: number;
      fall: number;
      back: number;
    }
  | {
      kind: 'breakable';
      /** Heavy impacts (a tumble reaction) on bodies over it, before it starts to go; or `after` seconds of the round, whichever first. */
      impacts: number;
      after: number;
      warn: number;
      fall: number;
      /** 0: gone for the rest of the round. */
      back: number;
    };

export interface Dynamic {
  /** Index into `platforms`. */
  platform: number;
  rule: PieceRule;
}

export interface Conveyor {
  platform: number;
  /** The belt's surface velocity, m/s, in the plane. */
  vx: number;
  vz: number;
}

export interface ArenaDef {
  id: ArenaId;
  name: string;
  description: string;
  theme: 'garden' | 'factory' | 'frozen';
  platforms: readonly Platform[];
  dynamics: readonly Dynamic[];
  conveyors: readonly Conveyor[];
  sweeper: SweeperTuning | null;
  orbs: readonly Planar[];
  spawnSets: Record<2 | 3 | 4, readonly Planar[]>;
  /** Below this height, metres, a body is out (the ring-out line). Lower than every ledge a hanging body may hold. */
  fallY: number;
  /** M11C: whether a falling fighter can catch and climb this arena's edges (not on ice, and not on the classic island, which plays exactly as it did). */
  ledges: boolean;
  /** The camera's bounds and distance limit, and (M11C) how far below the main floor a body stays in view (the default is tuning's). */
  camera: { bounds: { x: number; z: number }; maxRadius: number; dropBelow?: number };
  /** The friction of ice platforms (the body's own is 0.35). */
  iceFriction: number;
}

const F = (x: number, z: number, halfWidth: number, halfDepth: number, y = 0, kind: Platform['kind'] = 'floor', thickness = 0.6, name?: string): Platform => ({ x, z, halfWidth, halfDepth, y, thickness, kind, ...(name ? { name } : {}) });
const D = (platform: number, rule: PieceRule): Dynamic => ({ platform, rule });

/** The classic island, exactly `layout.ts`: three slabs at y = 0, the sweeper in the right wing, the three orbs, the spawns. */
export const CLASSIC: ArenaDef = Object.freeze({
  id: 'floating-islands-classic',
  name: 'Floating Islands: Classic',
  description: 'The small floating lawn: a wide centre, two wings, the sweeper on the right. Quick matches.',
  theme: 'garden',
  platforms: Object.freeze([F(0, 0, ARENA.centre.halfWidth, ARENA.centre.halfDepth, 0, 'floor', ARENA.thickness, 'centre'), F(-(ARENA.centre.halfWidth + ARENA.wings.halfWidth), 0, ARENA.wings.halfWidth, ARENA.wings.halfDepth, 0, 'floor', ARENA.thickness, 'left wing'), F(ARENA.centre.halfWidth + ARENA.wings.halfWidth, 0, ARENA.wings.halfWidth, ARENA.wings.halfDepth, 0, 'floor', ARENA.thickness, 'right wing')]),
  dynamics: Object.freeze([]),
  conveyors: Object.freeze([]),
  sweeper: SWEEPER,
  orbs: ORBS.points,
  spawnSets: ARENA.spawnSets,
  fallY: -4,
  ledges: false,
  camera: { bounds: { x: 5, z: 2.5 }, maxRadius: 14 },
  iceFriction: 0.35,
});

/**
 * Skyfall (M11.1 layout): a wide centre island, an island to the east and
 * one to the west over rope bridges that break, all at ONE height, so a
 * bridge meets its islands flush and is walked across; the vertical game
 * is around it: a low ledge the length of the north wall to fall onto and
 * climb back from, a step and a high perch to the south, and two pads at
 * the centre's north-east and south-west corners that tempt a fight and
 * drop it. Everything a fighter stands on is at least 4.5 m across.
 */
export const SKYFALL: ArenaDef = Object.freeze({
  id: 'floating-islands-skyfall',
  name: 'Floating Islands: Skyfall',
  description: 'Three islands over bridges that break, pads that fall, a ledge to climb back from. Watch the edges.',
  theme: 'garden',
  platforms: Object.freeze([
    F(0, 0, 6, 4.5, 0, 'floor', 0.6, 'centre'),
    F(10.5, 1.2, 2.5, 2.5, 0, 'platform', 0.6, 'east island'),
    F(7, 1.2, 1.0, 1.0, 0, 'bridge', 0.2, 'east bridge'),
    F(-10.5, -1.2, 2.5, 2.3, 0, 'platform', 0.6, 'west island'),
    F(-7, -1.2, 1.0, 1.0, 0, 'bridge', 0.2, 'west bridge'),
    F(0, 5.3, 3, 0.8, -1.2, 'platform', 0.4, 'north ledge'),
    F(-1, -5.5, 1.6, 1.0, 0.5, 'platform', 0.5, 'south step'),
    F(-1, -7.4, 1.8, 0.9, 1, 'platform', 0.5, 'south perch'),
    F(4.6, 5.7, 1.4, 1.2, 0, 'platform', 0.4, 'north-east pad'),
    F(-4.6, -5.7, 1.4, 1.2, 0, 'platform', 0.4, 'south-west pad'),
  ]),
  dynamics: Object.freeze([
    D(2, { kind: 'breakable', impacts: 3, after: 30, warn: 1.8, fall: 0.5, back: 0 }),
    D(4, { kind: 'breakable', impacts: 3, after: 36, warn: 1.8, fall: 0.5, back: 0 }),
    D(8, { kind: 'falling', arm: 1.4, warn: 1.5, fall: 0.5, back: 8 }),
    D(9, { kind: 'falling', arm: 1.4, warn: 1.5, fall: 0.5, back: 8 }),
  ]),
  conveyors: Object.freeze([]),
  sweeper: null,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 10.5, z: 1.2 },
    { x: -10.5, z: -1.2 },
  ]),
  spawnSets: {
    2: [
      { x: -3.2, z: 0 },
      { x: 3.2, z: 0 },
    ],
    3: [
      { x: 0, z: -2.5 },
      { x: 2.8, z: 1.6 },
      { x: -2.8, z: 1.6 },
    ],
    4: [
      { x: -3, z: -2.2 },
      { x: 3, z: -2.2 },
      { x: -3, z: 2.2 },
      { x: 3, z: 2.2 },
    ],
  },
  fallY: -5,
  ledges: true,
  camera: { bounds: { x: 9.5, z: 5.5 }, maxRadius: 24, dropBelow: -2.4 },
  iceFriction: 0.35,
});

/** The factory's rotating arm: the sweeper's rules with its own pivot in the middle of the west pad; shorter and a little slower than the garden's, so the pad's corners are clear of it. */
const FACTORY_ARM: SweeperTuning = Object.freeze({ ...SWEEPER, pivot: { x: -7.8, z: 0 }, reach: 1.7, angularSpeed: 1.6, impactFloor: 1.6 });

/**
 * The factory (M11.1 layout): a wide main floor with a conveyor belt along
 * its north and south edges running opposite ways (toward the pads), a
 * raised crate in the middle to fight on and over, a pad on each side wide
 * enough to fight on, and a rotating arm in the middle of the west pad
 * whose corners it does not reach. The belts are the fast lanes: a running
 * punch off one hits harder, a tumbling body is carried to the rim.
 */
export const FACTORY: ArenaDef = Object.freeze({
  id: 'blobbi-factory',
  name: 'Blobbi Factory',
  description: 'Belts along the edges carry you toward the pads, a crate in the middle, a rotating arm on the west pad.',
  theme: 'factory',
  platforms: Object.freeze([
    F(0, 0, 6, 4, 0, 'floor', 0.6, 'main floor'),
    F(0, 3.2, 6, 0.8, 0.02, 'conveyor', 0.1, 'north belt'),
    F(0, -3.2, 6, 0.8, 0.02, 'conveyor', 0.1, 'south belt'),
    F(0, 0, 1.6, 1.0, 0.6, 'platform', 0.6, 'crate'),
    F(7.8, 0, 1.8, 4, 0, 'floor', 0.6, 'east pad'),
    F(-7.8, 0, 1.8, 4, 0, 'floor', 0.6, 'west pad'),
  ]),
  dynamics: Object.freeze([]),
  conveyors: Object.freeze([
    { platform: 1, vx: 1.7, vz: 0 },
    { platform: 2, vx: -1.7, vz: 0 },
  ]),
  sweeper: FACTORY_ARM,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 7.8, z: 0 },
    { x: -7.8, z: 2.5 },
  ]),
  spawnSets: {
    2: [
      { x: -3.6, z: 0 },
      { x: 3.6, z: 0 },
    ],
    3: [
      { x: 0, z: -1.9 },
      { x: 3.6, z: 1.2 },
      { x: -3.6, z: 1.2 },
    ],
    4: [
      { x: -3.6, z: -1.4 },
      { x: 3.6, z: -1.4 },
      { x: -3.6, z: 1.4 },
      { x: 3.6, z: 1.4 },
    ],
  },
  fallY: -4,
  ledges: true,
  camera: { bounds: { x: 7, z: 3.5 }, maxRadius: 19, dropBelow: -1.4 },
  iceFriction: 0.35,
});

/**
 * The frozen lake (M11.1 layout): nine ice tiles of 3.6 m in a square, the
 * four corner tiles fragile (they crack under weight, give, and freeze over
 * again), and a lobe on each side. Little grip everywhere: momentum is the
 * game, and the corners are a bet.
 */
const TILE = 1.8;
export const FROZEN: ArenaDef = Object.freeze({
  id: 'frozen-lake',
  name: 'Frozen Lake',
  description: 'Everything slides. The corner tiles crack under your weight and leave holes.',
  theme: 'frozen',
  platforms: Object.freeze([
    F(0, 0, TILE, TILE, 0, 'ice', 0.5, 'middle'),
    F(2 * TILE, 0, TILE, TILE, 0, 'ice', 0.5, 'east tile'),
    F(-2 * TILE, 0, TILE, TILE, 0, 'ice', 0.5, 'west tile'),
    F(0, 2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'north tile'),
    F(0, -2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'south tile'),
    F(2 * TILE, 2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'north-east tile'),
    F(-2 * TILE, 2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'north-west tile'),
    F(2 * TILE, -2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'south-east tile'),
    F(-2 * TILE, -2 * TILE, TILE, TILE, 0, 'ice', 0.5, 'south-west tile'),
    F(3 * TILE + 1.4, 0, 1.4, 2.6, 0, 'ice', 0.5, 'east lobe'),
    F(-3 * TILE - 1.4, 0, 1.4, 2.6, 0, 'ice', 0.5, 'west lobe'),
  ]),
  dynamics: Object.freeze([
    D(5, { kind: 'falling', arm: 1.8, warn: 1.8, fall: 0.4, back: 9 }),
    D(6, { kind: 'falling', arm: 1.8, warn: 1.8, fall: 0.4, back: 9 }),
    D(7, { kind: 'falling', arm: 1.8, warn: 1.8, fall: 0.4, back: 9 }),
    D(8, { kind: 'falling', arm: 1.8, warn: 1.8, fall: 0.4, back: 9 }),
  ]),
  conveyors: Object.freeze([]),
  sweeper: null,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 3 * TILE + 1.4, z: 0 },
    { x: -3 * TILE - 1.4, z: 0 },
  ]),
  spawnSets: {
    2: [
      { x: -3.2, z: 0 },
      { x: 3.2, z: 0 },
    ],
    3: [
      { x: 0, z: -3.2 },
      { x: 3.2, z: 0 },
      { x: -3.2, z: 0 },
    ],
    4: [
      { x: -3.2, z: 0 },
      { x: 3.2, z: 0 },
      { x: 0, z: -3.2 },
      { x: 0, z: 3.2 },
    ],
  },
  fallY: -4,
  ledges: false,
  camera: { bounds: { x: 6, z: 4 }, maxRadius: 18 },
  iceFriction: 0.06,
});

export const ARENAS: readonly ArenaDef[] = Object.freeze([CLASSIC, SKYFALL, FACTORY, FROZEN]);
export const ARENA_IDS: readonly ArenaId[] = Object.freeze(ARENAS.map((a) => a.id));
export const DEFAULT_ARENA: ArenaId = 'floating-islands-classic';

/** The arena with this id, or null for anything else (untrusted input). */
export function arenaById(id: unknown): ArenaDef | null {
  return typeof id === 'string' ? (ARENAS.find((a) => a.id === id) ?? null) : null;
}

/** For a rotation: an arena other than `current`, picked by `random` (0..1). */
export function nextArena(current: ArenaId, random = Math.random()): ArenaDef {
  const others = ARENAS.filter((a) => a.id !== current);
  return others[Math.min(others.length - 1, Math.max(0, Math.floor(random * others.length)))];
}

/** The spawns for this many fighters on an arena, each facing its middle. */
export function arenaSpawns(a: ArenaDef, count: 2 | 3 | 4): { x: number; y: number; z: number; yaw: number }[] {
  return a.spawnSets[count].map((p) => {
    const under = a.platforms.filter((r) => Math.abs(p.x - r.x) <= r.halfWidth && Math.abs(p.z - r.z) <= r.halfDepth);
    const y = under.length ? Math.max(...under.map((r) => r.y)) : 0;
    return { x: p.x, y, z: p.z, yaw: Math.atan2(-p.x, -p.z) };
  });
}
