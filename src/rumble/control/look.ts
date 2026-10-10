/**
 * CAMERA LOOK BY TOUCH (M12.1), as pure state: a finger dragged across an
 * unused part of the arena turns the camera round the fight, horizontally
 * only. One finger owns the look at a time, by pointer id; the stick's and
 * the buttons' fingers never reach it (they are other elements), and a
 * second finger on the arena does not steal it. The look is presentation:
 * it turns the camera, and the camera's yaw is what makes the stick's "up"
 * mean "away from the camera" (`input.ts`), so movement stays screen-true
 * at any angle. Nothing of it reaches the match.
 */
export const LOOK = Object.freeze({
  /** Radians of camera yaw per CSS pixel of horizontal drag (a full screen width of a phone on its side is about 330°). */
  radiansPerPixel: 0.0068,
});

export class LookDrag {
  private owner: number | null = null;
  private lastX = 0;
  private pending = 0;

  constructor(private readonly radiansPerPixel = LOOK.radiansPerPixel) {}

  /** A finger landed on the look area: it owns the look, unless another finger already does. */
  down(id: number, x: number): boolean {
    if (this.owner !== null) return false;
    this.owner = id;
    this.lastX = x;
    return true;
  }

  /** The owning finger moved (any other finger's move is ignored). Dragging right turns the view so the arena follows the finger. */
  move(id: number, x: number) {
    if (id !== this.owner || !Number.isFinite(x)) return;
    this.pending -= (x - this.lastX) * this.radiansPerPixel;
    this.lastX = x;
  }

  /** A finger lifted or was cancelled. */
  up(id: number) {
    if (id === this.owner) this.owner = null;
  }

  /** Let go (focus lost, a modal, the screen turned); a drag not yet taken is dropped too. */
  releaseAll() {
    this.owner = null;
    this.pending = 0;
  }

  /** The yaw change since the last take, radians. */
  take(): number {
    const d = this.pending;
    this.pending = 0;
    return d;
  }

  get active(): boolean {
    return this.owner !== null;
  }
}

/** The camera's yaw offset easing toward its target: quick (no felt lag), never overshooting. */
export function easeYaw(current: number, target: number, dt: number, rate = 28): number {
  const k = 1 - Math.exp(-Math.max(0, dt) * rate);
  return current + (target - current) * k;
}
