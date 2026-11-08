/**
 * Settle-up completion: obligations confirmed on Venmo out of those created (`group_settlement_stats`).
 * The one number that says the group works. Copy says settle up / settle-up; never settlement or ledger.
 */
import { formatLocalDateShort } from '../../lib/time';

export interface CompletionStats {
  obligations_created: number;
  obligations_confirmed: number;
  /** confirmed / created, null until an obligation exists */
  completion_rate: number | string | null;
  weeks_settled: number;
  last_settled_week: string | null;
}

export const COMPLETION_FOOTNOTE =
  'Obligations confirmed on Venmo out of those created. This is the one number that says the group works.';

/** 0..100, rounded; null before any obligation. PostgREST may send numeric as a string. */
export function completionPercent(s: CompletionStats): number | null {
  if (s.obligations_created <= 0) return null;
  return Math.round((s.obligations_confirmed / s.obligations_created) * 100);
}

/** The big number: "90%" or an em dash before any settle-up. */
export function completionHeadline(s: CompletionStats): string {
  const pct = completionPercent(s);
  return pct === null ? '—' : `${pct}%`;
}

/**
 * "Settled up 9 of 10 times" / "Settled up 1 of 1" / "No settle-ups yet". The percentage is the big
 * figure next to it (`completionHeadline`), so the sentence does not repeat it (V-3).
 */
export function completionLine(s: CompletionStats): string {
  const pct = completionPercent(s);
  if (pct === null) return s.weeks_settled > 0 ? 'Nothing owed yet, so nothing to settle' : 'No settle-ups yet';
  const times = s.obligations_created === 1 ? '' : ' times';
  return `Settled up ${s.obligations_confirmed} of ${s.obligations_created}${times}`;
}

export type CompletionTone = 'success' | 'unverified' | 'forfeit' | 'pending';

/** 80 % and up is healthy, half and up needs a nudge, below is a group that is drifting. */
export function completionTone(s: CompletionStats): CompletionTone {
  const pct = completionPercent(s);
  if (pct === null) return 'pending';
  if (pct >= 80) return 'success';
  if (pct >= 50) return 'unverified';
  return 'forfeit';
}

/** "3 weeks settled · last Nov 2" / "1 week settled · Nov 2" / "No weeks settled yet". */
export function weeksLine(s: CompletionStats): string {
  if (s.weeks_settled <= 0 || !s.last_settled_week) return 'No weeks settled yet';
  const n = s.weeks_settled === 1 ? '1 week settled' : `${s.weeks_settled} weeks settled`;
  return `${n} · last week of ${formatLocalDateShort(s.last_settled_week)}`;
}

/** Open (not yet confirmed) count: created minus confirmed. */
export const openCount = (s: CompletionStats): number => Math.max(0, s.obligations_created - s.obligations_confirmed);
