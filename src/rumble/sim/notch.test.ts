/**
 * The inside corners where a wing meets the centre slab (M7C, reported as
 * "bots stuck near the left side"): a fighter tumbled into one could come
 * to rest wedged on both slab edges, centre past each, its steering toward
 * safety holding it there. The ground rays under its footprint miss both
 * slabs, so it read as airborne: air control too weak to climb out, no jump.
 * Found in a 4-bot match (a punch tumbled P1 into the right wing's corner;
 * it hung until another bot threw it). Both left corners do the same. A
 * body at rest that the rays cannot see now counts as supported.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { beforeAll, expect, it } from 'vitest';
import { loadHavokNode } from './havokNode';
import { createRumbleMatch, type RumbleMatch } from './match';
import type { FighterSim } from './fighter';
import type { HavokInstance } from './physics';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

/** The match's own fighter: the wedge needs feet below the floor, which no hook or message can do (and none should). */
const fighterOf = (m: RumbleMatch, i: number) => (m as unknown as { fighters: FighterSim[] }).fighters[i];

for (const [x, z, name] of [
  [-4.27, 3.27, 'left wing, far corner'],
  [-4.27, -3.27, 'left wing, near corner'],
  [4.27, -3.27, 'right wing, near corner (where the 4-bot match hung)'],
] as const) {
  it(`a fighter wedged in the inside corner (${name}) climbs out by steering toward safety`, () => {
    const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }] });
    m.debugPlace('B', { x: 0, z: 0 });
    // The pose the hung fighter was found in: centre 0.27 m past both slab edges, 0.1 m below standing height.
    fighterOf(m, 0).body.teleport(new Vector3(x, -0.105, z));
    m.setInput('A', { x: -Math.sign(x) * 0.79, z: -Math.sign(z) * 0.61 });
    for (let k = 0; k < 120; k++) m.step(1 / 60);
    const f = m.snapshot().fighters[0];
    expect(f.eliminated).toBe(false);
    expect(f.grounded).toBe(true);
    expect(Math.abs(f.position.x)).toBeLessThan(3.9);
    expect(Math.abs(f.position.z)).toBeLessThan(2.9);
    m.dispose();
  });
}

it('a body over the void still falls: being still for a moment in the air is not support', () => {
  const m = createRumbleMatch({ havok, players: [{ id: 'A' }, { id: 'B' }] });
  m.debugPlace('A', { x: 0, z: 6 });
  m.setInput('A', { x: 0, z: -1 });
  for (let k = 0; k < 90; k++) m.step(1 / 60);
  expect(m.snapshot().fighters[0].eliminated).toBe(true);
  m.dispose();
});
