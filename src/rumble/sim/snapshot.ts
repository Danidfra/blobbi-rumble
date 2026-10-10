/**
 * WHAT THE MATCH LOOKS LIKE FROM OUTSIDE: plain data, read-only by
 * convention, enough for a client (local now, remote later) to draw the
 * match and nothing it could act on. No Babylon object, body, function or
 * class instance: a snapshot survives `JSON.stringify` unchanged. Fighters
 * are named by their stable match-local ids, never by roster order.
 */
import type { ArenaId } from '../arena/arenas';
import type { PiecePhase } from '../arena/pieces';
import type { PlayerId } from './fighter';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FighterSnapshot {
  id: PlayerId;
  /** The capsule's centre, metres. */
  position: Vec3;
  /** The capsule's orientation (identity while upright; a real rotation while knocked down). */
  rotation: { x: number; y: number; z: number; w: number };
  /** Whether the capsule is locked upright. */
  upright: boolean;
  /** The facing in the ground plane, as a yaw: the direction (sin yaw, cos yaw). */
  yaw: number;
  velocity: Vec3;
  grounded: boolean;
  /** Still in the round; `eliminated` once its body has left play. */
  alive: boolean;
  eliminated: boolean;
  /** Rounds won. */
  score: number;
  powerLevel: number;
  /** The combat state a client shows: seconds, -1 for "not". */
  combat: {
    punchTime: number;
    punchCooldown: number;
    stun: number;
    tumble: number;
    recovering: number;
    /** Seconds into the current hold (as the holder), -1 when not holding. */
    holdTime: number;
    holdAngle: number;
    /** Escape progress while held, 0..1 (the server's: a client shows it, never decides it). */
    struggle: number;
    /** Seconds in which it cannot be grabbed again, after breaking free. */
    grabImmune: number;
  };
  /** Whom it holds, and who holds it. */
  holding: PlayerId | null;
  heldBy: PlayerId | null;
  /** The nearest fighter whose capsule it touches. */
  touching: PlayerId | null;
  /** The capsule's tilt from upright, radians. */
  tilt: number;
  /** The impact of the last blow or throw it received, m/s. */
  lastImpact: number;
  /** Blows, throws and sweeper hits received, and jumps made, over the match: compare two snapshots to see one happen. */
  hits: number;
  jumps: number;
  /** Holds it has struggled free of, over the match. */
  escapes: number;
}

export interface OrbSnapshot {
  x: number;
  y: number;
  z: number;
  active: boolean;
  /** Seconds until it returns, while taken. */
  timer: number;
}

export type MatchPhase = 'playing' | 'roundOver' | 'matchOver';

export interface MatchSnapshot {
  /** Simulation steps taken since the match was created, and the simulated seconds. */
  tick: number;
  time: number;
  /** The players, in roster order. */
  players: PlayerId[];
  fighters: FighterSnapshot[];
  phase: MatchPhase;
  round: number;
  /** Seconds left in the pause after a decided round. */
  roundTimer: number;
  /** Rounds to win the match. */
  target: number;
  /** Who took the last decided round (null: a draw, or none yet). */
  lastRoundWinner: PlayerId | null;
  matchWinner: PlayerId | null;
  orbs: OrbSnapshot[];
  /** The sweeper, where the arena has one. */
  sweeper: { angle: number; angularSpeed: number } | null;
  /** M11A: which arena (its definition is in the registry; nothing static is sent). */
  arena: ArenaId;
  /** M11B: the dynamic pieces, in the definition's order: their phase, seconds in it, and how far they have dropped. */
  pieces: { phase: PiecePhase; t: number; drop: number }[];
  /** Seconds since the round began. */
  roundTime: number;
}

/** Something the match decided this step, for clients to show (and tests to read). */
export interface MatchEvent {
  tick: number;
  t: number;
  round: number;
  kind: 'punch' | 'grab' | 'throw' | 'escape' | 'interrupt' | 'drop' | 'orb' | 'sweeper' | 'jump' | 'out' | 'round' | 'match' | 'newRound' | 'newMatch' | 'piece' | 'arena';
  /** A piece's index (for a `piece` event). */
  piece?: number;
  /** Who acted (or whom it happened to, for a sweeper hit, a ring-out, a won round); null for nobody (a draw) or the arena. */
  who: PlayerId | null;
  /** Whom it was done to. */
  on?: PlayerId;
  /** Which orb. */
  orb?: number;
  /** The reaction a blow, throw or sweeper hit caused. */
  reaction?: 'hit' | 'tumble';
  impact?: number;
  note?: string;
}
