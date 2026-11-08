import { describe, expect, it } from 'vitest';
import type { PactPlaceVisibleRow, PlaceEventRow } from '../../api/types';
import { objectionSheetCopy, placeEventFootnote, placeEventLine, placeLine, placePill, placeStatusLine, type Namer } from './placeCopy';

const names: Record<string, string> = { me: 'Sam', maya: 'Maya Chen', diego: 'Diego Alvarez' };
const n: Namer = { userId: 'me', nameOf: (id) => names[id] ?? 'Someone' };

let seq = 0;
const vis = (p: Partial<PactPlaceVisibleRow>): PactPlaceVisibleRow => ({
  place_id: `v-${++seq}`,
  pact_id: 'p',
  group_id: 'g',
  user_id: 'maya',
  user_name: 'Maya Chen',
  lat: 0,
  lng: 0,
  radius_m: 60,
  label: 'Odegaard Library',
  created_at: '2026-11-08T02:00:00Z',
  effective_from: '2026-11-09T02:00:00Z',
  requires_ack: true,
  acknowledged_at: null,
  acknowledged_by: null,
  acknowledged_by_name: null,
  objected_at: null,
  objected_by: null,
  objected_by_name: null,
  objection_reason: null,
  is_current: false,
  state: 'pending',
  acknowledgeable: true,
  objectable: true,
  ...p,
});

const ev = (p: Partial<PlaceEventRow>): PlaceEventRow => ({
  id: ++seq,
  group_id: 'g',
  pact_id: 'p',
  place_id: 'pl',
  user_id: 'maya',
  actor_id: 'maya',
  kind: 'created',
  label: 'Odegaard Library',
  lat: 0,
  lng: 0,
  radius_m: 60,
  prev_label: 'Kane Hall',
  prev_lat: 0,
  prev_lng: 0,
  prev_radius_m: 75,
  distance_from_prev_m: 2310,
  reason: null,
  created_at: '2026-11-08T02:00:00Z',
  ...p,
});

describe('placePill', () => {
  it('pending, confirmed, objected, nothing', () => {
    expect(placePill({ pending: vis({}), objected: null, current: null })).toEqual({ label: 'Waiting for a friend to confirm', tone: 'unverified' });
    expect(placePill({ pending: vis({ acknowledged_at: '2026-11-08T03:00:00Z' }), objected: null, current: null })).toEqual({ label: 'Confirmed', tone: 'success' });
    expect(placePill({ pending: null, objected: vis({ state: 'objected' }), current: null })).toEqual({ label: 'Objected', tone: 'excluded' });
    expect(placePill({ pending: null, objected: null, current: vis({ state: 'effective', is_current: true }) })).toBeNull();
  });
});

describe('placeLine', () => {
  it('label, radius and distance from the others', () => {
    expect(placeLine(vis({ label: 'Kane Hall', radius_m: 75 }), 2310)).toBe('Kane Hall · 75 m · 2.3 km from the others');
    expect(placeLine(vis({ label: 'Kane Hall', radius_m: 75 }), 12)).toBe('Kane Hall · 75 m · same spot as the others');
    expect(placeLine(vis({ label: null }), null)).toBe('Place set · 60 m');
    expect(placeLine(null, null)).toBe('No place counts right now');
  });
});

