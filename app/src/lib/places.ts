import type { PactInstanceRow, PactParticipantPlaceRow, PactPlaceVisibleRow, PlaceState } from '../api/types';

/** A changed place never counts sooner than this after it is saved (D11). */
export const PLACE_CHANGE_LEAD_HOURS = 12;
/** A changed place nobody confirms or objects to counts after this (N1-1). */
export const PLACE_ACK_TIMEOUT_HOURS = 24;
/** Any place can be objected to for this long after it is set (N1-1). */
export const PLACE_OBJECTION_HOURS = 24;

const HOUR = 3_600_000;

/** Was the row objected to by `atMs`? (An objection blocks the place from then on.) */
const objectedBy = (p: { objected_at: string | null }, atMs: number): boolean =>
  p.objected_at !== null && Date.parse(p.objected_at) <= atMs;

/**
 * The place in force at `at` (mirrors the server's _place_row_at): the latest effective_from <= at
 * that was not objected to by then, ties broken by newest created_at.
 */
export function effectivePlaceAt(
  places: readonly PactParticipantPlaceRow[],
  at: string,
): PactParticipantPlaceRow | null {
  const t = Date.parse(at);
  let best: PactParticipantPlaceRow | null = null;
  for (const p of places) {
    const from = Date.parse(p.effective_from);
    if (from > t || objectedBy(p, t)) continue;
    if (
      best === null ||
      from > Date.parse(best.effective_from) ||
      (from === Date.parse(best.effective_from) && Date.parse(p.created_at) > Date.parse(best.created_at))
    ) {
      best = p;
    }
  }
  return best;
}

/** Earliest non-voided instance whose window opens after now. */
export function nextWindow(instances: readonly PactInstanceRow[], nowMs: number): PactInstanceRow | null {
  let best: PactInstanceRow | null = null;
  for (const i of instances) {
    if (i.status === 'voided') continue;
    const open = Date.parse(i.window_open_at);
    if (open <= nowMs) continue;
    if (best === null || open < Date.parse(best.window_open_at)) best = i;
  }
  return best;
}

export interface WindowPlace {
  label: string | null;
  radiusM: number;
}

/**
 * The place a check-in for a window is judged against, with the same fallbacks as the server's
 * _place_at: the history row in force at window open; else the earliest ungated, unobjected row;
 * else (no history at all) the participant row. Null means no place in force: the person is not
 * on that window's roster. pact_participants holds the newest saved place, which may not apply yet.
 */
export function placeForWindow(
  places: readonly PactParticipantPlaceRow[],
  windowOpenAt: string,
  participant: { place_label: string | null; place_radius_m: number | null } | null,
): WindowPlace | null {
  // goal kinds join without a place (challenge kinds): nothing to judge against
  if (participant && participant.place_radius_m === null && places.length === 0) return null;
  const inForce = effectivePlaceAt(places, windowOpenAt);
  const earliest = places
    .filter((p) => !p.requires_ack && p.objected_at === null)
    .reduce<PactParticipantPlaceRow | null>(
      (a, p) => (a === null || Date.parse(p.effective_from) < Date.parse(a.effective_from) ? p : a),
      null,
    );
  const row = inForce ?? earliest;
  if (row) return { label: row.label, radiusM: row.radius_m };
  if (places.length > 0) return null;
  return participant && participant.place_radius_m !== null ? { label: participant.place_label, radiusM: participant.place_radius_m } : null;
}

/** Haversine metres, the same formula as the server's _haversine_m. Display only. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1) / 2;
  const dLng = rad(lng2 - lng1) / 2;
  const h = Math.sin(dLat) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "350 m" under a kilometre, "2.3 km" above (one decimal), "12 km" from ten. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Fields the `pact_places_visible` view derives; computed here for demo mode and tests. */
export interface DerivedPlaceState {
  is_current: boolean;
  state: PlaceState;
  acknowledgeable: boolean;
  objectable: boolean;
}

/** Mirrors the view's CASE for one row of a person's history (`places` = that person's rows). */
export function derivePlaceState(
  row: PactParticipantPlaceRow,
  places: readonly PactParticipantPlaceRow[],
  nowMs: number,
): DerivedPlaceState {
  const now = new Date(nowMs).toISOString();
  const current = effectivePlaceAt(places, now) ?? fallbackRow(places);
  const isCurrent = current !== null && current.id === row.id;
  const pending = Date.parse(row.effective_from) > nowMs;
  const state: PlaceState =
    row.objected_at !== null ? 'objected' : pending ? 'pending' : isCurrent ? 'effective' : 'superseded';
  return {
    is_current: isCurrent,
    state,
    acknowledgeable: row.requires_ack && row.acknowledged_at === null && row.objected_at === null && pending,
    objectable:
      row.objected_at === null &&
      row.acknowledged_at === null &&
      Date.parse(row.created_at) + PLACE_OBJECTION_HOURS * HOUR > nowMs &&
      (pending || isCurrent),
  };
}

function fallbackRow(places: readonly PactParticipantPlaceRow[]): PactParticipantPlaceRow | null {
  return places
    .filter((p) => !p.requires_ack && p.objected_at === null)
    .reduce<PactParticipantPlaceRow | null>(
      (a, p) => (a === null || Date.parse(p.effective_from) < Date.parse(a.effective_from) ? p : a),
      null,
    );
}

/** One person's place situation for the "Who's in" list, from the view rows. */
export interface MemberPlaces {
  userId: string;
  /** the place in force now (null: nothing counts for them until a new place is confirmed) */
  current: PactPlaceVisibleRow | null;
  /** a change that does not count yet */
  pending: PactPlaceVisibleRow | null;
  /** the latest place when it was objected to and nothing newer is pending */
  objected: PactPlaceVisibleRow | null;
}

export function memberPlaces(rows: readonly PactPlaceVisibleRow[], userId: string): MemberPlaces {
  const mine = rows.filter((r) => r.user_id === userId);
  const newest = (xs: PactPlaceVisibleRow[]) =>
    xs.reduce<PactPlaceVisibleRow | null>((a, r) => (a === null || Date.parse(r.created_at) > Date.parse(a.created_at) ? r : a), null);
  const current = mine.find((r) => r.is_current) ?? null;
  const pending = newest(mine.filter((r) => r.state === 'pending'));
  const latest = newest(mine);
  const objected = pending === null && latest?.state === 'objected' ? latest : null;
  return { userId, current, pending, objected };
}

/** Smallest distance from this place to any other person's place in force, in metres (null: nobody else). */
export function nearestOtherM(
  distances: readonly { place_id: string; distance_m: number }[],
  placeId: string,
): number | null {
  let best: number | null = null;
  for (const d of distances) {
    if (d.place_id !== placeId) continue;
    if (best === null || d.distance_m < best) best = d.distance_m;
  }
  return best;
}
