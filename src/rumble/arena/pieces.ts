/**
 * DYNAMIC PIECES (M11B): the platforms that change during a round, as a
 * pure, deterministic state machine the server runs and everyone else
 * only reads:
 *
 *   stable ──armed──► warning ──warn s──► falling ──fall s──► gone ──back s──► stable
 *
 * A FALLING pad is armed by weight: seconds accumulate while any fighter
 * stands on it (and drain while nobody does), and at `arm` it starts to
 * warn. A BREAKABLE bridge is armed by heavy impacts on bodies over it
 * (`impacts` of them) or by the round's clock (`after`), whichever first.
 * Warning is the telegraph: the piece still holds (the view shakes it);
 * falling drops it over `fall` seconds (the collider goes down with it,
 * then is gone); gone is a hole until `back` (0: the rest of the round).
 * A round reset puts every piece back.
 *
 * `drop(piece)` is how far below its rest the piece is, for the collider
 * and the view: 0 while stable or warning, growing through the fall, and
 * "away" when gone.
 */
import type { Dynamic, PieceRule } from './arenas';

export type PiecePhase = 'stable' | 'warning' | 'falling' | 'gone';

export interface PieceState {
  phase: PiecePhase;
  /** Seconds in the phase. */
  t: number;
  /** Falling pads: weight accumulated toward arming, seconds. Breakable: heavy impacts taken. */
  load: number;
}

/** How far a falling piece has dropped at this point of its fall, metres: eased, ending `FALL_DEPTH` below. */
export const FALL_DEPTH = 6;

export const createPieces = (dynamics: readonly Dynamic[]): PieceState[] => dynamics.map(() => ({ phase: 'stable', t: 0, load: 0 }));

export function resetPieces(pieces: PieceState[]) {
  for (const p of pieces) {
    p.phase = 'stable';
    p.t = 0;
    p.load = 0;
  }
}

/** Whether a piece still carries weight (its collider is in place): stable or warning. */
export const pieceSolid = (p: PieceState) => p.phase === 'stable' || p.phase === 'warning';

/** How far below rest the piece is now. */
export function drop(p: PieceState, rule: PieceRule): number {
  if (p.phase === 'falling') {
    const u = Math.min(1, p.t / Math.max(1e-6, rule.fall));
    return FALL_DEPTH * u * u;
  }
  return p.phase === 'gone' ? FALL_DEPTH : 0;
}

/** A heavy impact landed on a body over this piece (breakable pieces count them). */
export function pieceImpact(p: PieceState, rule: PieceRule) {
  if (rule.kind !== 'breakable' || p.phase !== 'stable') return;
  p.load += 1;
}

/**
 * Advance one piece by `dt`. `loaded`: whether a fighter stands on it this
 * step. `roundTime`: seconds since the round began. Returns the phase it
 * entered this step, if it changed (for an event).
 */
export function tickPiece(p: PieceState, rule: PieceRule, dt: number, loaded: boolean, roundTime: number): PiecePhase | null {
  p.t += dt;
  switch (p.phase) {
    case 'stable': {
      let armed = false;
      if (rule.kind === 'falling') {
        p.load = loaded ? p.load + dt : Math.max(0, p.load - dt * 0.5);
        armed = p.load >= rule.arm;
      } else armed = p.load >= rule.impacts || roundTime >= rule.after;
      if (!armed) return null;
      p.phase = 'warning';
      p.t = 0;
      return 'warning';
    }
    case 'warning':
      if (p.t < rule.warn) return null;
      p.phase = 'falling';
      p.t = 0;
      return 'falling';
    case 'falling':
      if (p.t < rule.fall) return null;
      p.phase = 'gone';
      p.t = 0;
      return 'gone';
    case 'gone':
      if (rule.back <= 0 || p.t < rule.back) return null;
      p.phase = 'stable';
      p.t = 0;
      p.load = 0;
      return 'stable';
  }
}
