/**
 * M12.1: A CARRIED BODY DRAWN WITH ITS CARRIER. Online, your own fighter is
 * drawn where your prediction has it (now), while everyone else is drawn
 * from the server's states about a tenth of a second ago. A body you carry
 * is everyone else: drawn from the past while your hands are in the
 * present, so it trailed your fighter by its speed times that delay (and
 * swung out on a turn), as if barely attached. Drawn instead at the
 * server's own offset from you, taken from the same interpolated moment,
 * it stays in your hands. Presentation only: nothing here is sent, and the
 * hold, the struggle and the throw are the server's.
 */
import type { FighterSnapshot } from '../sim/snapshot';

/**
 * The fighters as drawn, the one `carrier` holds moved to keep the offset
 * it has from the carrier in `interp` (the same moment), relative to where
 * the carrier is drawn. Unchanged when the carrier holds nobody (in the
 * server's newest word) or the held body is not in the snapshot.
 */
export function attachCarried(drawn: readonly FighterSnapshot[], interp: readonly FighterSnapshot[], carrier: number, holding: string | null): FighterSnapshot[] {
  if (!holding) return [...drawn];
  const k = interp.findIndex((f) => f.id === holding);
  const c = interp[carrier];
  if (k < 0 || !c || k === carrier || interp[k].eliminated) return [...drawn];
  const me = drawn[carrier];
  const v = interp[k];
  const at = { x: me.position.x + (v.position.x - c.position.x), y: me.position.y + (v.position.y - c.position.y), z: me.position.z + (v.position.z - c.position.z) };
  return drawn.map((f, i) => (i === k ? { ...f, position: at } : f));
}
