/**
 * L4.4A: WHEN THE PAGE SENDS ITS INPUT. Pure, so it is tested without a
 * browser or a socket.
 *
 * The page reads the keys and the stick every rendered frame, but sends at
 * most one input every `minIntervalMs` whatever the display's rate (a 240 Hz
 * screen once sent 240 a second, and the server, which keeps 120 a second
 * per connection, dropped the rest, presses and all). A message goes when
 * the movement changed, when a press waits, or as a keepalive; the movement
 * is quantized first, so the camera's floating-point noise (its yaw turns
 * the direction) is not a change. A press is latched until a message
 * carries it, and counted: every message carries the counts (`presses` in
 * the protocol), so a message the server drops loses no press. Presses are
 * taken only while the page plays a fighter; none wait to fire later.
 */
import type { Presses } from '../net/protocol';

export const INPUT_PACING = Object.freeze({
  /** At most one input this often, ms: ~83 a second at most, under the server's 120, at any display rate. */
  minIntervalMs: 12,
  /** Movement is resent at least this often, ms, so the server knows the keys are still held (it lets go after a second of silence). */
  keepaliveMs: 200,
  /** The movement's resolution: a direction is sent to this many parts in one. */
  quantum: 1000,
  /** While this many bytes wait in the socket (a stalled connection), nothing more is queued; presses keep their counts. */
  maxBacklog: 16 * 1024,
});

export interface Move {
  x: number;
  z: number;
  run: boolean;
}

export interface ActionFlags {
  jump: boolean;
  punch: boolean;
  grab: boolean;
}

/** A direction to the sending resolution (and never a negative zero). */
export function quantizeMove(m: Move, quantum = INPUT_PACING.quantum): Move {
  const q = (v: number) => Math.round(v * quantum) / quantum + 0;
  return { x: q(m.x), z: q(m.z), run: m.run };
}

const sameMove = (a: Move | null, b: Move) => !!a && a.x === b.x && a.z === b.z && a.run === b.run;

export class InputPacer {
  /** Presses not yet sent (latched: a tap shorter than a frame or a message is kept). */
  readonly pending: ActionFlags = { jump: false, punch: false, grab: false };
  private counts: [number, number, number] = [0, 0, 0];
  private sentMove: Move | null = null;
  private sentAt = -Infinity;

  constructor(private readonly t = INPUT_PACING) {}

  /** The press counts since the connection opened (they go in every message). */
  get presses(): Presses {
    return [this.counts[0], this.counts[1], this.counts[2]];
  }

  /** This frame's presses, while the page plays a fighter: latched and counted. */
  press(a: Partial<ActionFlags>) {
    if (a.jump) {
      this.pending.jump = true;
      this.counts[0] += 1;
    }
    if (a.punch) {
      this.pending.punch = true;
      this.counts[1] += 1;
    }
    if (a.grab) {
      this.pending.grab = true;
      this.counts[2] += 1;
    }
  }

  /** Not playing a fighter (connecting, watching, between connections): nothing latched may fire later. */
  drop() {
    this.pending.jump = this.pending.punch = this.pending.grab = false;
  }

  /** Whether `move` (quantized) or a press is something the server has not been sent yet. */
  unsent(move: Move): boolean {
    return !sameMove(this.sentMove, move) || this.pending.jump || this.pending.punch || this.pending.grab;
  }

  /** Whether to send now: something unsent (or the keepalive is due), no sooner than the interval, and the socket not backed up. */
  due(nowMs: number, move: Move, backlog = 0): boolean {
    if (backlog > this.t.maxBacklog) return false;
    if (nowMs - this.sentAt < this.t.minIntervalMs) return false;
    return this.unsent(move) || nowMs - this.sentAt >= this.t.keepaliveMs;
  }

  /** A message with `move` and the pending presses went out: they are no longer pending. */
  sent(nowMs: number, move: Move) {
    this.drop();
    this.sentMove = { ...move };
    this.sentAt = nowMs;
  }

  /** A new connection: counts from zero, nothing sent, nothing pending. */
  reset() {
    this.drop();
    this.counts = [0, 0, 0];
    this.sentMove = null;
    this.sentAt = -Infinity;
  }
}
