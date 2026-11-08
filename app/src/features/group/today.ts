/**
 * Pure copy for the group home's Today cards and empty state. Tested; no React Native imports.
 */
import type { PactRow } from '../../api/types';
import type { InstanceSummary, MemberDayState } from '../../lib/instanceStatus';
import { describeDays, displayTimeOfDay, formatDateInZone, nextOccurrence } from '../../lib/time';
import { glossary } from '../../theme/tokens';
import { FINAL_CALL_MS } from '../checkin/copy';
import { goalLabel, type DistanceUnit } from '../goal/goal';

/** "2 of 4 checked in", "Everyone's in", "Nobody yet", with your own state folded in. */
export function todayStatusLine(summary: InstanceSummary, myState: MemberDayState | null): string {
  const { checkedIn, total } = summary;
  if (total === 0) return 'Nobody is in this one yet';
  const group = checkedIn === total ? "Everyone's in" : checkedIn === 0 ? 'Nobody yet' : `${checkedIn} of ${total} checked in`;
  if (myState === 'checked_in' || myState === 'success') {
    return checkedIn === total ? group : `You're in · ${checkedIn} of ${total}`;
  }
  return group;
}

const WORD: Partial<Record<MemberDayState, string>> = {
  success: 'showed up',
  checked_in: 'showed up',
  failed: 'missed',
  unverified: 'unverified',
  late: 'unverified',
  unjudged: 'unverified',
  frozen: 'frozen',
  void: "didn't count",
  excluded: 'excluded',
};

/** Compact results for a closed day: "2 showed up · 1 missed · 1 unverified". */
export function resultTally(summary: InstanceSummary): string {
  const counts = new Map<string, number>();
  for (const state of Object.values(summary.byUser)) {
    const word = WORD[state] ?? (state === 'out_of_fence' ? 'missed' : 'waiting');
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const order = ['showed up', 'missed', 'unverified', 'frozen', 'excluded', "didn't count", 'waiting'];
  return order
    .filter((w) => counts.has(w))
    .map((w) => `${counts.get(w)} ${w}`)
    .join(' · ');
}

/** Ids drawn with the tint ring on the avatar stack: whoever is in. */
export function checkedInIds(summary: InstanceSummary): string[] {
  return Object.entries(summary.byUser)
    .filter(([, s]) => s === 'checked_in' || s === 'success')
    .map(([id]) => id);
}

/** Your own pill on a card: only states worth a word (never Waiting; "in" is said by the status line). */
export function myPillState(myState: MemberDayState | null, closed: boolean): MemberDayState | null {
  if (!myState || myState === 'waiting') return null;
  if (!closed && myState === 'checked_in') return null;
  return myState;
}

/** The Today empty state body: the next scheduled day across the group's active pacts. */
export function nothingTodayBody(pacts: readonly PactRow[], nowMs: number): string {
  let best: { pact: PactRow; localDate: string; deadlineAt: number } | null = null;
  for (const pact of pacts) {
    if (pact.paused || pact.period !== 'daily') continue;
    const next = nextOccurrence(nowMs, pact.days_of_week ?? [], pact.deadline_local, pact.tz);
    if (next && (!best || next.deadlineAt < best.deadlineAt)) best = { pact, ...next };
  }
  if (!best) return 'Nothing scheduled this week.';
  const day = formatDateInZone(best.deadlineAt, best.pact.tz).split(',')[0];
  return `Next: ${best.pact.title}, ${day} by ${displayTimeOfDay(best.pact.deadline_local)}.`;
}

/**
 * The Today card's timing line in the airport voice (app/DESIGN.md "Voice"): "Boarding" while the
 * window is open, "Final call" for the last fifteen minutes, "Gate closed 9:00 AM" afterwards.
 */
export const openTimingPrefix = (remainingMs: number): 'Boarding' | 'Final call' => (remainingMs > 0 && remainingMs <= FINAL_CALL_MS ? 'Final call' : 'Boarding');
export const closedTimingText = (deadlineText: string): string => `Gate closed ${deadlineText}`;

/** Row detail under a pact: "Weekdays · by 9:00 AM · $5.00 pledge". */
export function pactDetailLine(days: string, deadlineLocal: string, pledge: string): string {
  return `${days} · by ${displayTimeOfDay(deadlineLocal)} · ${pledge} ${glossary.stake}`;
}

/** Row detail under a goal pact: "15.0 mi a week · $5.00 pledge", "10,000 steps a day · Weekdays · $1.00 pledge". */
export function goalDetailLine(pact: PactRow, unit: DistanceUnit, pledge: string): string {
  const days = pact.period === 'daily' ? describeDays(pact.days_of_week ?? []) : null;
  return [goalLabel(pact, unit), days, `${pledge} ${glossary.stake}`].filter(Boolean).join(' · ');
}
