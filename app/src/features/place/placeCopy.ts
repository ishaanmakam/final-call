/**
 * Copy for place accountability: the pending / objected pill, the "2.3 km from the others" line,
 * and the feed sentence for a place event. Rules it describes live in the database
 * (20261108000100_place_accountability.sql); this file only puts them in words.
 */
import type { PactPlaceVisibleRow, PlaceEventRow } from '../../api/types';
import type { PillTone } from '../../components/status';
import { formatDistance } from '../../lib/places';
import { formatDateInZone, formatTimeInZone } from '../../lib/time';

/** The rule shown before saving a place, in the picker and in the pact detail footer. */
export const PLACE_RULE_JOIN = 'Your friends see your place and how far it is from theirs. It counts right away; anyone can object within 24 hours.';
export const PLACE_RULE_CHANGE =
  'Your friends see your place. It counts once one of them confirms it, or after 24 hours if nobody objects.';
export const PLACE_RULE_CHANGE_MIN = 'A confirmed change never counts sooner than 12 hours after you save it.';

export interface Namer {
  userId: string;
  nameOf: (id: string) => string;
}

const his = (n: Namer, id: string) => (id === n.userId ? 'your' : `${n.nameOf(id)}'s`);
const subject = (n: Namer, id: string) => (id === n.userId ? 'You' : n.nameOf(id));

/** Pill for a person's row in "Who's in" (null: nothing worth a word). */
export function placePill(m: { pending: PactPlaceVisibleRow | null; objected: PactPlaceVisibleRow | null; current: PactPlaceVisibleRow | null }): {
  label: string;
  tone: PillTone;
} | null {
  if (m.pending) {
    return m.pending.acknowledged_at ? { label: 'Confirmed', tone: 'success' } : { label: 'Waiting for a friend to confirm', tone: 'unverified' };
  }
  if (m.objected) return { label: 'Objected', tone: 'excluded' };
  return null;
}

/** "Odegaard Library · 60 m · 2.3 km from the others" */
export function placeLine(place: PactPlaceVisibleRow | null, nearestM: number | null): string {
  if (!place) return 'No place counts right now';
  const parts = [place.label ?? 'Place set', `${place.radius_m} m`];
  if (nearestM !== null) parts.push(nearestM < 50 ? 'same spot as the others' : `${formatDistance(nearestM)} from the others`);
  return parts.join(' · ');
}

/**
 * The second line under a pending or objected place: what it is, when it counts, who objected.
 * tz: the pact's zone for the "counts from" time.
 */
export function placeStatusLine(
  m: { pending: PactPlaceVisibleRow | null; objected: PactPlaceVisibleRow | null },
  n: Namer,
  tz: string,
  nearestM: number | null,
): string | null {
  if (m.pending) {
    const p = m.pending;
    const where = [p.label ?? 'New place', nearestM !== null ? `${formatDistance(nearestM)} from the others` : null].filter(Boolean).join(' · ');
    const counts = `counts from ${formatDateInZone(p.effective_from, tz)} ${formatTimeInZone(p.effective_from, tz)}`;
    if (p.acknowledged_at) return `${where}. ${n.nameOf(p.acknowledged_by ?? '')} confirmed it; ${counts}.`;
    return `${where}. Until a friend confirms it, ${p.user_id === n.userId ? 'you are' : `${n.nameOf(p.user_id)} is`} judged against the old place; ${counts} if nobody objects.`;
  }
  if (m.objected) {
    const o = m.objected;
    const who = o.objected_by === n.userId ? 'You' : n.nameOf(o.objected_by ?? '');
    const reason = o.objection_reason ? ` “${o.objection_reason}”` : '';
    return `${who} objected to ${o.label ?? 'this place'}.${reason} ${o.user_id === n.userId ? 'Set a new place; a friend has to confirm it.' : `${n.nameOf(o.user_id)} has to set a new place.`}`;
  }
  return null;
}

/** "Maya moved her place for 9am in Kane Hall: Kane Hall → Odegaard Library (2.3 km away)." */
export function placeEventLine(e: PlaceEventRow, pactTitle: string, n: Namer): string {
  const label = e.label ?? 'a new place';
  const away = e.distance_from_prev_m !== null ? ` (${formatDistance(e.distance_from_prev_m)} away)` : '';
  switch (e.kind) {
    case 'created':
      if (e.prev_label !== null || e.distance_from_prev_m !== null) {
        return `${subject(n, e.user_id)} moved ${his(n, e.user_id) === 'your' ? 'your' : 'their'} place for ${pactTitle}: ${e.prev_label ?? 'old place'} → ${label}${away}.`;
      }
      return `${subject(n, e.user_id)} set ${his(n, e.user_id) === 'your' ? 'your' : 'their'} place for ${pactTitle}: ${label}.`;
    case 'acknowledged':
      return `${subject(n, e.actor_id)} confirmed ${his(n, e.user_id)} place for ${pactTitle}: ${label}.`;
    case 'objected':
      return `${subject(n, e.actor_id)} objected to ${his(n, e.user_id)} place for ${pactTitle}: ${label}.`;
    case 'effective':
      return `${his(n, e.user_id) === 'your' ? 'Your' : `${n.nameOf(e.user_id)}'s`} place for ${pactTitle} now counts: ${label}. Nobody objected in 24 hours.`;
  }
}

/** Footnote under a feed event that still waits: who can act. */
export function placeEventFootnote(e: PlaceEventRow, place: PactPlaceVisibleRow | undefined, n: Namer): string | null {
  if (e.kind !== 'created' || !place) return null;
  if (place.state === 'objected') return `Objected to${place.objected_by_name ? ` by ${place.objected_by_name}` : ''}. ${e.user_id === n.userId ? 'Set a new place.' : 'A new place is needed.'}`;
  if (place.state === 'pending' && place.acknowledged_at) return `Confirmed${place.acknowledged_by_name ? ` by ${place.acknowledged_by_name}` : ''}.`;
  if (place.state === 'pending') {
    return e.user_id === n.userId
      ? 'Counts once a friend confirms it, or after 24 hours if nobody objects.'
      : 'Confirm it if that is where they need to be. Object if it is not.';
  }
  return null;
}

export const OBJECTION_MIN_LENGTH = 3;
export const OBJECTION_MAX_LENGTH = 280;
export const OBJECTION_ERROR = 'Say why, in a few words.';

export function objectionSheetCopy(ownerName: string, label: string | null): { title: string; fieldLabel: string; placeholder: string; rule: string } {
  return {
    title: `Object to ${ownerName}'s place`,
    fieldLabel: 'Why',
    placeholder: `${label ?? 'This place'} is not where the pact happens…`,
    rule: `${ownerName} will see your name and reason. The place stops counting and ${ownerName} has to set a new one that a friend confirms.`,
  };
}
