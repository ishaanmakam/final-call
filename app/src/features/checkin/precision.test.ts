import { describe, expect, it } from 'vitest';
import { isReducedAccuracy, maySendCheckin, precisionOutcome } from './precision';

describe('precisionOutcome', () => {
  it('a granted, precise permission is granted', () => {
    expect(precisionOutcome({ permission: 'granted', iosAccuracy: 'full' })).toBe('granted');
    expect(precisionOutcome({ permission: 'granted', androidAccuracy: 'fine' })).toBe('granted');
    // below iOS 14 / web / unknown: no accuracy field means precise
    expect(precisionOutcome({ permission: 'granted' })).toBe('granted');
    expect(precisionOutcome({ permission: 'granted', iosAccuracy: null, androidAccuracy: null })).toBe('granted');
  });

  it('iOS Approximate Location and Android coarse are approximate, never granted', () => {
    expect(precisionOutcome({ permission: 'granted', iosAccuracy: 'reduced' })).toBe('approximate');
    expect(precisionOutcome({ permission: 'granted', androidAccuracy: 'coarse' })).toBe('approximate');
    expect(isReducedAccuracy({ iosAccuracy: 'reduced' })).toBe(true);
    expect(isReducedAccuracy({ androidAccuracy: 'coarse' })).toBe(true);
  });

  it('no Android provider is not "approximate": the fix fails on its own (a tracking failure)', () => {
    expect(precisionOutcome({ permission: 'granted', androidAccuracy: 'none' })).toBe('granted');
  });

  it('permission problems come before precision', () => {
    expect(precisionOutcome({ permission: 'denied', iosAccuracy: 'reduced' })).toBe('denied');
    expect(precisionOutcome({ permission: 'blocked', iosAccuracy: 'reduced' })).toBe('blocked');
    expect(precisionOutcome({ permission: 'denied' })).toBe('denied');
  });

  it('only a granted, precise outcome may send a tap', () => {
    expect(maySendCheckin('granted')).toBe(true);
    expect(maySendCheckin('approximate')).toBe(false);
    expect(maySendCheckin('denied')).toBe(false);
    expect(maySendCheckin('blocked')).toBe(false);
  });
});
