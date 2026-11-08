/**
 * Web twin of healthRuntime.ts: there is no HealthKit in a browser, so the Sync row says runs sync
 * from the iPhone (Strava works here). Demo mode (the screenshot harness) fakes a sync so the row
 * and toast render. Nothing native is imported here, so the web bundle never loads Nitro.
 */
import type { QueryClient } from '@tanstack/react-query';
import { DEMO } from '../../api/demo/settings';
import { demoLastHealthSyncAt, demoSyncHealth } from './healthDemo';
import type { HealthStatus, HealthSyncOutcome, HealthSyncRequest } from './healthTypes';

export { HEALTH_UNAVAILABLE_MESSAGE, syncRowSubtitle } from './healthTypes';
export type { HealthStatus, HealthSyncOutcome, HealthSyncRequest } from './healthTypes';

export const healthStatus = (): HealthStatus => (DEMO ? 'demo' : 'web');

/** CD-5 names: the web shell asks these; the native file exports the same. */
export const healthAvailable = false;
export async function requestHealthPermission(): Promise<'granted' | 'denied' | 'unavailable'> {
  return DEMO ? 'granted' : 'unavailable';
}

export async function ensureHealthPermission(): Promise<boolean> {
  return DEMO;
}

export async function lastHealthSyncAt(): Promise<number | null> {
  return DEMO ? demoLastHealthSyncAt() : null;
}

export async function lastHealthSyncCount(): Promise<number | null> {
  return DEMO ? 3 : null;
}

export function syncHealth(_req: HealthSyncRequest): Promise<HealthSyncOutcome | null> {
  return DEMO ? demoSyncHealth() : Promise.resolve(null);
}

export function goalPactsFromCache(_qc: QueryClient, _userId: string): HealthSyncRequest | null {
  return null;
}

export function useHealthForegroundSync(_userId: string, _onSynced?: (outcome: HealthSyncOutcome) => void): void {
  // no Health on the web
}
