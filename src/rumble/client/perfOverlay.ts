/**
 * THE PERFORMANCE OVERLAY (`?debug=perf`): FPS, frame time, draw calls,
 * triangles, the internal rendering resolution, the WebGL in use and, on a
 * server, the latency. Off by default and then costs nothing: this module
 * is loaded only when asked for (a dynamic import), Babylon's draw-call
 * instrumentation with it, and the text is rewritten four times a second,
 * not every frame.
 *
 *   FrameMeter     frame intervals over the last second: mean, worst, FPS (pure)
 *   perfLines()    the overlay's text from one sample (pure)
 *   attachPerfOverlay()  the DOM box and the Babylon hooks
 */
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { Scene } from '@babylonjs/core/scene';

/** Frame intervals (ms) over a sliding window of `windowMs`. */
export class FrameMeter {
  private readonly frames: { at: number; dt: number }[] = [];
  private last: number | null = null;
  constructor(private readonly windowMs = 1000) {}

  /** One frame drawn at `now` (ms). */
  tick(now: number) {
    if (this.last !== null) this.frames.push({ at: now, dt: now - this.last });
    this.last = now;
    while (this.frames.length && now - this.frames[0].at > this.windowMs) this.frames.shift();
  }

  /** Frames per second, the mean and the worst interval (ms), over the window; zeros before two frames. */
  get stats(): { fps: number; mean: number; worst: number } {
    const n = this.frames.length;
    if (!n) return { fps: 0, mean: 0, worst: 0 };
    let sum = 0;
    let worst = 0;
    for (const f of this.frames) {
      sum += f.dt;
      worst = Math.max(worst, f.dt);
    }
    const mean = sum / n;
    return { fps: mean > 0 ? 1000 / mean : 0, mean, worst };
  }
}

export interface PerfSample {
  fps: number;
  frameMs: number;
  worstMs: number;
  drawCalls: number;
  triangles: number;
  width: number;
  height: number;
  /** Rendered pixels per CSS pixel (1 / hardware scaling). */
  scale: number;
  webgl: number;
  /** Round trip to the server, ms (NaN: none yet; undefined: offline game). */
  rtt?: number;
}

export function perfLines(s: PerfSample): string[] {
  const n = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x)));
  return [
    `${s.fps.toFixed(0)} fps · frame ${s.frameMs.toFixed(1)} ms (worst ${s.worstMs.toFixed(1)})`,
    `${n(s.drawCalls)} draw calls · ${n(s.triangles)} triangles`,
    `${s.width}×${s.height} px (×${s.scale.toFixed(2)}) · WebGL ${s.webgl}`,
    s.rtt === undefined ? 'offline game' : Number.isNaN(s.rtt) ? 'latency …' : `latency ${Math.round(s.rtt)} ms`,
  ];
}

/** The overlay on `scene`: a small box top left, updated four times a second. Returns a function that removes it. */
export async function attachPerfOverlay(engine: Engine, scene: Scene, rtt?: () => number): Promise<() => void> {
  const { SceneInstrumentation } = await import('@babylonjs/core/Instrumentation/sceneInstrumentation');
  const instrumentation = new SceneInstrumentation(scene);
  const meter = new FrameMeter();
  const box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;left:8px;bottom:8px;z-index:50;pointer-events:none;white-space:pre;font:11px/1.35 ui-monospace,Menlo,monospace;color:#e9ffe9;background:#000000b0;border-radius:8px;padding:6px 8px');
  box.dataset.perf = '1';
  document.body.appendChild(box);
  let triangles = 0;
  let drawCalls = 0;
  let lastWrite = 0;
  const observer = scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    meter.tick(now);
    triangles = scene.getActiveIndices() / 3;
    // The frame's own count (the instrumentation starts it anew before each render; Babylon keeps no average for it).
    drawCalls = instrumentation.drawCallsCounter.current;
    if (now - lastWrite < 250) return;
    lastWrite = now;
    const f = meter.stats;
    box.textContent = perfLines({
      fps: f.fps,
      frameMs: f.mean,
      worstMs: f.worst,
      drawCalls,
      triangles,
      width: engine.getRenderWidth(),
      height: engine.getRenderHeight(),
      scale: 1 / engine.getHardwareScalingLevel(),
      webgl: engine.webGLVersion,
      rtt: rtt?.(),
    }).join('\n');
  });
  return () => {
    scene.onAfterRenderObservable.remove(observer);
    instrumentation.dispose();
    box.remove();
  };
}
