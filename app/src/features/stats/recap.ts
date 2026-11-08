/**
 * Season recap sentences from `pact_season_recaps` and `pact_streaks` rows (CONTRACT.md). Copy says
 * showed up / missed / unverified / frozen and talks about coming out ahead or behind; never stake or pot.
 */
import { formatCents } from '../../lib/money';

export interface RecapRow {
  user_id: string;
  days: number;
  showed_up: number;
  missed: number;
  unverified: number;
  frozen: number;
  net_cents: number;
}

export interface StreakRow {
  user_id: string;
  current_streak: number;
  best_streak: number;
}

export interface LongestStreak {
  userId: string;
  name: string;
  streak: number;
}

/** First name for a compact row ("Maya" from "Maya Chen"); "You" stays "You". */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

const daysWord = (n: number): string => (n === 1 ? '1 day' : `${n} days`);

/** "+$12.50" / "-$3.00" / "even" */
export function netWord(cents: number): string {
  if (cents === 0) return 'even';
  return formatCents(cents, { signed: true });
}

/** In a sentence: "$12.50 ahead" / "$3.00 behind" / "even". */
export function standingWord(cents: number): string {
  if (cents === 0) return 'even';
  return `${formatCents(Math.abs(cents))} ${cents > 0 ? 'ahead' : 'behind'}`;
}

/**
 * Whose best streak is the longest (ties broken by name so the sentence is stable); null when nobody
 * has shown up twice in a row.
 */
export function longestStreak(streaks: readonly StreakRow[], nameOf: (id: string) => string): LongestStreak | null {
  let best: LongestStreak | null = null;
  for (const s of streaks) {
    if (s.best_streak < 2) continue;
    const cand = { userId: s.user_id, name: nameOf(s.user_id), streak: s.best_streak };
    if (!best || cand.streak > best.streak || (cand.streak === best.streak && cand.name.localeCompare(best.name) < 0)) best = cand;
  }
  return best;
}

/**
 * "You showed up 17 of 20 days and came out +$12.50. Maya had the longest streak: 14."
 * While the season runs: "So far you've shown up 6 of 8 days and are $2.50 ahead."
 */
export function recapSentence(mine: RecapRow | null, longest: LongestStreak | null, finished: boolean, userId: string): string {
  const parts: string[] = [];
  if (!mine || mine.days === 0) {
    parts.push(finished ? "You weren't in any of this season's days." : 'No closed days for you yet.');
  } else if (finished) {
    parts.push(`You showed up ${mine.showed_up} of ${daysWord(mine.days)} and came out ${netWord(mine.net_cents)}.`);
  } else {
    parts.push(`So far you've shown up ${mine.showed_up} of ${daysWord(mine.days)} and are ${standingWord(mine.net_cents)}.`);
  }
  if (longest) {
    const you = longest.userId === userId;
    const who = you ? 'You' : firstName(longest.name);
    const verb = finished ? 'had' : you ? 'have' : 'has';
    parts.push(`${who} ${verb} the longest streak: ${longest.streak}.`);
  }
  return parts.join(' ');
}

/** Row detail under a member: "17 of 20 days · 2 missed · 1 unverified · 1 frozen" (zero counts are left out). */
export function memberRecapLine(r: RecapRow): string {
  const bits = [`${r.showed_up} of ${daysWord(r.days)}`];
  if (r.missed > 0) bits.push(`${r.missed} missed`);
  if (r.unverified > 0) bits.push(`${r.unverified} unverified`);
  if (r.frozen > 0) bits.push(`${r.frozen} frozen`);
  return bits.join(' · ');
}

/** Members first by days shown up, then by net, then by name. */
export function sortRecaps<T extends RecapRow>(rows: readonly T[], nameOf: (id: string) => string): T[] {
  return [...rows].sort((a, b) => b.showed_up - a.showed_up || b.net_cents - a.net_cents || nameOf(a.user_id).localeCompare(nameOf(b.user_id)));
}

/**
 * The tone for a net amount: ahead is green, behind is the plain label colour (UB2: a negative
 * balance is neutral; red is only for Missed and destructive actions), even is secondary.
 */
export const netTone = (cents: number): 'success' | 'label' | 'secondary' => (cents > 0 ? 'success' : cents < 0 ? 'label' : 'secondary');
