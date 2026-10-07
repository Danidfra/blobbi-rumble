/**
 * INPUT: keys to an INTENT, the one thing the controller reads. The
 * mapping is a pure function of the keys held and the camera's yaw, so it
 * is tested without a browser; the listener is the thin part.
 */
export interface MoveIntent {
  /** Unit (or zero) direction in the ground plane, world x and z. */
  x: number;
  z: number;
  run: boolean;
  /** A jump was asked for since the last read. */
  jump: boolean;
}

const FORWARD = new Set(['KeyW', 'ArrowUp']);
const BACK = new Set(['KeyS', 'ArrowDown']);
const RIGHT = new Set(['KeyD', 'ArrowRight']);
const LEFT = new Set(['KeyA', 'ArrowLeft']);
const RUN = new Set(['ShiftLeft', 'ShiftRight']);

/** Camera-relative intent: forward is away from the camera, right is the camera's right. */
export function moveIntent(keys: ReadonlySet<string>, cameraYaw: number, jump = false): MoveIntent {
  let x = 0;
  let z = 0;
  for (const k of keys) {
    if (FORWARD.has(k)) z += 1;
    if (BACK.has(k)) z -= 1;
    if (RIGHT.has(k)) x += 1;
    if (LEFT.has(k)) x -= 1;
  }
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  const c = Math.cos(cameraYaw);
  const s = Math.sin(cameraYaw);
  return { x: x * c + z * s, z: -x * s + z * c, run: [...keys].some((k) => RUN.has(k)), jump };
}

export class KeyboardInput {
  readonly keys = new Set<string>();
  private jumpQueued = false;
  enabled = true;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  /** The intent since the last read; the jump request is consumed. */
  read(cameraYaw: number): MoveIntent {
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    if (!this.enabled) return { x: 0, z: 0, run: false, jump: false };
    return moveIntent(this.keys, cameraYaw, jump);
  }
}
