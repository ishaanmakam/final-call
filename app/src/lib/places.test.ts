import { describe, expect, it } from 'vitest';
import type { PactInstanceRow, PactParticipantPlaceRow, PactPlaceVisibleRow } from '../api/types';
import {
  derivePlaceState,
  effectivePlaceAt,
  formatDistance,
  haversineM,
  memberPlaces,
  nearestOtherM,
  nextWindow,
  placeForWindow,
} from './places';

let seq = 0;
const place = (p: Partial<PactParticipantPlaceRow>): PactParticipantPlaceRow => ({
  id: `pl-${++seq}`,
  pact_id: 'p',
  user_id: 'me',
  lat: 47.6,
  lng: -122.3,
  radius_m: 75,
  label: 'Gym',
  effective_from: '2026-11-01T00:00:00Z',
  created_at: '2026-11-01T00:00:00Z',
  requires_ack: false,
  acknowledged_at: null,
  acknowledged_by: null,
  objected_at: null,
  objected_by: null,
  objection_reason: null,
  effective_event_at: null,
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

  it('an objected place stops counting from the objection on (windows that opened before still used it)', () => {
    const rows = [
      place({ label: 'First', effective_from: '2026-11-01T00:00:00Z', objected_at: '2026-11-08T12:00:00Z' }),
      place({ label: 'Blocked change', effective_from: '2026-11-09T00:00:00Z', requires_ack: true, objected_at: '2026-11-08T13:00:00Z' }),
    ];
    expect(effectivePlaceAt(rows, '2026-11-08T08:00:00Z')?.label).toBe('First');
    expect(effectivePlaceAt(rows, '2026-11-08T16:00:00Z')).toBeNull();
    expect(effectivePlaceAt(rows, '2026-11-10T16:00:00Z')).toBeNull();
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
    const pending = place({ label: 'New spot', radius_m: 300, effective_from: '2026-11-09T04:00:00Z', requires_ack: true });
    expect(placeForWindow([old, pending], '2026-11-08T16:00:00Z', current)).toEqual({
      label: 'Kane Hall',
      radiusM: 50,
    });
  });

  it('falls back to the earliest ungated, unobjected history row when none is in force yet', () => {
    const a = place({ label: 'First', radius_m: 60, effective_from: '2026-11-10T00:00:00Z' });
    const b = place({ label: 'Second', radius_m: 70, effective_from: '2026-11-12T00:00:00Z' });
    expect(placeForWindow([b, a], '2026-11-08T16:00:00Z', current)).toEqual({ label: 'First', radiusM: 60 });
    const gated = place({ label: 'Gated', radius_m: 80, effective_from: '2026-11-09T00:00:00Z', requires_ack: true });
    expect(placeForWindow([gated, a], '2026-11-08T16:00:00Z', current)).toEqual({ label: 'First', radiusM: 60 });
  });

  it('returns null when the first place was objected to and nothing newer counts: not on the roster', () => {
    const first = place({ label: 'Dorm', effective_from: '2026-11-01T00:00:00Z', objected_at: '2026-11-07T00:00:00Z' });
    const pending = place({ label: 'Hall', effective_from: '2026-11-09T00:00:00Z', requires_ack: true });
    expect(placeForWindow([first, pending], '2026-11-08T16:00:00Z', current)).toBeNull();
    expect(placeForWindow([first, pending], '2026-11-09T16:00:00Z', current)).toEqual({ label: 'Hall', radiusM: 75 });
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

describe('haversineM / formatDistance', () => {
  it('0.01 degrees of latitude is about 1.11 km; the same point is 0', () => {
    const d = haversineM(47.6553, -122.3035, 47.6653, -122.3035);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1125);
    expect(haversineM(47.6, -122.3, 47.6, -122.3)).toBe(0);
  });

  it('formats metres under a kilometre, one decimal up to ten km, whole km after', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(349.6)).toBe('350 m');
    expect(formatDistance(2310)).toBe('2.3 km');
    expect(formatDistance(12_400)).toBe('12 km');
    expect(formatDistance(Number.NaN)).toBe('');
  });
});

describe('derivePlaceState (mirrors the pact_places_visible view)', () => {
  const now = Date.parse('2026-11-08T16:00:00Z');

  it('a first place is effective, current and objectable for 24 hours', () => {
    const first = place({ created_at: '2026-11-08T10:00:00Z', effective_from: '2026-11-08T10:00:00Z' });
    expect(derivePlaceState(first, [first], now)).toEqual({ is_current: true, state: 'effective', acknowledgeable: false, objectable: true });
    const old = place({ created_at: '2026-11-01T10:00:00Z' });
    expect(derivePlaceState(old, [old], now).objectable).toBe(false);
  });

  it('a gated change is pending, confirmable and objectable; the old place stays current', () => {
    const old = place({ created_at: '2026-11-01T00:00:00Z' });
    const change = place({ created_at: '2026-11-08T14:00:00Z', effective_from: '2026-11-09T14:00:00Z', requires_ack: true });
    expect(derivePlaceState(change, [old, change], now)).toEqual({ is_current: false, state: 'pending', acknowledgeable: true, objectable: true });
    expect(derivePlaceState(old, [old, change], now)).toMatchObject({ is_current: true, state: 'effective' });
  });

  it('confirmed: no longer confirmable or objectable; objected: blocked; replaced: superseded', () => {
    const old = place({ created_at: '2026-11-01T00:00:00Z' });
    const acked = place({ created_at: '2026-11-08T14:00:00Z', effective_from: '2026-11-09T02:00:00Z', requires_ack: true, acknowledged_at: '2026-11-08T15:00:00Z', acknowledged_by: 'b' });
    expect(derivePlaceState(acked, [old, acked], now)).toEqual({ is_current: false, state: 'pending', acknowledgeable: false, objectable: false });
    const objected = place({ created_at: '2026-11-08T14:00:00Z', effective_from: '2026-11-09T14:00:00Z', requires_ack: true, objected_at: '2026-11-08T15:00:00Z', objected_by: 'b' });
    expect(derivePlaceState(objected, [old, objected], now).state).toBe('objected');
    const newer = place({ created_at: '2026-11-05T00:00:00Z', effective_from: '2026-11-06T00:00:00Z' });
    expect(derivePlaceState(old, [old, newer], now).state).toBe('superseded');
  });
});

describe('memberPlaces / nearestOtherM', () => {
  const vis = (p: Partial<PactPlaceVisibleRow>): PactPlaceVisibleRow => ({
    place_id: `v-${++seq}`,
    pact_id: 'p',
    group_id: 'g',
    user_id: 'u',
    user_name: 'U',
    lat: 0,
    lng: 0,
    radius_m: 50,
    label: 'L',
    created_at: '2026-11-01T00:00:00Z',
    effective_from: '2026-11-01T00:00:00Z',
    requires_ack: false,
    acknowledged_at: null,
    acknowledged_by: null,
    acknowledged_by_name: null,
    objected_at: null,
    objected_by: null,
    objected_by_name: null,
    objection_reason: null,
    is_current: false,
    state: 'superseded',
    acknowledgeable: false,
    objectable: false,
    ...p,
  });

  it('splits one person\'s rows into current, pending and objected', () => {
    const cur = vis({ label: 'Hall', is_current: true, state: 'effective' });
    const pend = vis({ label: 'Library', state: 'pending', created_at: '2026-11-08T00:00:00Z' });
    expect(memberPlaces([cur, pend, vis({ user_id: 'other', is_current: true, state: 'effective' })], 'u')).toMatchObject({
      current: { label: 'Hall' },
      pending: { label: 'Library' },
      objected: null,
    });
    const obj = vis({ label: 'Dorm', state: 'objected', created_at: '2026-11-08T00:00:00Z' });
    expect(memberPlaces([cur, obj], 'u')).toMatchObject({ current: { label: 'Hall' }, pending: null, objected: { label: 'Dorm' } });
    // an objected first place with nothing newer: nothing in force
    const first = vis({ label: 'Dorm', state: 'objected' });
    expect(memberPlaces([first], 'u')).toMatchObject({ current: null, pending: null, objected: { label: 'Dorm' } });
  });

  it('nearestOtherM takes the minimum distance for that place', () => {
    const d = [
      { place_id: 'a', distance_m: 2300 },
      { place_id: 'a', distance_m: 3100 },
      { place_id: 'b', distance_m: 100 },
    ];
    expect(nearestOtherM(d, 'a')).toBe(2300);
    expect(nearestOtherM(d, 'zzz')).toBeNull();
  });
});
