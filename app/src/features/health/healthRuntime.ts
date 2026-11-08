/**
 * Apple Health on the device (iOS, a dev build with @kingstinct/react-native-healthkit). Read-only:
 * workouts, walking + running distance and steps, nothing else, never a route. Permission is asked
 * when someone joins or creates a goal pact (`ensureHealthPermission`); syncing runs on foreground
 * (`useHealthForegroundSync`, throttled) and from the pact's Sync row (`syncHealth`). Every pass
 * reads from a watermark (AsyncStorage) minus a day, maps with `health.ts`, hashes with expo-crypto
 * and posts to `submit_activities`, which is idempotent. Web has its own file; demo mode fakes it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import * as HealthKit from '@kingstinct/react-native-healthkit';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { DEMO } from '../../api/demo/settings';
import type { GroupHome } from '../../api/queries';
import { submitActivities } from '../../api/rpc';
import type { ActivitySubmission } from '../../api/types';
import { captureException } from '../../lib/sentry';
import { isGoalKind } from '../goal/goal';
import { HK_READ_TYPES, HK_USER_ENTERED_FILTER, mapWorkout, rollupSteps, withHashes, type HKStepBucketLike, type HKStepSampleLike, type HKWorkoutLike } from './health';
import { demoLastHealthSyncAt, demoSyncHealth } from './healthDemo';
import type { HealthStatus, HealthSyncOutcome, HealthSyncRequest } from './healthTypes';

export { HEALTH_UNAVAILABLE_MESSAGE, syncRowSubtitle } from './healthTypes';
export type { HealthStatus, HealthSyncOutcome, HealthSyncRequest } from './healthTypes';

/** CD-5 names, mirrored from the web twin: whether this build can read Health at all, and a tri-state permission ask. */
export const healthAvailable = Platform.OS === 'ios';
export async function requestHealthPermission(): Promise<'granted' | 'denied' | 'unavailable'> {
  if (healthStatus() === 'unavailable' || healthStatus() === 'web') return 'unavailable';
  return (await ensureHealthPermission()) ? 'granted' : 'denied';
}

const WATERMARK_KEY = 'health:lastSyncAt';
const COUNT_KEY = 'health:lastCount';
const BACKFILL_MS = 14 * 86_400_000;
const OVERLAP_MS = 86_400_000;
/** foreground syncs no more often than this; the Sync row is never throttled */
const FOREGROUND_THROTTLE_MS = 10 * 60_000;

