import * as Location from 'expo-location';

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
