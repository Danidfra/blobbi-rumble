/**
 * UNITS AND FRAMES. The builders think in the kit's root units; the scene is
 * in metres. One root unit is 1/630.667 m, so the canonical adult body
 * (crown to base) is exactly 1.0 m tall and about 0.84 m wide, and the whole
 * character with its feet stands 1.05 m: a good size for a party-game
 * character next to a 1.8 m human.
 *
 * The character faces +Z. A camera in front of it, at +Z looking back,
 * sees world +X on the viewer's LEFT. The kit describes everything in the
 * VIEWER'S frame of the front drawing ("the viewer's left eye", "a single
 * antenna on the viewer's right"), so one constant converts: a thing on the
 * viewer's side `s` (-1 left, 1 right) is at world x = `VIEWER_X * s * offset`.
 */
import { CANON_HEIGHT, GROUND } from './plan';

/** Metres per root unit. */
export const UNIT = 1 / CANON_HEIGHT;
/** World x per viewer x (the front drawing's x axis, viewer's right positive). */
export const VIEWER_X = -1;

/** A root-unit length in metres. */
export const m = (units: number) => units * UNIT;
/** A root-unit height (y down the artwork) as a world height (y up from the ground). */
export const worldY = (rootY: number) => (GROUND - rootY) * UNIT;
/** A viewer-frame x offset (root units, viewer's right positive) as world x in metres. */
export const worldX = (viewerX: number) => VIEWER_X * viewerX * UNIT;
