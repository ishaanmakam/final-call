/**
 * Pure mapping from Apple Health objects to `submit_activities` items. No native imports, so
 * it runs under Vitest; `healthRuntime.ts` feeds it HKWorkout samples and daily step buckets and
 * posts the result. The server judges (manual → rejected_manual, overlap → rejected_duplicate,
 * unknown type → rejected_type, future → rejected_future); this module only reports honestly:
 * `HKWasUserEntered` becomes `is_manual`, the HK uuid is the external id, and `raw_hash` covers
 * every judged field so a changed workout is a different submission.
 */
import type { ActivitySubmission, ActivityType } from '../../api/types';
import { localDateInZone } from '../../lib/time';

/** The read permissions the app asks for when someone joins or creates a goal pact. Nothing else. */
export const HK_READ_TYPES = ['HKWorkoutTypeIdentifier', 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'HKQuantityTypeIdentifierStepCount'] as const;

export interface HKQuantityLike {
  quantity: number;
  unit: string;
}

/** The slice of a HealthKit workout sample this mapper reads (`WorkoutSample` in @kingstinct/react-native-healthkit). */
export interface HKWorkoutLike {
  uuid: string;
  /** HKWorkoutActivityType raw value, or the enum's name */
  workoutActivityType: number | string;
  startDate: Date | string;
  endDate: Date | string;
  /** seconds, or a quantity with its unit */
  duration: HKQuantityLike | number;
  totalDistance?: HKQuantityLike;
  metadata?: Record<string, unknown>;
  sourceRevision?: { source: { name: string; bundleIdentifier: string }; productType?: string; operatingSystemVersion?: string };
  device?: { name?: string; model?: string };
}

/** One bucket of `queryStatisticsCollectionForQuantity('HKQuantityTypeIdentifierStepCount', ['cumulativeSum'], anchor, { day: 1 })`. */
export interface HKStepBucketLike {
  startDate: Date | string;
  endDate: Date | string;
  sumQuantity?: HKQuantityLike;
}

/** HKWorkoutActivityType raw values (Apple's enum) and names → our nine types; anything else is `other`. */
const HK_TYPE_BY_CODE: Record<number, ActivityType> = {
  37: 'running',
  52: 'walking',
  13: 'cycling',
  46: 'swimming',
  24: 'hiking',
  35: 'rowing',
  50: 'strength', // traditionalStrengthTraining
  20: 'strength', // functionalStrengthTraining
  57: 'yoga',
};

const HK_TYPE_BY_NAME: Record<string, ActivityType> = {
  running: 'running',
  walking: 'walking',
  cycling: 'cycling',
  swimming: 'swimming',
  hiking: 'hiking',
  rowing: 'rowing',
  traditionalStrengthTraining: 'strength',
  functionalStrengthTraining: 'strength',
  yoga: 'yoga',
};

export function activityTypeFromHK(type: number | string): ActivityType {
  if (typeof type === 'number') return HK_TYPE_BY_CODE[type] ?? 'other';
  return HK_TYPE_BY_NAME[type] ?? 'other';
}

const toIso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

const METERS: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };
const SECONDS: Record<string, number> = { s: 1, min: 60, hr: 3600, h: 3600 };

function metres(q: HKQuantityLike | undefined): number | null {
  if (!q || !Number.isFinite(q.quantity)) return null;
  const factor = METERS[q.unit] ?? 1;
  return Math.round(q.quantity * factor);
}

function seconds(q: HKQuantityLike | number): number {
  if (typeof q === 'number') return Math.round(q);
  return Math.round(q.quantity * (SECONDS[q.unit] ?? 1));
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';

/** A workout as `submit_activities` wants it (raw_hash left null: `withHashes` fills it). */
export function mapWorkout(w: HKWorkoutLike): ActivitySubmission {
  return {
    source: 'healthkit',
    external_id: w.uuid,
    activity_type: activityTypeFromHK(w.workoutActivityType),
    started_at: toIso(w.startDate),
    ended_at: toIso(w.endDate),
    distance_m: metres(w.totalDistance),
    duration_s: seconds(w.duration),
    steps: null,
    device: w.device?.name ?? w.sourceRevision?.source.name ?? null,
    app_bundle: w.sourceRevision?.source.bundleIdentifier ?? null,
    is_manual: truthy(w.metadata?.HKWasUserEntered),
    raw_hash: null,
  };
}

/**
 * Daily step totals as one `steps` sample per local day with a deterministic id (`steps:YYYY-MM-DD`),
 * so today's row grows on every sync (the server updates a steps row whose hash changed and whose
 * end moved later; CONTRACT "Activities"). Today's bucket ends now, never in the future.
 */
export function rollupSteps(buckets: readonly HKStepBucketLike[], tz: string, nowMs: number): ActivitySubmission[] {
  const out: ActivitySubmission[] = [];
  for (const b of buckets) {
    const steps = b.sumQuantity ? Math.round(b.sumQuantity.quantity) : 0;
    if (steps <= 0) continue;
    const startMs = Date.parse(toIso(b.startDate));
    const endMs = Math.min(Date.parse(toIso(b.endDate)) - 1000, nowMs);
    if (endMs <= startMs) continue;
    out.push({
      source: 'healthkit',
      external_id: `steps:${localDateInZone(startMs, tz)}`,
      activity_type: 'steps',
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      distance_m: null,
      duration_s: 0,
      steps,
      device: null,
      app_bundle: null,
      is_manual: false,
      raw_hash: null,
    });
  }
  return out;
}

/** Every judged field, pipe-joined: the input to `raw_hash`. */
export const hashInput = (a: ActivitySubmission): string =>
  [a.source, a.external_id, a.activity_type, a.started_at, a.ended_at, a.distance_m ?? '', a.duration_s, a.steps ?? '', a.is_manual].join('|');

/** Fills `raw_hash` through an injected digest (expo-crypto SHA-256 on device; a fake in tests). */
export async function withHashes(items: readonly ActivitySubmission[], digest: (s: string) => Promise<string>): Promise<ActivitySubmission[]> {
  return Promise.all(items.map(async (a) => ({ ...a, raw_hash: await digest(hashInput(a)) })));
}

/** The sync toast: "Synced 3 runs · 12.4 mi this week" plus the manual rejections, in plain words. */
export interface SyncOutcome {
  submitted: number;
  /** rows the server wrote (new or updated) */
  written: number;
  manual: number;
}

export function syncToast(o: SyncOutcome): { message: string; tone: 'success' | 'neutral' | 'unverified' } {
  if (o.submitted === 0) return { message: 'Nothing new in Apple Health.', tone: 'neutral' };
  const n = o.written;
  const head = n === 0 ? 'Already up to date.' : `Synced ${n} ${n === 1 ? 'activity' : 'activities'}.`;
  if (o.manual > 0) {
    return {
      message: `${head} ${o.manual === 1 ? 'A manually entered one' : `${o.manual} manually entered ones`} from Apple Health ${o.manual === 1 ? "doesn't" : "don't"} count.`,
      tone: 'unverified',
    };
  }
  return { message: head, tone: n === 0 ? 'neutral' : 'success' };
}
