import { describe, expect, it } from 'vitest';
import { attemptFromFix, captureAttempt, type FixLike } from './checkinAttempt';

const fix = (over: Partial<FixLike> = {}): FixLike => ({
  coords: { latitude: 47.6553, longitude: -122.3035, accuracy: 12 },
  timestamp: Date.parse('2026-11-09T16:58:30.000Z'),
  mocked: false,
  ...over,
});

const TAP = Date.parse('2026-11-09T16:58:00.000Z');

describe('attemptFromFix', () => {
  it('uses the tap time when the fix finished after the tap, never the send time', () => {
    const a = attemptFromFix('inst', fix(), TAP);
    expect(a).toEqual({
      instanceId: 'inst',
      lat: 47.6553,
      lng: -122.3035,
      accuracyM: 12,
      clientCapturedAt: '2026-11-09T16:58:00.000Z',
      isSimulated: false,
    });
  });

  it('keeps a tap just before the deadline on time even if the GPS fix finishes after it', () => {
    const tap = Date.parse('2026-11-09T16:59:50.000Z');
    const a = attemptFromFix('inst', fix({ timestamp: Date.parse('2026-11-09T17:00:05.000Z') }), tap);
    expect(a.clientCapturedAt).toBe('2026-11-09T16:59:50.000Z');
  });

  it('uses the fix time when the fix is older than the tap (a cached position)', () => {
    const a = attemptFromFix('inst', fix({ timestamp: Date.parse('2026-11-09T16:57:00.000Z') }), TAP);
    expect(a.clientCapturedAt).toBe('2026-11-09T16:57:00.000Z');
  });

  it('falls back to the tap time when the fix has no usable timestamp', () => {
    expect(attemptFromFix('inst', fix({ timestamp: Number.NaN }), TAP).clientCapturedAt).toBe(
      '2026-11-09T16:58:00.000Z',
    );
  });

  it('sends null accuracy when the OS reports none (server judges it unverified)', () => {
    const a = attemptFromFix('inst', fix({ coords: { latitude: 1, longitude: 2, accuracy: null } }), TAP);
    expect(a.accuracyM).toBeNull();
  });

  it('flags a mocked fix as simulated', () => {
    expect(attemptFromFix('inst', fix({ mocked: true }), TAP).isSimulated).toBe(true);
  });
});

describe('captureAttempt (fail-open)', () => {
  it('returns the located attempt when the fix succeeds', async () => {
    const r = await captureAttempt('inst', async () => fix(), TAP);
    expect(r.fixError).toBeNull();
    expect(r.attempt.lat).toBe(47.6553);
    expect(r.attempt.clientCapturedAt).toBe('2026-11-09T16:58:00.000Z');
  });

  it('still produces an attempt with null coordinates at the tap time when the fix fails', async () => {
    const r = await captureAttempt(
      'inst',
      async () => {
        throw new Error('Could not get a GPS fix in time.');
      },
      TAP,
    );
    expect(r.fixError).toBe('Could not get a GPS fix in time.');
    expect(r.attempt).toEqual({
      instanceId: 'inst',
      lat: null,
      lng: null,
      accuracyM: null,
      clientCapturedAt: '2026-11-09T16:58:00.000Z',
      isSimulated: false,
    });
  });

  it('treats a fix with non-finite coordinates as no fix', async () => {
    const r = await captureAttempt(
      'inst',
      async () => fix({ coords: { latitude: Number.NaN, longitude: 2, accuracy: 5 } }),
      TAP,
    );
    expect(r.attempt.lat).toBeNull();
    expect(r.attempt.lng).toBeNull();
    expect(r.fixError).not.toBeNull();
  });
});
