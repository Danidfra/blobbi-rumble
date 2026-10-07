/**
 * FALLING AND RESPAWN: a body below the arena is fallen; after a short
 * wait it goes back to its spawn, at rest. Pure state; the sandbox applies
 * the teleport. No scoring: a counter, for the HUD.
 */
export interface FallState {
  fallen: boolean;
  /** Seconds left before the respawn, while fallen. */
  wait: number;
  falls: number;
}

export const initialFallState = (): FallState => ({ fallen: false, wait: 0, falls: 0 });

export interface FallRules {
  /** Below this height (metres) a body has fallen. */
  floorY: number;
  /** How long a fallen body waits before it respawns, seconds. */
  respawnDelay: number;
}

export const FALL_RULES: Readonly<FallRules> = Object.freeze({ floorY: -4, respawnDelay: 0.8 });

/** Advance the fall state by a frame. Returns true on the frame the body should be put back. */
export function updateFall(state: FallState, y: number, dt: number, rules: FallRules = FALL_RULES): boolean {
  if (!state.fallen) {
    if (y < rules.floorY) {
      state.fallen = true;
      state.wait = rules.respawnDelay;
      state.falls += 1;
    }
    return false;
  }
  state.wait -= dt;
  if (state.wait > 0) return false;
  state.fallen = false;
  state.wait = 0;
  return true;
}
