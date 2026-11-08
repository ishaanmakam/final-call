import type { SyncOutcome } from './health';

/** Whether this build can read Apple Health: on an iPhone with HealthKit, on the web (never), or in demo mode (faked). */
export type HealthStatus = 'available' | 'unavailable' | 'web' | 'demo';

export interface HealthSyncOutcome extends SyncOutcome {
  syncedAt: number;
  /** how many activities (workouts + step days) were read from Health in this pass */
  activities: number;
}

export interface HealthSyncRequest {
  /** the pact zone: step days roll up by its calendar */
  tz: string;
  includeWorkouts: boolean;
  includeSteps: boolean;
}

/** The web build's answer to a sync (lane D's web shell reads this name; CD-5). */
export const HEALTH_UNAVAILABLE_MESSAGE = 'Runs sync from your iPhone; Strava works here.';

/** Copy for the Sync row's subtitle: "Synced 3 runs · last 2 min ago", "Never synced", "Runs sync from your iPhone". */
export function syncRowSubtitle(status: HealthStatus, lastSyncAt: number | null, lastCount: number | null, nowMs: number): string {
  if (status === 'web') return 'Runs sync from your iPhone. Strava works here.';
  if (status === 'unavailable') return 'Apple Health is not available on this device.';
  if (lastSyncAt === null) return 'Reads your workouts and steps; nothing else, never your location.';
  const ago = agoText(nowMs - lastSyncAt);
  const count = lastCount === null ? null : `Synced ${lastCount} ${lastCount === 1 ? 'activity' : 'activities'}`;
  return count ? `${count} · last ${ago}` : `Last synced ${ago}`;
}

export function agoText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
