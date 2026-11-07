import type { PactInstanceRow, PactParticipantPlaceRow } from '../api/types';

/** Place changes apply to windows opening at least this long after they are saved. */
export const PLACE_CHANGE_LEAD_HOURS = 12;

/** The place in force at `at`: latest effective_from <= at, ties broken by newest created_at. */
export function effectivePlaceAt(
  places: readonly PactParticipantPlaceRow[],
  at: string,
): PactParticipantPlaceRow | null {
  const t = Date.parse(at);
  let best: PactParticipantPlaceRow | null = null;
  for (const p of places) {
    const from = Date.parse(p.effective_from);
    if (from > t) continue;
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
 * _place_at: the history row in force at window open; else the earliest history row; else the
 * participant row. pact_participants holds the newest saved place, which may not apply yet.
 */
export function placeForWindow(
  places: readonly PactParticipantPlaceRow[],
  windowOpenAt: string,
  participant: { place_label: string | null; place_radius_m: number } | null,
): WindowPlace | null {
  const inForce = effectivePlaceAt(places, windowOpenAt);
  const earliest = places.reduce<PactParticipantPlaceRow | null>(
    (a, p) => (a === null || Date.parse(p.effective_from) < Date.parse(a.effective_from) ? p : a),
    null,
  );
  const row = inForce ?? earliest;
  if (row) return { label: row.label, radiusM: row.radius_m };
  return participant ? { label: participant.place_label, radiusM: participant.place_radius_m } : null;
}
