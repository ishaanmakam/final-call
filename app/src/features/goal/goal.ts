/**
 * Pure copy and arithmetic for goal kinds (distance, workouts, steps, custom): units, the
 * progress headline, standings lines, activity rows. No React Native imports; tested in goal.test.ts.
 * Money never appears here: the ledger words a result, this module words the evidence.
 */
import { toNumber, type ActivitySource, type InstanceStandingRow, type PactKind, type PactRow, type PactActivityRow } from '../../api/types';
import { formatLocalDateShort } from '../../lib/time';

export type DistanceUnit = 'mi' | 'km';

export const METERS_PER_MILE = 1609.344;

/** Miles where the locale's region measures roads in miles (US, UK, Liberia, Myanmar); kilometres elsewhere. */
export function distanceUnitForLocale(locale: string | undefined): DistanceUnit {
  const region = (locale ?? '').split(/[-_]/)[1]?.toUpperCase();
  return region === 'US' || region === 'GB' || region === 'LR' || region === 'MM' ? 'mi' : 'km';
}

export const metersToUnit = (m: number, unit: DistanceUnit): number => (unit === 'mi' ? m / METERS_PER_MILE : m / 1000);

/** Whole metres: what `pacts.goal_value` and `activities.distance_m` store. */
export const unitToMeters = (value: number, unit: DistanceUnit): number => Math.round(unit === 'mi' ? value * METERS_PER_MILE : value * 1000);

const one = (n: number): string => n.toFixed(1);
const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

export const formatDistance = (m: number, unit: DistanceUnit): string => `${one(metersToUnit(m, unit))} ${unit}`;

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "8:42 /mi"; null when there is no distance or no time. */
export function paceText(distanceM: number | null, durationS: number, unit: DistanceUnit): string | null {
  if (!distanceM || distanceM <= 0 || durationS <= 0) return null;
  const perUnit = durationS / metersToUnit(distanceM, unit);
  const m = Math.floor(perUnit / 60);
  const s = Math.round(perUnit % 60);
  return `${m}:${String(s).padStart(2, '0')} /${unit}`;
}

export const isGoalKind = (kind: PactKind): boolean => kind !== 'show_up';

/** The pact's goal as a number (PostgREST may send numeric as a string). 0 for show_up. */
export const goalValue = (pact: Pick<PactRow, 'goal_value'>): number => toNumber(pact.goal_value);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "15.0 mi a week", "3 workouts a week", "10,000 steps a day", "Done every day". */
export function goalLabel(pact: Pick<PactRow, 'kind' | 'period' | 'goal_value' | 'race_start' | 'race_end'>, unit: DistanceUnit): string {
  const goal = goalValue(pact);
  const period = pact.period === 'weekly' ? 'a week' : 'a day';
  switch (pact.kind) {
    case 'distance':
      if (pact.period === 'once' && pact.race_end) return `${one(metersToUnit(goal, unit))} ${unit} by ${formatLocalDateShort(pact.race_end)}`;
      return `${one(metersToUnit(goal, unit))} ${unit} ${period}`;
    case 'workouts':
      return `${plural(goal, 'workout')} ${period}`;
    case 'steps':
      return `${thousands(goal)} steps ${period}`;
    case 'custom':
      return pact.period === 'weekly' ? 'Done every week' : 'Done every day';
    default:
      return '';
  }
}

/** "11.2 / 15.0 mi", "2 / 3 workouts", "7,500 / 10,000 steps", "Done". */
export function formatGoalValue(pact: Pick<PactRow, 'kind' | 'goal_value'>, value: number, unit: DistanceUnit): string {
  const goal = goalValue(pact);
  switch (pact.kind) {
    case 'distance':
      return `${one(metersToUnit(value, unit))} / ${one(metersToUnit(goal, unit))} ${unit}`;
    case 'workouts':
      return `${Math.round(value)} / ${plural(goal, 'workout')}`;
    case 'steps':
      return `${thousands(value)} / ${thousands(goal)} steps`;
    case 'custom':
      return value >= 1 ? 'Done' : 'Not marked yet';
    default:
      return '';
  }
}

/** The value alone, with its unit: "16.5 mi", "5", "7,500". */
export function formatValue(pact: Pick<PactRow, 'kind'>, value: number, unit: DistanceUnit): string {
  switch (pact.kind) {
    case 'distance':
      return formatDistance(value, unit);
    case 'steps':
      return thousands(value);
    case 'custom':
      return value >= 1 ? 'Done' : '–';
    default:
      return String(Math.round(value));
  }
}

export const progressFraction = (value: number, goal: number): number => (goal > 0 ? Math.min(1, Math.max(0, value / goal)) : 0);

/** What is left, in the pact's unit: "3.8 mi to go", "1 workout to go", "Reached". */
export function toGoText(pact: Pick<PactRow, 'kind' | 'goal_value'>, value: number, unit: DistanceUnit): string {
  const left = remainingText(pact, value, unit);
  return left === null ? 'Reached' : `${left} to go`;
}

