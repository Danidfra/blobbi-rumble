/**
 * GRAPHICS QUALITY (M12), as pure rules: how many pixels the scene is
 * drawn at and how fine its one shadow map is. Those are the renderer's
 * real costs here (no post-processing, no particle systems; one sun
 * shadow cast by the fighters, orbs, peels and sweeper), so they are the
 * only two things a profile changes. The look stays the canonical one:
 * the same meshes, materials, colours, shadows and feedback at every
 * level, only drawn at fewer pixels and with a coarser shadow.
 *
 *   high    the screen's own pixels, up to 3 per CSS pixel (a 3× phone's
 *           native sharpness; a 2× desktop as before), a 2048 shadow map,
 *           PCF medium
 *   medium  up to 2, a 1024 map, PCF low
 *   low     1, a 512 map, PCF low
 *   auto    from what the device reports, then measured frame times
 *           (`FrameBudget`): a sustained slow frame lowers the pixel ratio
 *           a step, a sustained easy one raises it back, never past the cap.
 *           A finger as the main pointer: up to 2 with the 1024 shadow;
 *           few cores or little memory: low; else (a desktop): up to 2
 *           with the 2048 shadow, which is what desktops always drew.
 *
 * M12.1: Auto on a phone drew at most 1.5 device pixels per CSS pixel: on
 * a 3× iPhone, half its resolution each way (the playtest's "less sharp
 * than desktop"). It now starts at 2 (1.8× the pixels) and High may go to
 * the screen's 3; the frame budget still steps down a phone that cannot
 * keep up.
 *
 * No user-agent string is read anywhere. Nothing here touches the match:
 * the simulation and the server's tick are the same at every level.
 */
export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityChoice = 'auto' | QualityLevel;

export interface RenderProfile {
  level: QualityLevel;
  /** What the settings show: the level, or 'auto'. */
  label: QualityChoice;
  /** The most device pixels drawn per CSS pixel (never more than the screen has). */
  maxRatio: number;
  /** The fewest, for the automatic budget. */
  minRatio: number;
  shadowMap: number;
  /** Shadow filtering quality (Babylon's PCF levels). */
  shadowFilter: 'low' | 'medium';
}

export const PROFILES: Readonly<Record<QualityLevel, RenderProfile>> = Object.freeze({
  high: { level: 'high', label: 'high', maxRatio: 3, minRatio: 1, shadowMap: 2048, shadowFilter: 'medium' },
  medium: { level: 'medium', label: 'medium', maxRatio: 2, minRatio: 1, shadowMap: 1024, shadowFilter: 'low' },
  low: { level: 'low', label: 'low', maxRatio: 1, minRatio: 0.75, shadowMap: 512, shadowFilter: 'low' },
});

export const QUALITY_CHOICES: readonly QualityChoice[] = ['auto', 'low', 'medium', 'high'];

/** What the device says of itself, through standard APIs only. */
export interface DeviceHints {
  /** The primary pointer is coarse (a finger). */
  coarse: boolean;
  /** `navigator.hardwareConcurrency`, if known. */
  cores?: number;
  /** `navigator.deviceMemory` (GB, Chromium only), if known. */
  memory?: number;
}

/** The profile a choice starts from on a device. */
export function profileFor(choice: QualityChoice, hints: DeviceHints): RenderProfile {
  if (choice !== 'auto') return PROFILES[choice];
  if ((hints.cores !== undefined && hints.cores <= 2) || (hints.memory !== undefined && hints.memory <= 2)) return { ...PROFILES.low, label: 'auto' };
  // A phone: medium shadows at up to 2 pixels per CSS pixel; a desktop: high, at the 2 it always drew.
  return hints.coarse ? { ...PROFILES.medium, label: 'auto' } : { ...PROFILES.high, maxRatio: 2, label: 'auto' };
}

/** The pixel ratio to draw at: the screen's, within the profile's cap. */
export const ratioFor = (profile: RenderProfile, devicePixelRatio: number) => Math.max(Math.min(profile.minRatio, devicePixelRatio || 1), Math.min(profile.maxRatio, devicePixelRatio || 1));

export const BUDGET = Object.freeze({
  /** Frames are judged over windows this long, seconds. */
  window: 2,
  /** A window whose mean frame is slower than this (s) lowers the ratio; one faster than `easy`, after `easyWindows` in a row, raises it. */
  slow: 1 / 40,
  easy: 1 / 55,
  easyWindows: 3,
  /** The ratio moves in steps of this. */
  step: 0.25,
  /** Frames longer than this (a hidden tab, a stall) are not counted, seconds. */
  ignoreAbove: 0.25,
});

/**
 * The automatic budget: fed each frame's real duration, it answers a new
 * pixel ratio when the measured frames ask for one, else null. Allocation
 * free per frame.
 */
export class FrameBudget {
  private sum = 0;
  private frames = 0;
  private elapsed = 0;
  private easyRun = 0;
  /** The last window's mean frame time, s (for the diagnostics). */
  lastMean = 0;

  constructor(
    public ratio: number,
    private readonly min: number,
    private readonly max: number,
    private readonly t = BUDGET,
  ) {}

  sample(dt: number): number | null {
    if (!(dt > 0) || dt > this.t.ignoreAbove) return null;
    this.sum += dt;
    this.frames += 1;
    this.elapsed += dt;
    if (this.elapsed < this.t.window) return null;
    const mean = this.sum / this.frames;
    this.lastMean = mean;
    this.sum = this.frames = this.elapsed = 0;
    if (mean > this.t.slow && this.ratio > this.min) {
      this.easyRun = 0;
      this.ratio = Math.max(this.min, this.ratio - this.t.step);
      return this.ratio;
    }
    if (mean < this.t.easy && this.ratio < this.max) {
      if (++this.easyRun < this.t.easyWindows) return null;
      this.easyRun = 0;
      this.ratio = Math.min(this.max, this.ratio + this.t.step);
      return this.ratio;
    }
    this.easyRun = 0;
    return null;
  }
}

/** A saved choice, or auto. */
export function parseQuality(v: string | null | undefined): QualityChoice {
  return (QUALITY_CHOICES as readonly string[]).includes(v ?? '') ? (v as QualityChoice) : 'auto';
}
