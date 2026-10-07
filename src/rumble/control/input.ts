/**
 * INPUT: keys to an INTENT, the one thing a fighter reads. Two players
 * share one keyboard; each has its own bindings. The mapping is a pure
 * function of the keys held, the camera's yaw and the player's bindings,
 * so it is tested without a browser; `Keyboard` is the thin listener, and
 * `PlayerInput` is one player's view of it, with edge-triggered actions
 * (jump, punch, grab) that fire once per press.
 */
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

export interface MoveIntent {
  /** Unit (or zero) direction in the ground plane, world x and z. */
  x: number;
  z: number;
  run: boolean;
  jump: boolean;
  punch: boolean;
  grab: boolean;
}

export interface Actions {
  jump?: boolean;
  punch?: boolean;
  grab?: boolean;
}

const any = (keys: ReadonlySet<string>, codes: readonly string[]) => codes.some((c) => keys.has(c));

/** Camera-relative intent: forward is away from the camera, right is the camera's right. */
export function moveIntent(keys: ReadonlySet<string>, cameraYaw: number, bindings: KeyBindings, actions: Actions = {}): MoveIntent {
  let x = 0;
  let z = 0;
  if (any(keys, bindings.forward)) z += 1;
  if (any(keys, bindings.back)) z -= 1;
  if (any(keys, bindings.right)) x += 1;
  if (any(keys, bindings.left)) x -= 1;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  const c = Math.cos(cameraYaw);
  const s = Math.sin(cameraYaw);
  return { x: x * c + z * s, z: -x * s + z * c, run: any(keys, bindings.run), jump: !!actions.jump, punch: !!actions.punch, grab: !!actions.grab };
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
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
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

export class PlayerInput {
  enabled = true;
  constructor(
    private readonly keyboard: Keyboard,
    readonly bindings: KeyBindings,
  ) {}

  /** The intent since the last read; presses are consumed even while disabled, so none queue up. */
  read(cameraYaw: number): MoveIntent {
    const actions = { jump: this.keyboard.take(this.bindings.jump), punch: this.keyboard.take(this.bindings.punch), grab: this.keyboard.take(this.bindings.grab) };
    if (!this.enabled) return { x: 0, z: 0, run: false, jump: false, punch: false, grab: false };
    return moveIntent(this.keyboard.held, cameraYaw, this.bindings, actions);
  }
}
