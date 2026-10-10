/**
 * THE VIRTUAL STICK, as pure numbers (M12): a thumb's offset from the
 * stick's base becomes a screen-relative direction and strength, which the
 * input layer turns camera-relative exactly as it does the keys
 * (`input.ts`). So a stick is one more producer of the same intent: a
 * direction no longer than one, and the run flag. Nothing here is faster
 * than a keyboard can ask for: full deflection is a unit direction, the
 * same as WASD, and running needs the thumb at the rim, as running needs
 * Shift.
 *
 *   dead zone   a small offset is nothing (a resting thumb does not walk)
 *   walk        past it, a walk from `minWalk` up to a full walk, along `curve`
 *   run         at the rim (`runAt` of the radius): a full-speed run
 *
 * The output is quantised (direction and strength), so a thumb that
 * trembles does not become a stream of different intents on the wire.
 */
export const STICK = Object.freeze({
  /** Offsets under this share of the radius are nothing. */
  deadZone: 0.18,
  /** At this share of the radius and beyond: a run. */
  runAt: 0.9,
  /** The slowest walk just out of the dead zone, of a full walk. */
  minWalk: 0.35,
  /** Response exponent between the dead zone and the run (1: linear; above 1: finer at small deflections). */
  curve: 1,
  /** Directions are rounded to one of this many around the circle. */
  angleSteps: 128,
  /** Strength is rounded to this step. */
  magnitudeStep: 0.05,
});

export type StickTuning = { readonly [K in keyof typeof STICK]: number };

export interface StickOutput {
  /** Screen-relative: x to the right, y away from the camera (up the screen). Length 0..1. */
  x: number;
  y: number;
  /** The length of (x, y). */
  magnitude: number;
  run: boolean;
}

export const NEUTRAL_STICK: Readonly<StickOutput> = Object.freeze({ x: 0, y: 0, magnitude: 0, run: false });

/** The stick's output for a thumb `dx`, `dy` pixels from the base (screen axes: y down) on a stick of `radius` pixels. */
export function stickOutput(dx: number, dy: number, radius: number, t: StickTuning = STICK): StickOutput {
  if (!(radius > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return { ...NEUTRAL_STICK };
  const raw = Math.min(1, Math.hypot(dx, dy) / radius);
  if (raw < t.deadZone) return { ...NEUTRAL_STICK };
  const run = raw >= t.runAt;
  let magnitude = 1;
  if (!run) {
    const along = (raw - t.deadZone) / (t.runAt - t.deadZone);
    magnitude = t.minWalk + (1 - t.minWalk) * Math.pow(along, t.curve);
    magnitude = Math.min(1, Math.round(magnitude / t.magnitudeStep) * t.magnitudeStep);
  }
  const step = (Math.PI * 2) / t.angleSteps;
  const angle = Math.round(Math.atan2(-dy, dx) / step) * step;
  // Rounded (toward zero: never longer than one; never -0), so a still thumb sends the same numbers frame after frame.
  const x = Math.trunc(Math.cos(angle) * magnitude * 1e4) / 1e4 + 0;
  const y = Math.trunc(Math.sin(angle) * magnitude * 1e4) / 1e4 + 0;
  return { x, y, magnitude, run };
}

/**
 * Where a floating stick's base goes as the thumb moves: it stays put
 * while the thumb is within `radius`, and is dragged along behind a thumb
 * that goes further, so the knob never sits off its base and a reversal
 * always costs the same travel.
 */
export function dragBase(base: { x: number; y: number }, thumb: { x: number; y: number }, radius: number): { x: number; y: number } {
  const dx = thumb.x - base.x;
  const dy = thumb.y - base.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius || d === 0) return { x: base.x, y: base.y };
  const k = (d - radius) / d;
  return { x: base.x + dx * k, y: base.y + dy * k };
}