describe('placeStatusLine', () => {
  it('pending: where, who is judged against what, when it counts', () => {
    const s = placeStatusLine({ pending: vis({}), objected: null }, n, 'UTC', 2310)!;
    expect(s).toContain('Odegaard Library · 2.3 km from the others');
    expect(s).toContain('Maya Chen is judged against the old place');
    expect(s).toContain('if nobody objects');
    const mine = placeStatusLine({ pending: vis({ user_id: 'me' }), objected: null }, n, 'UTC', null)!;
    expect(mine).toContain('you are judged against the old place');
  });

  it('confirmed pending: names the confirmer', () => {
    const s = placeStatusLine({ pending: vis({ acknowledged_at: '2026-11-08T03:00:00Z', acknowledged_by: 'diego' }), objected: null }, n, 'UTC', null)!;
    expect(s).toContain('Diego Alvarez confirmed it; counts from');
  });

  it('objected: who, the reason, what happens next', () => {
    const s = placeStatusLine({ pending: null, objected: vis({ state: 'objected', objected_by: 'me', objection_reason: 'That is a dorm' }) }, n, 'UTC', null)!;
    expect(s).toBe('You objected to Odegaard Library. “That is a dorm” Maya Chen has to set a new place.');
    const theirs = placeStatusLine({ pending: null, objected: vis({ state: 'objected', user_id: 'me', objected_by: 'diego' }) }, n, 'UTC', null)!;
    expect(theirs).toBe('Diego Alvarez objected to Odegaard Library. Set a new place; a friend has to confirm it.');
    expect(placeStatusLine({ pending: null, objected: null }, n, 'UTC', null)).toBeNull();
  });
});

describe('placeEventLine', () => {
  it('moved / set / confirmed / objected / now counts', () => {
    expect(placeEventLine(ev({}), '9am in Kane Hall', n)).toBe('Maya Chen moved their place for 9am in Kane Hall: Kane Hall → Odegaard Library (2.3 km away).');
    expect(placeEventLine(ev({ prev_label: null, distance_from_prev_m: null }), '9am in Kane Hall', n)).toBe('Maya Chen set their place for 9am in Kane Hall: Odegaard Library.');
    expect(placeEventLine(ev({ user_id: 'me', prev_label: null, distance_from_prev_m: null }), 'Gym', n)).toBe('You set your place for Gym: Odegaard Library.');
    expect(placeEventLine(ev({ kind: 'acknowledged', actor_id: 'me' }), 'Gym', n)).toBe("You confirmed Maya Chen's place for Gym: Odegaard Library.");
    expect(placeEventLine(ev({ kind: 'objected', actor_id: 'diego', user_id: 'me' }), 'Gym', n)).toBe('Diego Alvarez objected to your place for Gym: Odegaard Library.');
    expect(placeEventLine(ev({ kind: 'effective' }), 'Gym', n)).toBe("Maya Chen's place for Gym now counts: Odegaard Library. Nobody objected in 24 hours.");
    expect(placeEventLine(ev({ kind: 'effective', user_id: 'me' }), 'Gym', n)).toBe('Your place for Gym now counts: Odegaard Library. Nobody objected in 24 hours.');
  });
});

describe('placeEventFootnote', () => {
  it('only a created event that still waits gets a footnote', () => {
    expect(placeEventFootnote(ev({}), vis({}), n)).toBe('Confirm it if that is where they need to be. Object if it is not.');
    expect(placeEventFootnote(ev({ user_id: 'me' }), vis({ user_id: 'me' }), n)).toBe('Counts once a friend confirms it, or after 24 hours if nobody objects.');
    expect(placeEventFootnote(ev({}), vis({ state: 'objected', objected_by_name: 'Priya Nair' }), n)).toBe('Objected to by Priya Nair. A new place is needed.');
    expect(placeEventFootnote(ev({}), vis({ acknowledged_at: 'x', acknowledged_by_name: 'Diego Alvarez' }), n)).toBe('Confirmed by Diego Alvarez.');
    expect(placeEventFootnote(ev({}), vis({ state: 'effective', is_current: true }), n)).toBeNull();
    expect(placeEventFootnote(ev({ kind: 'objected' }), vis({}), n)).toBeNull();
    expect(placeEventFootnote(ev({}), undefined, n)).toBeNull();
  });
});

describe('objectionSheetCopy', () => {
  it('names the owner and says what happens', () => {
    const c = objectionSheetCopy('Maya', 'Odegaard Library');
    expect(c.title).toBe("Object to Maya's place");
    expect(c.placeholder).toContain('Odegaard Library');
    expect(c.rule).toContain('Maya will see your name and reason');
  });
});