/** The amount short of the goal in words, or null once reached. */
export function remainingText(pact: Pick<PactRow, 'kind' | 'goal_value'>, value: number, unit: DistanceUnit): string | null {
  const goal = goalValue(pact);
  if (value >= goal) return null;
  const left = goal - value;
  switch (pact.kind) {
    case 'distance':
      return `${one(metersToUnit(left, unit))} ${unit}`;
    case 'workouts':
      return plural(Math.ceil(left), 'workout');
    case 'steps':
      return `${thousands(left)} steps`;
    case 'custom':
      return 'Mark it done';
    default:
      return null;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "2 days left", "6 hr left", "25 min left", "Closed". Whole units, rounded down. */
export function timeLeftText(deadlineAt: string, nowMs: number): string {
  const left = Date.parse(deadlineAt) - nowMs;
  if (left <= 0) return 'Closed';
  if (left >= DAY) return `${plural(Math.floor(left / DAY), 'day')} left`;
  if (left >= HOUR) return `${Math.floor(left / HOUR)} hr left`;
  return `${Math.max(1, Math.floor(left / MIN))} min left`;
}

/** The header under your ring: "11.2 / 15.0 mi · 3.8 mi to go · 2 days left"; after the close, "· 2.9 mi short". */
export function progressHeadline(pact: Pick<PactRow, 'kind' | 'goal_value'>, value: number, unit: DistanceUnit, deadlineAt: string, nowMs: number): string {
  const head = formatGoalValue(pact, value, unit);
  const left = remainingText(pact, value, unit);
  if (left === null) return `${head} · Reached`;
  const closed = Date.parse(deadlineAt) <= nowMs;
  return closed ? `${head} · ${left} short` : `${head} · ${left} to go · ${timeLeftText(deadlineAt, nowMs)}`;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const rankLine = (rank: number, total: number): string => `${ordinal(rank)} of ${total}`;

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/**
 * The group home's one line for a weekly card: "Maya leads · you're 2nd · 3.8 mi to go".
 * Standings arrive ranked; `nameOf` returns "You" for the viewer.
 */
export function standingsSummary(
  standings: readonly InstanceStandingRow[],
  userId: string,
  nameOf: (id: string) => string,
  pact: Pick<PactRow, 'kind' | 'goal_value'>,
  unit: DistanceUnit,
): string {
  if (standings.length === 0) return pact.kind === 'distance' ? 'Nobody has logged a run yet' : 'Nobody has logged anything yet';
  const sorted = [...standings].sort((a, b) => a.rank - b.rank);
  const leader = sorted[0]!;
  const mine = sorted.find((s) => s.user_id === userId);
  if (mine && mine.rank === 1) {
    const behind = sorted.length - 1;
    const tail = remainingText(pact, toNumber(mine.value), unit);
    return behind > 0 ? `You lead · ${behind} behind you` : tail === null ? 'You lead · reached' : `You lead · ${tail} to go`;
  }
  const lead = `${firstName(nameOf(leader.user_id))} leads`;
  if (!mine) {
    const reached = sorted.filter((s) => s.reached_at !== null).length;
    return `${lead} · ${reached} of ${sorted.length} reached`;
  }
  const tail = remainingText(pact, toNumber(mine.value), unit);
  return `${lead} · you're ${ordinal(mine.rank)} · ${tail === null ? 'reached' : `${tail} to go`}`;
}

const TYPE_LABEL: Record<string, string> = {
  running: 'Run',
  walking: 'Walk',
  cycling: 'Ride',
  swimming: 'Swim',
  hiking: 'Hike',
  rowing: 'Row',
  strength: 'Strength',
  yoga: 'Yoga',
  other: 'Workout',
  steps: 'Steps',
};

export const activityTypeLabel = (type: string): string => TYPE_LABEL[type] ?? 'Workout';

const SOURCE_LABEL: Record<ActivitySource, string> = { healthkit: 'Apple Health', strava: 'Strava', manual: 'Manual' };
export const sourceLabel = (source: ActivitySource): string => SOURCE_LABEL[source];

/** "5.0 mi · 45:10 · 9:02 /mi" for a run; "30:00" for a timed session; "10,432 steps" for a step day. */
export function activityLine(a: Pick<PactActivityRow, 'distance_m' | 'duration_s' | 'steps'>, unit: DistanceUnit): string {
  if (a.steps !== null && a.steps > 0 && !a.distance_m && a.duration_s === 0) return `${thousands(a.steps)} steps`;
  const parts: string[] = [];
  if (a.distance_m !== null && a.distance_m > 0) parts.push(formatDistance(a.distance_m, unit));
  if (a.duration_s > 0) parts.push(formatDuration(a.duration_s));
  const pace = paceText(a.distance_m, a.duration_s, unit);
  if (pace) parts.push(pace);
  return parts.join(' · ');
}

const lower = (s: string): string => s.toLowerCase();

/** Why a row is greyed out, in plain words; null for an accepted one. */
export function rejectionText(a: Pick<PactActivityRow, 'verdict' | 'source' | 'activity_type' | 'distance_m'>, unit: DistanceUnit): string | null {
  switch (a.verdict) {
    case 'rejected_manual': {
      const what = a.distance_m ? `${formatDistance(a.distance_m, unit)} ${lower(activityTypeLabel(a.activity_type))}` : lower(activityTypeLabel(a.activity_type));
      return `A manually entered ${what} from ${sourceLabel(a.source)} doesn't count`;
    }
    case 'rejected_duplicate':
      return 'Already counted from another source';
    case 'rejected_type':
      return `${activityTypeLabel(a.activity_type)}s don't count in this challenge`;
    case 'rejected_future':
      return 'Ends in the future';
    default:
      return null;
  }
}
