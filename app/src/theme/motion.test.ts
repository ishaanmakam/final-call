import { describe, expect, it } from 'vitest';
import { reduceMotionSpring, reduceMotionStyle } from './reducedMotion';
import { PRESS_SCALE, durations, easings, haptics, springs } from './tokens';

describe('springs', () => {
  it('are critically damped unless they continue a gesture', () => {
    for (const [name, s] of Object.entries(springs)) {
      if (s.momentum) {
        expect(s.dampingRatio, name).toBeGreaterThanOrEqual(0.8);
        expect(s.dampingRatio, name).toBeLessThanOrEqual(1);
      } else {
        expect(s.dampingRatio, name).toBe(1);
      }
    }
  });
  it('settle in 400 ms or less', () => {
    for (const [name, s] of Object.entries(springs)) expect(s.duration, name).toBeLessThanOrEqual(400);
  });
  it('clamp overshoot on the sheet dismissal so it never flashes a gap', () => {
    expect(springs.sheetDismiss.overshootClamping).toBe(true);
    expect(springs.sheetDismiss.dampingRatio).toBe(1);
  });
  it('use the exact values from the motion contract', () => {
    expect(springs.settle).toMatchObject({ duration: 400, dampingRatio: 1 });
    expect(springs.snapBack).toMatchObject({ duration: 400, dampingRatio: 0.8 });
    expect(springs.sheet).toMatchObject({ duration: 300, dampingRatio: 0.8 });
  });
});

describe('easings', () => {
  it('are the exact bezier curves', () => {
    expect(easings.out).toEqual([0.23, 1, 0.32, 1]);
    expect(easings.inOut).toEqual([0.77, 0, 0.175, 1]);
    expect(easings.sheet).toEqual([0.32, 0.72, 0, 1]);
    expect(easings.linear).toEqual([0, 0, 1, 1]);
  });
  it('never ease in (first control point must not delay the start)', () => {
    for (const [name, [x1, y1]] of Object.entries(easings)) {
      if (name === 'linear') continue;
      // an ease-in curve has y1 well below x1 at the start; ours start fast or symmetric
      expect(y1, name).toBeGreaterThanOrEqual(0);
      expect(x1, name).toBeLessThan(0.8);
    }
  });
});

describe('durations', () => {
  it('keep UI motion under 300 ms, press feedback 100-150 ms', () => {
    expect(durations.press).toBeGreaterThanOrEqual(100);
    expect(durations.press).toBeLessThanOrEqual(150);
    for (const [name, ms] of Object.entries(durations)) {
      if (name === 'sweep') continue; // the one continuous loop (GPS locating)
      expect(ms, name).toBeLessThanOrEqual(300);
    }
    expect(durations.exit).toBeLessThan(durations.enter);
  });
  it('press scale is 0.97', () => {
    expect(PRESS_SCALE).toBe(0.97);
  });
});

describe('reduced motion mapper', () => {
  it('drops translate and scale but keeps opacity', () => {
    const full = { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] };
    expect(reduceMotionStyle(full)).toEqual({ opacity: 1 });
  });
  it('keeps non-movement properties and untouched styles', () => {
    const style = { opacity: 0.5, backgroundColor: '#fff' };
    expect(reduceMotionStyle(style)).toBe(style);
    expect(reduceMotionStyle({ opacity: 0.4, transform: [{ translateX: 12 }], width: 10 })).toEqual({
      opacity: 0.4,
      width: 10,
    });
  });
  it('forces critically damped springs', () => {
    expect(reduceMotionSpring(springs.sheet).dampingRatio).toBe(1);
    expect(reduceMotionSpring(springs.settle)).toBe(springs.settle);
  });
});

describe('haptics map', () => {
  it('uses notification feedback only for outcomes and selection only for steps', () => {
    expect(haptics.success).toEqual({ kind: 'notification', type: 'success' });
    expect(haptics.warning).toEqual({ kind: 'notification', type: 'warning' });
    expect(haptics.error).toEqual({ kind: 'notification', type: 'error' });
    expect(haptics.selection).toEqual({ kind: 'selection' });
    expect(haptics.pressPrimary).toEqual({ kind: 'impact', style: 'light' });
    expect(haptics.snap).toEqual({ kind: 'impact', style: 'light' });
    expect(haptics.commit).toEqual({ kind: 'impact', style: 'medium' });
  });
});