export function healthStatus(): HealthStatus {
  if (DEMO) return 'demo';
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    return HealthKit.isHealthDataAvailable() ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Asks once for read access to workouts, distance and steps. HealthKit never says whether reading was granted, so a completed prompt counts. */
export async function ensureHealthPermission(): Promise<boolean> {
  if (DEMO) return true;
  if (healthStatus() !== 'available') return false;
  try {
    return await HealthKit.requestAuthorization({ toRead: [...HK_READ_TYPES] });
  } catch (e) {
    captureException(e, { where: 'health.permission' });
    return false;
  }
}

export async function lastHealthSyncAt(): Promise<number | null> {
  if (DEMO) return demoLastHealthSyncAt();
  const raw = await AsyncStorage.getItem(WATERMARK_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function lastHealthSyncCount(): Promise<number | null> {
  if (DEMO) return 3;
  const raw = await AsyncStorage.getItem(COUNT_KEY);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

const sha256 = (s: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, s);

async function readWorkouts(from: Date, to: Date): Promise<ActivitySubmission[]> {
  const proxies = await HealthKit.queryWorkoutSamples({ filter: { date: { startDate: from, endDate: to } }, limit: -1, ascending: true });
  return proxies.map((p) => mapWorkout(p.toJSON() as unknown as HKWorkoutLike));
}

async function readSteps(from: Date, to: Date, tz: string, nowMs: number): Promise<ActivitySubmission[]> {
  const anchor = new Date(from);
  anchor.setHours(0, 0, 0, 0);
  const buckets = await HealthKit.queryStatisticsCollectionForQuantity('HKQuantityTypeIdentifierStepCount', ['cumulativeSum'], anchor, { day: 1 }, {
    filter: { date: { startDate: from, endDate: to } },
    unit: 'count',
  });
  // The daily sums cannot tell a typed-in sample from a counted one: ask for the hand-entered ones
  // separately and let the mapper flag their days (`is_manual`, rejected server side). A failure
  // here must not hide the honest days: it degrades to "none found" and is reported.
  let typed: HKStepSampleLike[] = [];
  try {
    const samples = await HealthKit.queryQuantitySamples('HKQuantityTypeIdentifierStepCount', {
      filter: { date: { startDate: anchor, endDate: to }, metadata: HK_USER_ENTERED_FILTER },
      limit: -1,
      unit: 'count',
    });
    typed = samples as unknown as HKStepSampleLike[];
  } catch (e) {
    captureException(e, { where: 'health.steps.userEntered' });
  }
  return rollupSteps(buckets as unknown as HKStepBucketLike[], tz, nowMs, typed);
}

let inFlight: Promise<HealthSyncOutcome | null> | null = null;

/** One sync pass. Serialized; resolves null when Health is unavailable. Never throws: errors are reported and surface as null. */
export function syncHealth(req: HealthSyncRequest): Promise<HealthSyncOutcome | null> {
  if (DEMO) return demoSyncHealth();
  if (healthStatus() !== 'available') return Promise.resolve(null);
  const run = async (): Promise<HealthSyncOutcome | null> => {
    const now = Date.now();
    const watermark = await lastHealthSyncAt();
    const from = new Date(Math.max(now - BACKFILL_MS, (watermark ?? 0) - OVERLAP_MS));
    const to = new Date(now);
    const items: ActivitySubmission[] = [];
    if (req.includeWorkouts) items.push(...(await readWorkouts(from, to)));
    if (req.includeSteps) items.push(...(await readSteps(from, to, req.tz, now)));
    const hashed = await withHashes(items, sha256);
    const written = hashed.length === 0 ? 0 : await submitActivities(hashed);
    await AsyncStorage.multiSet([
      [WATERMARK_KEY, String(now)],
      [COUNT_KEY, String(hashed.length)],
    ]);
    return { submitted: hashed.length, written, manual: hashed.filter((a) => a.is_manual).length, syncedAt: now, activities: hashed.length };
  };
  const next = (inFlight ?? Promise.resolve(null))
    .then(run)
    .catch((e: unknown) => {
      captureException(e, { where: 'health.sync' });
      return null;
    });
  inFlight = next;
  return next;
}

/** From the cached group homes: is the person in any goal pact, and does one of them count steps? */
export function goalPactsFromCache(qc: QueryClient, userId: string): HealthSyncRequest | null {
  let tz: string | null = null;
  let includeSteps = false;
  let includeWorkouts = false;
  for (const [, home] of qc.getQueriesData<GroupHome>({ queryKey: ['group'] })) {
    if (!home || !Array.isArray(home.pacts)) continue;
    for (const pact of home.pacts) {
      if (!isGoalKind(pact.kind) || pact.kind === 'custom') continue;
      const inIt = home.today.some((t) => t.pact.id === pact.id && t.participantIds.includes(userId)) || !home.unjoinedPactIds.has(pact.id);
      if (!inIt) continue;
      tz = tz ?? pact.tz;
      if (pact.kind === 'steps') includeSteps = true;
      else includeWorkouts = true;
    }
  }
  return tz ? { tz, includeSteps, includeWorkouts } : null;
}

let lastForegroundSync = 0;

/**
 * Mount once in the signed-in tree: syncs when the app returns to the foreground (and once on
 * mount), throttled to every ten minutes, only while the person is in a goal pact. After a pass
 * that wrote rows, the group and pact queries refresh so progress and standings move.
 */
export function useHealthForegroundSync(userId: string, onSynced?: (outcome: HealthSyncOutcome) => void): void {
  const qc = useQueryClient();
  const callback = useRef(onSynced);
  callback.current = onSynced;
  useEffect(() => {
    if (DEMO || Platform.OS !== 'ios') return;
    const attempt = () => {
      const req = goalPactsFromCache(qc, userId);
      if (!req || Date.now() - lastForegroundSync < FOREGROUND_THROTTLE_MS) return;
      lastForegroundSync = Date.now();
      void syncHealth(req).then((outcome) => {
        if (!outcome) return;
        if (outcome.written > 0) {
          void qc.invalidateQueries({ queryKey: ['group'] });
          void qc.invalidateQueries({ queryKey: ['pact'] });
        }
        callback.current?.(outcome);
      });
    };
    const timer = setTimeout(attempt, 2500);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') attempt();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [qc, userId]);
}
