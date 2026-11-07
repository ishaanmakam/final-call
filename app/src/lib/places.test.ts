import { describe, expect, it } from 'vitest';
import type { PactInstanceRow, PactParticipantPlaceRow } from '../api/types';
import { effectivePlaceAt, nextWindow, placeForWindow } from './places';

const place = (p: Partial<PactParticipantPlaceRow>): PactParticipantPlaceRow => ({
  pact_id: 'p',
  user_id: 'me',
  lat: 47.6,
  lng: -122.3,
  radius_m: 75,
  label: 'Gym',
  effective_from: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
  ...p,
});

describe('effectivePlaceAt', () => {
  it('returns null when there are no places', () => {
    expect(effectivePlaceAt([], '2026-11-08T16:00:00Z')).toBeNull();
  });

  it('picks the latest place effective at or before the instant', () => {
    const rows = [
      place({ label: 'Old', effective_from: '2026-11-01T00:00:00Z' }),
      place({ label: 'Current', effective_from: '2026-11-05T00:00:00Z' }),
      place({ label: 'Future', effective_from: '2026-11-09T04:00:00Z' }),
    ];
    expect(effectivePlaceAt(rows, '2026-11-08T16:00:00Z')?.label).toBe('Current');
    expect(effectivePlaceAt(rows, '2026-11-09T16:00:00Z')?.label).toBe('Future');
  });

  it('includes a place effective exactly at the instant', () => {
    const rows = [place({ label: 'Old' }), place({ label: 'Exact', effective_from: '2026-11-08T16:00:00Z' })];
    expect(effectivePlaceAt(rows, '2026-11-08T16:00:00Z')?.label).toBe('Exact');
  });

  it('returns null when every place starts later', () => {
    expect(effectivePlaceAt([place({ effective_from: '2026-12-01T00:00:00Z' })], '2026-11-08T16:00:00Z')).toBeNull();
  });

  it('breaks effective_from ties by the newest created_at', () => {
    const rows = [
      place({ label: 'First', created_at: '2026-11-02T00:00:00Z' }),
      place({ label: 'Second', created_at: '2026-11-03T00:00:00Z' }),
    ];
    expect(effectivePlaceAt(rows, '2026-11-08T00:00:00Z')?.label).toBe('Second');
    expect(effectivePlaceAt([...rows].reverse(), '2026-11-08T00:00:00Z')?.label).toBe('Second');
  });

  it('compares instants, not strings, across offsets', () => {
    const rows = [
      place({ label: 'A', effective_from: '2026-11-08T08:00:00-08:00' }), // 16:00Z
      place({ label: 'B', effective_from: '2026-11-08T15:00:00Z' }),
    ];
    expect(effectivePlaceAt(rows, '2026-11-08T16:00:00Z')?.label).toBe('A');
  });
});

const inst = (p: Partial<PactInstanceRow>): PactInstanceRow => ({
  id: 'i',
  pact_id: 'p',
  local_date: '2026-11-08',
  window_open_at: '2026-11-08T16:00:00Z',
  deadline_at: '2026-11-08T17:00:00Z',
  status: 'scheduled',
  carry_in_cents: null,
  closed_at: null,
  deadline_soon_sent_at: null,
  ...p,
});

describe('nextWindow', () => {
  const now = Date.parse('2026-11-08T16:30:00Z');

  it('returns the earliest instance whose window opens after now', () => {
    const rows = [
      inst({ id: 'later', window_open_at: '2026-11-10T16:00:00Z' }),
      inst({ id: 'open-now', window_open_at: '2026-11-08T16:00:00Z', status: 'open' }),
      inst({ id: 'next', window_open_at: '2026-11-09T16:00:00Z' }),
    ];
    expect(nextWindow(rows, now)?.id).toBe('next');
  });

  it('skips voided instances', () => {
    const rows = [
      inst({ id: 'void', window_open_at: '2026-11-09T16:00:00Z', status: 'voided' }),
      inst({ id: 'next', window_open_at: '2026-11-10T16:00:00Z' }),
    ];
    expect(nextWindow(rows, now)?.id).toBe('next');
  });

  it('returns null when nothing is upcoming', () => {
    expect(nextWindow([inst({})], now)).toBeNull();
  });
});

describe('placeForWindow (mirrors the server _place_at used to judge check-ins)', () => {
  const current = { place_label: 'New spot', place_radius_m: 300, place_lat: 1, place_lng: 2 };

  it('uses the history row in force at window open, not the newest saved place', () => {
    const old = place({ label: 'Kane Hall', radius_m: 50, effective_from: '2026-11-01T00:00:00Z' });
    const pending = place({ label: 'New spot', radius_m: 300, effective_from: '2026-11-09T04:00:00Z' });
    expect(placeForWindow([old, pending], '2026-11-08T16:00:00Z', current)).toEqual({
      label: 'Kane Hall',
      radiusM: 50,
    });
  });

  it('falls back to the earliest history row when none is in force yet', () => {
    const a = place({ label: 'First', radius_m: 60, effective_from: '2026-11-10T00:00:00Z' });
    const b = place({ label: 'Second', radius_m: 70, effective_from: '2026-11-12T00:00:00Z' });
    expect(placeForWindow([b, a], '2026-11-08T16:00:00Z', current)).toEqual({ label: 'First', radiusM: 60 });
  });

  it('falls back to the participant row when there is no history', () => {
    expect(placeForWindow([], '2026-11-08T16:00:00Z', current)).toEqual({ label: 'New spot', radiusM: 300 });
  });

  it('returns null for a non-participant and tolerates a null label', () => {
    expect(placeForWindow([], '2026-11-08T16:00:00Z', null)).toBeNull();
    expect(placeForWindow([place({ label: null, radius_m: 40 })], '2026-11-08T16:00:00Z', null)).toEqual({
      label: null,
      radiusM: 40,
    });
  });
});
