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
  camera: { bounds: { x: number; z: number }; maxRadius: number };
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
 * Skyfall: a larger floating garden in several islands. A big centre, an
 * east island half a metre up over a breakable bridge, a west island half
 * a metre down over another, a south step up to a high perch, a low ledge
 * along the north rim to fall onto and climb back from, and two falling
 * pads at the centre's corners that tempt a fight and drop it.
 */
export const SKYFALL: ArenaDef = Object.freeze({
  id: 'floating-islands-skyfall',
  name: 'Floating Islands: Skyfall',
  description: 'Several islands, bridges that break, pads that fall, a ledge to climb back from. Watch the edges.',
  theme: 'garden',
  platforms: Object.freeze([
    F(0, 0, 5, 4, 0, 'floor', 0.6, 'centre'),
    F(8.6, 1.6, 2, 2, 0.5, 'platform', 0.5, 'east island'),
    F(5.8, 1.6, 0.8, 0.85, 0, 'bridge', 0.2, 'east bridge'),
    F(-8.4, -1.2, 2.2, 1.8, -0.5, 'platform', 0.5, 'west island'),
    F(-6.1, -1.2, 1.1, 0.85, -0.5, 'bridge', 0.2, 'west bridge'),
    F(0, 4.8, 3, 0.8, -1.2, 'platform', 0.4, 'north ledge'),
    F(-1, -4.9, 1.3, 0.9, 0.5, 'platform', 0.5, 'south step'),
    F(-1, -7, 1.6, 1.2, 1, 'platform', 0.5, 'south perch'),
    F(4.4, 5.2, 1.2, 1.2, 0, 'platform', 0.4, 'north-east pad'),
    F(-4.4, -5.2, 1.2, 1.2, 0, 'platform', 0.4, 'south-west pad'),
  ]),
  dynamics: Object.freeze([
    D(2, { kind: 'breakable', impacts: 3, after: 28, warn: 1.6, fall: 0.5, back: 0 }),
    D(4, { kind: 'breakable', impacts: 3, after: 34, warn: 1.6, fall: 0.5, back: 0 }),
    D(8, { kind: 'falling', arm: 1.2, warn: 1.3, fall: 0.5, back: 8 }),
    D(9, { kind: 'falling', arm: 1.2, warn: 1.3, fall: 0.5, back: 8 }),
  ]),
  conveyors: Object.freeze([]),
  sweeper: null,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 8.6, z: 1.6 },
    { x: -8.4, z: -1.2 },
  ]),
  spawnSets: {
    2: [
      { x: -2.8, z: 0 },
      { x: 2.8, z: 0 },
    ],
    3: [
      { x: 0, z: -2.8 },
      { x: 2.4, z: 1.4 },
      { x: -2.4, z: 1.4 },
    ],
    4: [
      { x: -2.8, z: -2.4 },
      { x: 2.8, z: -2.4 },
      { x: -2.8, z: 2.4 },
      { x: 2.8, z: 2.4 },
    ],
  },
  fallY: -5,
  ledges: true,
  camera: { bounds: { x: 7.5, z: 5.5 }, maxRadius: 19 },
  iceFriction: 0.35,
});

/** The factory's rotating arm: the sweeper's rules with its own pivot, on the west pad; a little faster and shorter than the garden's. */
const FACTORY_ARM: SweeperTuning = Object.freeze({ ...SWEEPER, pivot: { x: -6.5, z: 0 }, reach: 1.7, angularSpeed: 1.9, impactFloor: 1.6 });

/**
 * The factory: a main floor with two conveyor belts running opposite ways
 * across it (toward the rims), a raised crate in the middle to fight on
 * and jump between belts from, a pad on each side, and a rotating arm on
 * the west pad.
 */
export const FACTORY: ArenaDef = Object.freeze({
  id: 'blobbi-factory',
  name: 'Blobbi Factory',
  description: 'Conveyor belts carry you toward the edges, a crate in the middle, a rotating arm on the west pad.',
  theme: 'factory',
  platforms: Object.freeze([
    F(0, 0, 4.75, 3.6, 0, 'floor', 0.6, 'main floor'),
    F(0, 2.3, 4.75, 0.75, 0.02, 'conveyor', 0.1, 'north belt'),
    F(0, -2.3, 4.75, 0.75, 0.02, 'conveyor', 0.1, 'south belt'),
    F(0, 0, 1.4, 0.9, 0.6, 'platform', 0.6, 'crate'),
    F(6.25, 0, 1.5, 2.2, 0, 'floor', 0.6, 'east pad'),
    F(-6.5, 0, 1.75, 2.2, 0, 'floor', 0.6, 'west pad'),
  ]),
  dynamics: Object.freeze([]),
  conveyors: Object.freeze([
    { platform: 1, vx: 1.7, vz: 0 },
    { platform: 2, vx: -1.7, vz: 0 },
  ]),
  sweeper: FACTORY_ARM,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 6.6, z: 0 },
    { x: -6.5, z: 1.6 },
  ]),
  spawnSets: {
    2: [
      { x: -3, z: 0 },
      { x: 3, z: 0 },
    ],
    3: [
      { x: 0, z: -1.3 },
      { x: 3.2, z: 0.5 },
      { x: -3.2, z: 0.5 },
    ],
    4: [
      { x: -3.2, z: -0.9 },
      { x: 3.2, z: -0.9 },
      { x: -3.2, z: 0.9 },
      { x: 3.2, z: 0.9 },
    ],
  },
  fallY: -4,
  ledges: true,
  camera: { bounds: { x: 5.5, z: 3 }, maxRadius: 15 },
  iceFriction: 0.35,
});

/**
 * The frozen lake: a sheet of ice in a cross of solid tiles with four
 * fragile corner tiles that crack, give and leave holes, and four lobes
 * around it. Little grip everywhere: momentum is the game.
 */
const TILE = 1.45;
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
    F(5.6, 0, 1.3, 2.4, 0, 'ice', 0.5, 'east lobe'),
    F(-5.6, 0, 1.3, 2.4, 0, 'ice', 0.5, 'west lobe'),
  ]),
  dynamics: Object.freeze([
    D(5, { kind: 'falling', arm: 1.4, warn: 1.4, fall: 0.4, back: 9 }),
    D(6, { kind: 'falling', arm: 1.4, warn: 1.4, fall: 0.4, back: 9 }),
    D(7, { kind: 'falling', arm: 1.4, warn: 1.4, fall: 0.4, back: 9 }),
    D(8, { kind: 'falling', arm: 1.4, warn: 1.4, fall: 0.4, back: 9 }),
  ]),
  conveyors: Object.freeze([]),
  sweeper: null,
  orbs: Object.freeze([
    { x: 0, z: 0 },
    { x: 5.6, z: 0 },
    { x: -5.6, z: 0 },
  ]),
  spawnSets: {
    2: [
      { x: -2.9, z: 0 },
      { x: 2.9, z: 0 },
    ],
    3: [
      { x: 0, z: -2.9 },
      { x: 2.9, z: 0 },
      { x: -2.9, z: 0 },
    ],
    4: [
      { x: -2.9, z: 0 },
      { x: 2.9, z: 0 },
      { x: 0, z: -2.9 },
      { x: 0, z: 2.9 },
    ],
  },
  fallY: -4,
  ledges: false,
  camera: { bounds: { x: 5, z: 3.5 }, maxRadius: 15 },
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
