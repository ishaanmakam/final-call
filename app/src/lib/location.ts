import * as Location from 'expo-location';
import type { CheckinAttempt } from './checkinQueue';

export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

/** Foreground ("When In Use") permission only. This app never requests background location. */
export async function ensureForegroundPermission(): Promise<PermissionOutcome> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'blocked';
  const requested = await Location.requestForegroundPermissionsAsync();
  if (requested.granted) return 'granted';
  return requested.canAskAgain ? 'denied' : 'blocked';
}

export class FixTimeoutError extends Error {
  constructor() {
    super('Could not get a GPS fix in time.');
    this.name = 'FixTimeoutError';
  }
}

const FIX_TIMEOUT_MS = 25_000;

/** One high-accuracy foreground fix. Location is read nowhere else in the app. */
export async function takeHighAccuracyFix(timeoutMs = FIX_TIMEOUT_MS): Promise<Location.LocationObject> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FixTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build the check-in attempt from a fix. client_captured_at is the fix time, not the send time. */
export function attemptFromFix(instanceId: string, fix: Location.LocationObject): CheckinAttempt {
  return {
    instanceId,
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracyM: fix.coords.accuracy ?? null,
    clientCapturedAt: new Date(fix.timestamp).toISOString(),
    isSimulated: fix.mocked === true,
  };
}

/** Attempt with no location: lets a dead GPS become "unverified" instead of "failed". */
export function attemptWithoutFix(instanceId: string, capturedAtMs: number): CheckinAttempt {
  return {
    instanceId,
    lat: null,
    lng: null,
    accuracyM: null,
    clientCapturedAt: new Date(capturedAtMs).toISOString(),
    isSimulated: false,
  };
}
