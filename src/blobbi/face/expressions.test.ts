import { describe, expect, it } from 'vitest';
import { EMOTIONS, KEY_POSES, NEUTRAL_POSE, expressionOf, lidShape, normalizeWeights, resolveFacePose } from './expressions';

describe('expressions', () => {
  it('no weight is the neutral face; a full weight is the key pose', () => {
    expect(resolveFacePose({})).toBe(NEUTRAL_POSE);
    for (const e of EMOTIONS) expect(resolveFacePose(expressionOf(e))).toEqual(KEY_POSES[e]);
  });
  it('weights are clamped to a convex combination', () => {
    const w = normalizeWeights({ happy: 2, sad: 2, excited: -1 });
    expect(w.happy).toBeCloseTo(0.5);
    expect(w.sad).toBeCloseTo(0.5);
    expect(w.excited).toBe(0);
  });
  it('a half weight is half way', () => {
    const half = resolveFacePose({ happy: 0.5 });
    expect(half.mouth.low).toBeCloseTo((NEUTRAL_POSE.mouth.low + KEY_POSES.happy.mouth.low) / 2);
  });
  it('a lid closes continuously', () => {
    expect(lidShape(0)).toBeNull();
    expect(lidShape(0.5)!.chord).toBeCloseTo(-0.09);
    expect(lidShape(1)!.lower).toBe(1);
  });
});
