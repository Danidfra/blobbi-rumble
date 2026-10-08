/**
 * WHERE DECORATION MAY GO, as pure geometry: deterministic spots on the
 * lawn for small flowers, tufts, stones and mushrooms, kept out of every
 * place where reading the arena matters. Never near a rim (the boundary of
 * play stays clean and honest), never near a spawn, an orb, the sweeper's
 * circle or the seams where the wings meet the centre (the crossings), and
 * never in the middle. Decoration has no collision; this keeps it from
 * ever looking as if it might.
 */
import { onFloor, rimDistance, spawnPoints } from '../arena/layout';
import { ORBS, SWEEPER } from '../tuning';
import { seeded } from './seeded';

export const DECOR_RULES = Object.freeze({
  /** Clear of the rim by this much, metres. */
  rim: 0.5,
  /** Clear of any spawn (for 2, 3 or 4 fighters), any orb, and the arena's middle. */
  spawn: 1.3,
  orb: 1.1,
  middle: 1.2,
  /** Clear of the sweeper's reach by this much. */
  sweeper: 0.6,
  /** The seams: no decoration within this of x = ±4 where the wings meet the centre. */
  seam: 0.7,
  /** Spots at least this far apart. */
  spacing: 0.55,
});

export type DecorKind = 'flower' | 'tuft' | 'stone' | 'mushroom';

export interface DecorSpot {
  x: number;
  z: number;
  kind: DecorKind;
  /** 0..1: picks a colour or variant. */
  variant: number;
  rotation: number;
  scale: number;
}

/** Whether a point is somewhere decoration may stand. */
export function decorAllowed(p: { x: number; z: number }, r = DECOR_RULES): boolean {
  if (!onFloor(p, r.rim) || rimDistance(p) < r.rim) return false;
  if (Math.hypot(p.x, p.z) < r.middle) return false;
  if (Math.abs(Math.abs(p.x) - 4) < r.seam && Math.abs(p.z) < 3) return false;
  if (Math.hypot(p.x - SWEEPER.pivot.x, p.z - SWEEPER.pivot.z) < SWEEPER.reach + r.sweeper) return false;
  for (const o of ORBS.points) if (Math.hypot(p.x - o.x, p.z - o.z) < r.orb) return false;
  for (const n of [2, 3, 4] as const) for (const s of spawnPoints(n)) if (Math.hypot(p.x - s.x, p.z - s.z) < r.spawn) return false;
  return true;
}

/** The decoration of the arena: the same spots every time for a seed. */
export function decorSpots(seed = 1, count = 46, r = DECOR_RULES): DecorSpot[] {
  const rnd = seeded(seed);
  const spots: DecorSpot[] = [];
  for (let tries = 0; spots.length < count && tries < count * 60; tries++) {
    const p = { x: (rnd() * 2 - 1) * 7.5, z: (rnd() * 2 - 1) * 4 };
    if (!decorAllowed(p, r)) continue;
    if (spots.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < r.spacing)) continue;
    const k = rnd();
    const kind: DecorKind = k < 0.42 ? 'flower' : k < 0.78 ? 'tuft' : k < 0.93 ? 'stone' : 'mushroom';
    spots.push({ ...p, kind, variant: rnd(), rotation: rnd() * Math.PI * 2, scale: 0.8 + rnd() * 0.45 });
  }
  return spots;
}
