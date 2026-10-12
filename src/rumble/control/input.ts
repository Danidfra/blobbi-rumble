/**
 * INPUT: keys to an INTENT, the one thing a fighter reads. Two players
 * share one keyboard; each has its own bindings. The mapping is a pure
 * function of the keys held, the camera's yaw and the player's bindings,
 * so it is tested without a browser; `Keyboard` is the thin listener, and
 * `PlayerInput` is one player's view of it, with edge-triggered actions
 * (jump, punch, grab) that fire once per press.
 *
 * M12: a touch screen's stick and buttons (`touch.ts`) are a second
 * producer for the same player: `PlayerInput` merges them with the keys
 * into the one intent (the stick's direction, while a thumb is on it, in
 * place of the keys'; any press from either), turned camera-relative by
 * the same rotation. Nothing downstream knows where an intent came from.
 */
import { IDLE_INTENT, type PlayerIntent } from '../sim/intent';
import type { StickOutput } from './stick';
import type { TouchPad } from './touch';

export interface KeyBindings {
  forward: readonly string[];
  back: readonly string[];
  left: readonly string[];
  right: readonly string[];
  run: readonly string[];
  jump: readonly string[];
  punch: readonly string[];
  grab: readonly string[];
}

export const P1_BINDINGS: KeyBindings = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  run: ['ShiftLeft'],
  jump: ['Space'],
  punch: ['KeyF'],
  grab: ['KeyG'],
};

export const P2_BINDINGS: KeyBindings = {
  forward: ['ArrowUp'],
  back: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  run: ['ShiftRight'],
  jump: ['Enter'],
  punch: ['KeyK'],
  grab: ['KeyL'],
};

/** One player at the keyboard (network mode): either hand's keys. */
export const NET_BINDINGS: KeyBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space', 'Enter'],
  punch: ['KeyF', 'KeyK'],
  grab: ['KeyG', 'KeyL'],
};

/** What a fighter is asked to do: the match's transport-neutral intent. Keys are one producer of it. */
export type MoveIntent = PlayerIntent;

export interface Actions {
  jump?: boolean;
  punch?: boolean;
  grab?: boolean;
}

const any = (keys: ReadonlySet<string>, codes: readonly string[]) => codes.some((c) => keys.has(c));

/** A screen-relative direction (right, away from the camera) turned into the world's ground plane under a camera of yaw `cameraYaw`. */
export function cameraRelative(right: number, forward: number, cameraYaw: number): { x: number; z: number } {
  const c = Math.cos(cameraYaw);
  const s = Math.sin(cameraYaw);
  return { x: right * c + forward * s, z: -right * s + forward * c };
}

/**
 * Camera-relative intent: forward is away from the camera, right is the
 * camera's right. A `stick` with a thumb on it (non-zero) gives the
 * direction instead of the keys; either one's run counts.
 */
export function moveIntent(keys: ReadonlySet<string>, cameraYaw: number, bindings: KeyBindings, actions: Actions = {}, stick?: Pick<StickOutput, 'x' | 'y' | 'run'>): MoveIntent {
  let x = 0;
  let z = 0;
  if (stick && (stick.x !== 0 || stick.y !== 0)) {
    x = stick.x;
    z = stick.y;
  } else {
    if (any(keys, bindings.forward)) z += 1;
    if (any(keys, bindings.back)) z -= 1;
    if (any(keys, bindings.right)) x += 1;
    if (any(keys, bindings.left)) x -= 1;
  }
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  const w = cameraRelative(x, z, cameraYaw);
  return { x: w.x, z: w.z, run: any(keys, bindings.run) || !!stick?.run, jump: !!actions.jump, punch: !!actions.punch, grab: !!actions.grab };
}

/** The whole keyboard: what is held, and what was pressed since it was last taken. */
export class Keyboard {
  readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  /** Codes whose default (scrolling, form submission) must not happen while playing. */
  private readonly swallow: Set<string>;

  constructor(bindings: KeyBindings[], target: Window = window) {
    this.swallow = new Set(bindings.flatMap((b) => [...b.jump, ...b.punch, ...b.grab, ...b.forward, ...b.back, ...b.left, ...b.right]));
    target.addEventListener('keydown', (e) => {
      // A field, or an interface control the keyboard reached (L4.2), keeps its keys: Space presses a button, it does not jump.
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SUMMARY' || t?.isContentEditable) return;
      if (!e.repeat) this.pressed.add(e.code);
      this.held.add(e.code);
      if (this.swallow.has(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.held.delete(e.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  /** Whether any of `codes` was pressed since last taken; taking consumes it. */
  take(codes: readonly string[]): boolean {
    let hit = false;
    for (const c of codes) if (this.pressed.delete(c)) hit = true;
    return hit;
  }
}

/** Whatever drives a fighter: a person's keys or a test bot. A fighter reads one intent a frame from it. */
export interface IntentSource {
  enabled: boolean;
  read(cameraYaw: number): MoveIntent;
}

export class PlayerInput implements IntentSource {
  enabled = true;
  /** M12: this player's touch controls, if the screen has them (null: keys only). */
  touch: TouchPad | null = null;
  constructor(
    private readonly keyboard: Keyboard,
    readonly bindings: KeyBindings,
  ) {}

  /** The intent since the last read; presses are consumed even while disabled, so none queue up. */
  read(cameraYaw: number): MoveIntent {
    const t = this.touch;
    // Both producers' presses are taken every read (no short-circuit), so neither keeps a stale one.
    const jump = this.keyboard.take(this.bindings.jump);
    const punch = this.keyboard.take(this.bindings.punch);
    const grab = this.keyboard.take(this.bindings.grab);
    const actions = { jump: !!t?.take('jump') || jump, punch: !!t?.take('punch') || punch, grab: !!t?.take('grab') || grab };
    if (!this.enabled) return { ...IDLE_INTENT };
    return moveIntent(this.keyboard.held, cameraYaw, this.bindings, actions, t?.movement());
  }

  /** Let go of every key and finger at once (focus lost, a field took the keyboard, a modal opened). */
  release() {
    this.keyboard.held.clear();
    this.touch?.releaseAll();
  }
}

/**
 * A dev hook for scripted checks: whatever drives a fighter, with an intent
 * that may be set from outside in its place (`script`), its actions firing
 * once as a press does. Null leaves the fighter to its own driver.
 */
export class ScriptableInput implements IntentSource {
  script: MoveIntent | null = null;
  constructor(readonly base: IntentSource) {}
  get enabled() {
    return this.base.enabled;
  }
  set enabled(on: boolean) {
    this.base.enabled = on;
  }
  read(cameraYaw: number): MoveIntent {
    const own = this.base.read(cameraYaw);
    if (!this.script) return own;
    const out = this.enabled ? this.script : { ...IDLE_INTENT };
    this.script = { ...this.script, jump: false, punch: false, grab: false };
    return out;
  }
}
