import { describe, expect, it } from 'vitest';
import { RADIUS_DETENTS, RADIUS_MAX, RADIUS_MIN, RADIUS_STEP, accuracyLine, isRoughFix, radiusLine, snapRadius } from './radius';

describe('radius copy', () => {
  it('pairs the number with a familiar size', () => {
    expect(radiusLine(75)).toBe('75 m · about a lecture hall');
    expect(radiusLine(25)).toBe('25 m · about a small room');
    expect(radiusLine(500)).toBe('500 m · about a whole campus');
  });

  it('has detents at the sizes people reach for', () => {
    expect(RADIUS_DETENTS).toEqual([25, 50, 75, 100, 150, 200, 300, 500]);
    expect(RADIUS_MIN).toBe(25);
    expect(RADIUS_MAX).toBe(500);
    expect(RADIUS_STEP).toBe(5);
  });

  it('snaps to the step and clamps to the range', () => {
    expect(snapRadius(77)).toBe(75);
    expect(snapRadius(78)).toBe(80);
    expect(snapRadius(3)).toBe(25);
    expect(snapRadius(900)).toBe(500);
  });
});

describe('fix accuracy copy', () => {
  it('never shows coordinates, only how tight the fix is', () => {
    expect(accuracyLine(11.6)).toBe('Accurate to about 12 m');
    expect(accuracyLine(null)).toBe('Saved earlier');
    expect(isRoughFix(51)).toBe(true);
    expect(isRoughFix(50)).toBe(false);
    expect(isRoughFix(null)).toBe(false);
  });
});
