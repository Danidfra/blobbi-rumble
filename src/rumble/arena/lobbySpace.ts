/**
 * THE SOCIAL LOBBY'S SPACE (L4): Blobbi Plaza, a small floating square
 * where a lobby room's Blobbis gather between matches. Data, in the shape
 * of an arena (`ArenaDef`), so the colliders, the spawns, the physics debug
 * view and the camera's limits are built by the same code as an arena's;
 * but it is NOT an arena: it is not in `ARENAS`, so it can never be chosen,
 * rotated to, listed or played on, and nothing in it scores.
 *
 *   the plaza    one flat floor, 13 × 10 m, at y = 0: flat on purpose, so
 *                the page's movement prediction is exact everywhere on it
 *   the fence    four walls (1.6 m, higher than any jump) all round the
 *                plaza: nobody walks or is bumped off; the fall line and
 *                its respawn stay as a safety net only
 *   the rest     everything decorative (the hedge, the lanterns, the arch,
 *                the arena sign) stands on the rim outside the fence, in
 *                the view only: nothing inside the fence to walk into that
 *                the prediction does not know about
 *
 * Four seats, four spots round the middle, facing it.
 */
import type { ArenaDef } from './arenas';
import { ARENAS } from './arenas';
import type { Platform } from './geometry';
import type { Planar } from './layout';
import { RUMBLE_BODY } from '../profile';

/** The plaza's walkable half-extents, metres (inside the fence). */
export const PLAZA = Object.freeze({ halfWidth: 6.5, halfDepth: 5, wallHeight: 1.6, wallThickness: 0.4 });

const wall = (x: number, z: number, halfWidth: number, halfDepth: number, name: string): Platform => ({ x, z, halfWidth, halfDepth, y: PLAZA.wallHeight, thickness: PLAZA.wallHeight + 0.6, kind: 'wall', name });
const t = PLAZA.wallThickness / 2;

/**
 * The spots, by index among a space's seats: a ring of four round the
 * middle (a lobby room's P1..P4), a wider ring of four (L4.1: the public
 * plaza's P5..P8), then two far corners for the plaza's ambient bots, so
 * a bot appears away from where people stand.
 */
const SPOTS: readonly Planar[] = Object.freeze([
  { x: -2.2, z: 1.2 },
  { x: 2.2, z: 1.2 },
  { x: -2.2, z: -1.4 },
  { x: 2.2, z: -1.4 },
  { x: 0, z: 2.9 },
  { x: 0, z: -3.1 },
  { x: -4.4, z: -0.1 },
  { x: 4.4, z: -0.1 },
  { x: -5.3, z: 3.9 },
  { x: 5.3, z: 3.9 },
]);

export const LOBBY_SPACE: ArenaDef = Object.freeze({
  id: 'blobbi-plaza',
  name: 'Blobbi Plaza',
  description: 'The lobby: a small floating square to gather on between matches.',
  theme: 'social',
  platforms: Object.freeze([
    { x: 0, z: 0, halfWidth: PLAZA.halfWidth + PLAZA.wallThickness, halfDepth: PLAZA.halfDepth + PLAZA.wallThickness, y: 0, thickness: 0.6, kind: 'floor', name: 'plaza' } satisfies Platform,
    wall(0, PLAZA.halfDepth + t, PLAZA.halfWidth + PLAZA.wallThickness, t, 'north fence'),
    wall(0, -(PLAZA.halfDepth + t), PLAZA.halfWidth + PLAZA.wallThickness, t, 'south fence'),
    wall(PLAZA.halfWidth + t, 0, t, PLAZA.halfDepth, 'east fence'),
    wall(-(PLAZA.halfWidth + t), 0, t, PLAZA.halfDepth, 'west fence'),
  ]),
  dynamics: Object.freeze([]),
  conveyors: Object.freeze([]),
  sweeper: null,
  orbs: Object.freeze([]),
  spawnSets: { 2: SPOTS.slice(0, 2), 3: SPOTS.slice(0, 3), 4: SPOTS.slice(0, 4) },
  fallY: -4,
  ledges: false,
  camera: { bounds: { x: PLAZA.halfWidth, z: PLAZA.halfDepth }, maxRadius: 12 },
  iceFriction: 0.35,
});

/** Whether a space id is the social lobby's (the page's cue that its fighter walks the plaza, not a match). */
export const isSocialSpace = (id: unknown) => id === LOBBY_SPACE.id;

/** Any space a snapshot may name: a combat arena, or the plaza. For the view; choosing an arena is `arenaById`'s. */
export function spaceById(id: unknown): ArenaDef | null {
  if (id === LOBBY_SPACE.id) return LOBBY_SPACE;
  return typeof id === 'string' ? (ARENAS.find((a) => a.id === id) ?? null) : null;
}

/** A seat's spot on the plaza (by its index among the room's seats), facing the middle. */
export function plazaSpot(seatIndex: number): { x: number; y: number; z: number; yaw: number } {
  const p = SPOTS[((seatIndex % SPOTS.length) + SPOTS.length) % SPOTS.length];
  return { x: p.x, y: 0, z: p.z, yaw: Math.atan2(-p.x, -p.z) };
}

/** Whether a point is on the plaza's floor (inside the fence; `inset` keeps that far from it). */
export const onPlaza = (p: Planar, inset = 0) => Math.abs(p.x) <= PLAZA.halfWidth - inset && Math.abs(p.z) <= PLAZA.halfDepth - inset;

/** A point kept inside the fence by `margin` (a body's radius): where the walls stop it. */
export function insidePlaza(p: Planar, margin: number): Planar {
  const ax = PLAZA.halfWidth - margin;
  const az = PLAZA.halfDepth - margin;
  return { x: Math.max(-ax, Math.min(ax, p.x)), z: Math.max(-az, Math.min(az, p.z)) };
}

/** L4: the plaza as the page's movement model sees it: one floor, and the fence stopping a body's centre a radius short of it. */
export const PLAZA_TERRAIN = Object.freeze({
  onFloor: (p: Planar, inset: number) => onPlaza(p, inset),
  clamp: (p: Planar) => insidePlaza(p, RUMBLE_BODY.capsuleRadius),
});
