/**
 * L4.6-FIX1: HOW FRAMES ARE REALLY DELIVERED, for the FPS counter. Babylon's
 * own figure (`engine.getFps()`) is only measured inside its render loop;
 * the network page draws from its own `requestAnimationFrame` loop, so that
 * figure stayed at its starting 60 whatever happened (a 300 ms stall
 * included). This meter is fed the real time between drawn frames and
 * answers, over the last second: frames per second and the worst frame.
 * A worst frame is what a player feels as a stutter; an average hides it.
 * Pure and allocation-free per frame (a fixed ring of times).
 */
export class FrameMeter {
  private readonly at: Float64Array;
  private readonly gap: Float64Array;
  private n = 0;
  private head = 0;
  private last = -1;

  constructor(
    private readonly windowMs = 1000,
    size = 512,
  ) {
    this.at = new Float64Array(size);
    this.gap = new Float64Array(size);
  }

  /** A frame was drawn at `nowMs` (the page's clock). */
  frame(nowMs: number) {
    if (this.last >= 0) {
      this.at[this.head] = nowMs;
      this.gap[this.head] = nowMs - this.last;
      this.head = (this.head + 1) % this.at.length;
      this.n = Math.min(this.n + 1, this.at.length);
    }
    this.last = nowMs;
  }

  /** Over the last `windowMs` before `nowMs`: frames per second (null before two frames) and the longest frame, ms. */
  read(nowMs: number): { fps: number | null; worstMs: number } {
    let frames = 0;
    let span = 0;
    let worst = 0;
    for (let k = 1; k <= this.n; k++) {
      const i = (this.head - k + this.at.length) % this.at.length;
      if (nowMs - this.at[i] > this.windowMs) break;
      frames += 1;
      span += this.gap[i];
      if (this.gap[i] > worst) worst = this.gap[i];
    }
    // A page that stopped drawing: the time since its last frame is the worst one.
    if (this.last >= 0) worst = Math.max(worst, nowMs - this.last > this.windowMs ? nowMs - this.last : 0);
    return { fps: frames && span > 0 ? (1000 * frames) / span : null, worstMs: worst };
  }
}
