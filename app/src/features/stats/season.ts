/**
 * Seasons: an optional run of N weeks on a pact (`pacts.season_start`, `pacts.season_weeks`). Pure
 * date arithmetic on 'YYYY-MM-DD' local dates (the pact's zone), so a week is always 7 local days
 * and a DST change never shifts the finish line. No React Native imports; tested.
 */
import { addDaysToLocalDate, isoWeekday } from '../../lib/time';

export interface Season {
  /** first local date of the season */
  start: string;
  /** 1..12 */
  weeks: number;
}

/** Weeks a season may run (CONTRACT.md: `season_weeks between 1 and 12`); 4 is the product default. */
export const DEFAULT_SEASON_WEEKS = 4;
export const SEASON_WEEK_OPTIONS: readonly number[] = [2, 4, 8];

export function seasonOf(pact: { season_start?: string | null; season_weeks?: number | null }): Season | null {
  if (!pact.season_start || !pact.season_weeks) return null;
  return { start: pact.season_start, weeks: pact.season_weeks };
}

/** The last local date of the season (inclusive): start + 7 × weeks − 1. */
export const seasonEnd = (s: Season): string => addDaysToLocalDate(s.start, s.weeks * 7 - 1);

const DAY = 86_400_000;
const utcMs = (localDate: string): number => {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** Whole days from `a` to `b` ('2030-01-07' → '2030-01-13' is 6). */
export const daysBetween = (a: string, b: string): number => Math.round((utcMs(b) - utcMs(a)) / DAY);

export type SeasonPhase = 'upcoming' | 'running' | 'finished';

export interface SeasonProgress {
  phase: SeasonPhase;
  /** 1-based week of the season today is in; 0 before the start, `weeks` after the end */
  week: number;
  weeks: number;
  /** local days after today up to and including the finish line (0 on the last day) */
  daysLeft: number;
  /** 0..1 of the season's days that are behind us (today excluded) */
  fraction: number;
  /** the last local date, for "finish line Sun, Dec 6" */
  finishLine: string;
}

export function seasonProgress(s: Season, today: string): SeasonProgress {
  const end = seasonEnd(s);
  const total = s.weeks * 7;
  const elapsed = daysBetween(s.start, today);
  if (elapsed < 0) return { phase: 'upcoming', week: 0, weeks: s.weeks, daysLeft: total, fraction: 0, finishLine: end };
  if (elapsed >= total) return { phase: 'finished', week: s.weeks, weeks: s.weeks, daysLeft: 0, fraction: 1, finishLine: end };
  return {
    phase: 'running',
    week: Math.floor(elapsed / 7) + 1,
    weeks: s.weeks,
    daysLeft: daysBetween(today, end),
    fraction: elapsed / total,
    finishLine: end,
  };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Sun, Dec 6' for a local date (no zone involved: it is already a calendar day). */
export function formatLocalDay(localDate: string): string {
  const d = new Date(utcMs(localDate));
  return `${WEEKDAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const weeksWord = (n: number): string => (n === 1 ? '1 week' : `${n} weeks`);

/** "Week 2 of 4 · 6 days left · finish line Sun, Dec 6" (and the before / after forms). */
export function seasonProgressLine(p: SeasonProgress, start?: string): string {
  if (p.phase === 'upcoming') return `${weeksWord(p.weeks)}${start ? ` from ${formatLocalDay(start)}` : ''} · finish line ${formatLocalDay(p.finishLine)}`;
  if (p.phase === 'finished') return `Finished ${formatLocalDay(p.finishLine)} · ${weeksWord(p.weeks)}`;
  const left = p.daysLeft === 0 ? 'last day' : p.daysLeft === 1 ? '1 day left' : `${p.daysLeft} days left`;
  return `Week ${p.week} of ${p.weeks} · ${left} · finish line ${formatLocalDay(p.finishLine)}`;
}

/** The rest of the line under a `seasonShortLabel` title: "6 days left · finish line Sun, Dec 6", "4 weeks · finish line …", "Sun, Dec 6 · 4 weeks". */
export function seasonDetailLine(p: SeasonProgress): string {
  if (p.phase === 'upcoming') return `${weeksWord(p.weeks)} · finish line ${formatLocalDay(p.finishLine)}`;
  if (p.phase === 'finished') return `${formatLocalDay(p.finishLine)} · ${weeksWord(p.weeks)}`;
  const left = p.daysLeft === 0 ? 'last day' : p.daysLeft === 1 ? '1 day left' : `${p.daysLeft} days left`;
  return `${left} · finish line ${formatLocalDay(p.finishLine)}`;
}

/** Short form for a pill or a row value: "Week 2 of 4", "Starts Mon, Nov 9", "Finished". */
export function seasonShortLabel(p: SeasonProgress, start: string): string {
  if (p.phase === 'upcoming') return `Starts ${formatLocalDay(start)}`;
  if (p.phase === 'finished') return 'Finished';
  return `Week ${p.week} of ${p.weeks}`;
}

/** The coming Monday as a local date; today when today is a Monday (a season can start the day it is set). */
export function nextMonday(today: string): string {
  const dow = isoWeekday(today);
  return dow === 1 ? today : addDaysToLocalDate(today, 8 - dow);
}

/** "4-week season from Mon, Nov 9 to Sun, Dec 6", for the wizard summary and the confirm sheet. */
export function seasonSummary(s: Season): string {
  return `${s.weeks}-week season from ${formatLocalDay(s.start)} to ${formatLocalDay(seasonEnd(s))}`;
}
