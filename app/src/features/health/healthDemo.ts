/**
 * Demo mode's Apple Health: no device, so the Sync row "syncs" the fixture runs and reports the
 * fixture rejection (one manually entered run). Shared by the native and web runtimes so both
 * builds behave the same under EXPO_PUBLIC_DEMO=1 and the screenshot harness.
 */
import { DEMO_T0 } from '../../api/demo/fixtures';
import type { HealthSyncOutcome } from './healthTypes';

let lastSync = DEMO_T0 - 2 * 60_000;

export async function demoSyncHealth(): Promise<HealthSyncOutcome> {
  await new Promise<void>((r) => setTimeout(r, 600));
  lastSync = Date.now();
  // the three fixture runs of yours this week: two accepted earlier, one manual entry the server rejected
  return { submitted: 3, written: 0, manual: 1, syncedAt: lastSync, activities: 3 };
}

export const demoLastHealthSyncAt = async (): Promise<number | null> => lastSync;
