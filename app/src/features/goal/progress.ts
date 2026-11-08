/**
 * Periods and progress for goal kinds. `currentLocalDate` says which instance is "this week" /
 * "today" / "the race"; `weekTimingLine` is the Today card's airport voice for a weekly card;
 * `summaryFromProgress` folds `instance_progress` rows into the live summary the cards already draw.
 *
 * `progressRows` and `standingsFrom` mirror the server views `instance_progress` and
 * `instance_standings` for demo mode only (the app never derives a result from real data: it reads
 * the views). They follow the spec: accepted activities of the allowed types whose `started_at`
 * lies in [window_open_at, deadline_at); distance sums metres, workouts count sessions of ten
 * minutes or more, steps sum steps; `reached_at` is the `ended_at` of the activity that first
 * crossed the goal.
 */
import { toNumber, type InstanceProgressRow, type InstanceStandingRow, type PactActivityRow, type PactInstanceRow, type PactRow, type ResultStatus } from '../../api/types';
import { summarizeInstance, type InstanceSummary } from '../../lib/instanceStatus';
import { addDaysToLocalDate, formatLocalDateShort, isoWeekday, localDateInZone, zonedLocalToUtc } from '../../lib/time';
import { VOICE } from '../checkin/copy';
import { goalValue } from './goal';

export const mondayOf = (localDate: string): string => addDaysToLocalDate(localDate, 1 - isoWeekday(localDate));

/** The `local_date` of the instance a pact is on right now: today, this week's Monday, or the race start. */
export function currentLocalDate(pact: Pick<PactRow, 'period' | 'tz' | 'race_start' | 'race_end'>, nowMs: number): string {
  const today = localDateInZone(nowMs, pact.tz);
  if (pact.period === 'weekly') return mondayOf(today);
  if (pact.period === 'once') return pact.race_start ?? today;
  return today;
}

/** The weekly "Final call" moment: Sunday 18:00 in the pact zone (spec; one push, one local reminder). */
export const FINAL_CALL_WEEKLY_LOCAL = '18:00:00';

export const weeklyFinalCallAt = (instance: Pick<PactInstanceRow, 'local_date'>, tz: string): number =>
  zonedLocalToUtc(addDaysToLocalDate(instance.local_date, 6), FINAL_CALL_WEEKLY_LOCAL, tz);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface WeekTiming {
  prefix: 'Boarding' | 'Final call' | 'Gate closed';
  text: string;
}

/** The weekly card's timing line: Boarding with days left, Final call from Sunday 6 PM, Gate closed after. */
export function weekTimingLine(instance: Pick<PactInstanceRow, 'local_date' | 'window_open_at' | 'deadline_at'>, tz: string, nowMs: number): WeekTiming {
  const open = Date.parse(instance.window_open_at);
  const deadline = Date.parse(instance.deadline_at);
  if (nowMs < open) return { prefix: VOICE.boarding, text: 'Starts Monday' };
  if (nowMs > deadline) return { prefix: VOICE.gateClosed, text: `${VOICE.gateClosed} · week of ${formatLocalDateShort(instance.local_date)}` };
  const left = deadline - nowMs;
  const finalCall = nowMs >= weeklyFinalCallAt(instance, tz);
  const prefix = finalCall ? VOICE.finalCall : VOICE.boarding;
  const amount = left >= DAY ? `${Math.floor(left / DAY)} day${Math.floor(left / DAY) === 1 ? '' : 's'}` : left >= HOUR ? `${Math.floor(left / HOUR)} hr` : `${Math.max(1, Math.floor(left / MIN))} min`;
  return { prefix, text: `${prefix} · ${amount} left · ends Sunday night` };
}

const WORKOUT_MIN_S = 600;

function contribution(pact: Pick<PactRow, 'kind'>, a: PactActivityRow): number {
  switch (pact.kind) {
    case 'distance':
      return a.distance_m ?? 0;
    case 'workouts':
      return a.duration_s >= WORKOUT_MIN_S ? 1 : 0;
    case 'steps':
      return a.steps ?? 0;
    case 'custom':
      return 1;
    default:
      return 0;
  }
}

/** Demo stand-in for the `instance_progress` view (see the module note). One row per participant. */
export function progressRows(
  instance: Pick<PactInstanceRow, 'id' | 'window_open_at' | 'deadline_at'>,
  pact: Pick<PactRow, 'kind' | 'goal_value' | 'activity_types'>,
  participantIds: readonly string[],
  activities: readonly PactActivityRow[],
): InstanceProgressRow[] {
  const open = Date.parse(instance.window_open_at);
  const deadline = Date.parse(instance.deadline_at);
  const goal = goalValue(pact);
  const allowed = pact.activity_types;
  return participantIds.map((user_id) => {
    const mine = activities
      .filter((a) => a.user_id === user_id && a.verdict === 'accepted')
      .filter((a) => {
        const t = Date.parse(a.started_at);
        return t >= open && t < deadline;
      })
      // steps pacts take 'steps' samples (CA-2); custom takes marks; the rest their activity_types
      .filter((a) => (pact.kind === 'steps' ? a.activity_type === 'steps' : pact.kind === 'custom' ? true : allowed === null || allowed.includes(a.activity_type as never)))
      .sort((a, b) => Date.parse(a.ended_at) - Date.parse(b.ended_at));
    let value = 0;
    let count = 0;
    let reached_at: string | null = null;
    for (const a of mine) {
      const c = contribution(pact, a);
      if (c <= 0) continue;
      value += c;
      count += 1;
      if (reached_at === null && goal > 0 && value >= goal) reached_at = a.ended_at;
    }
    return { instance_id: instance.id, user_id, value, goal, activity_count: count, reached_at };
  });
}

/** Demo stand-in for `instance_standings` (CONTRACT): reached first (by reached_at), then by value desc, then user_id. */
export function standingsFrom(progress: readonly InstanceProgressRow[]): InstanceStandingRow[] {
  const sorted = [...progress].sort((a, b) => {
    const ra = a.reached_at ? Date.parse(a.reached_at) : Number.POSITIVE_INFINITY;
    const rb = b.reached_at ? Date.parse(b.reached_at) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    const dv = toNumber(b.value) - toNumber(a.value);
    return dv || a.user_id.localeCompare(b.user_id);
  });
  return sorted.map((p, i) => ({ instance_id: p.instance_id, user_id: p.user_id, rank: i + 1, value: p.value, goal: p.goal, reached_at: p.reached_at }));
}

/**
 * The live summary the Today card and ring draw, from progress instead of taps: a participant who
 * reached the goal counts as "in" (a synthetic in-fence tap at `reached_at`); a posted result wins.
 */
export function summaryFromProgress(
  participantIds: string[],
  deadlineAt: string,
  progress: readonly InstanceProgressRow[],
  results: Array<{ user_id: string; status: ResultStatus }>,
): InstanceSummary {
  return summarizeInstance({
    participantIds,
    deadlineAt,
    checkins: progress
      .filter((p) => p.reached_at !== null)
      .map((p) => ({ user_id: p.user_id, verdict: 'in_fence' as const, server_received_at: p.reached_at! })),
    results,
  });
}
