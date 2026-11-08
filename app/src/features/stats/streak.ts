/**
 * Streak copy from `pact_streaks` (CONTRACT.md): consecutive days showed up; frozen days neither
 * break nor extend, a missed or unverified day breaks.
 */
import type { StreakRow } from './recap';

/** "3 in a row" / "3 in a row · Best 9" / "Best 9" (streak broken) / null when nothing to say. */
export function streakLine(current: number, best: number): string | null {
  if (current <= 0 && best <= 0) return null;
  if (current <= 0) return `Best ${best}`;
  const now = `${current} in a row`;
  return best > current ? `${now} · Best ${best}` : now;
}

/** Short value for a row's trailing slot: "3", with the best kept for the subtitle. */
export const streakValue = (current: number): string => (current > 0 ? `${current} in a row` : 'No streak');

/** Participants with the hottest streak first; ties by best, then by name. */
export function sortStreaks<T extends StreakRow>(rows: readonly T[], nameOf: (id: string) => string): T[] {
  return [...rows].sort(
    (a, b) => b.current_streak - a.current_streak || b.best_streak - a.best_streak || nameOf(a.user_id).localeCompare(nameOf(b.user_id)),
  );
}

/** The row for a participant, defaulting to zeros when the view has no row for them yet. */
export function streakFor(rows: readonly StreakRow[], userId: string): StreakRow {
  return rows.find((r) => r.user_id === userId) ?? { user_id: userId, current_streak: 0, best_streak: 0 };
}

/** VoiceOver: "Maya, 3 days in a row, best 9". */
export function streakAccessibilityLabel(name: string, current: number, best: number): string {
  const bits = [name];
  if (current > 0) bits.push(current === 1 ? '1 day in a row' : `${current} days in a row`);
  else bits.push('no current streak');
  if (best > current) bits.push(`best ${best}`);
  return bits.join(', ');
}
