import { describe, expect, it } from 'vitest';
import { BlobbiAnimator } from '@blobbi-kit/3d';
import { presentationInput } from './fighterView';
import { createCombatState, startTumble, tickCombat } from '../combat/combat';
import { COMBAT } from '../tuning';

const moving = { dt: 1 / 60, speed: 1.4, grounded: true, verticalVelocity: 0, jumped: false, landed: false, impact: 0 };

describe('what the animator is told', () => {
  it('a held body is not walking, whatever its velocity', () => {
    const c = createCombatState();
    c.held = true;
    const input = presentationInput(c, moving);
    expect(input.speed).toBe(0);
    expect(input.grounded).toBe(true);
    const a = new BlobbiAnimator();
    for (let i = 0; i < 10; i++) a.update(input);
    expect(a.state).toBe('idle');
  });
  it('a tumbling body is falling, a recovering one is on the ground and still, a free one is the truth', () => {
    const c = createCombatState();
    startTumble(c);
    const t = presentationInput(c, moving);
    expect(t.grounded).toBe(false);
    expect(t.speed).toBe(0);
    const a = new BlobbiAnimator();
    for (let i = 0; i < 10; i++) a.update(t);
    expect(a.state).toBe('fall');
    tickCombat(c, COMBAT.tumbleDuration + 0.001);
    const r = presentationInput(c, moving);
    expect(r.grounded).toBe(true);
    expect(r.speed).toBe(0);
    tickCombat(c, COMBAT.recoveryDuration + 0.001);
    expect(presentationInput(c, moving)).toBe(moving);
  });
});
