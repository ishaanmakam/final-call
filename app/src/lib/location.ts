import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { DEMO, getDemoSettings } from '../api/demo/settings';

export type PermissionOutcome = 'granted' | 'denied' | 'blocked';

/** Demo mode and the web build never touch the device's location. */
const FAKE = DEMO || Platform.OS === 'web';
const FAKE_FIX_DELAY_MS = 1200;

/** Foreground ("When In Use") permission only. This app never requests background location. */
export async function ensureForegroundPermission(): Promise<PermissionOutcome> {
  if (FAKE) return getDemoSettings().perm;
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

/** Kane Hall, with the accuracy the demo verdict implies, after a GPS-like pause. */
async function fakeFix(): Promise<Location.LocationObject> {
  await new Promise<void>((r) => setTimeout(r, FAKE_FIX_DELAY_MS));
  const verdict = getDemoSettings().verdict;
  return {
    coords: {
      latitude: 47.6567,
      longitude: -122.309,
      altitude: null,
      accuracy: verdict === 'unjudgeable' ? 480 : 9,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
    mocked: verdict === 'rejected_simulated',
  };
}

/** One high-accuracy foreground fix. Location is read nowhere else in the app. */
export async function takeHighAccuracyFix(timeoutMs = FIX_TIMEOUT_MS): Promise<Location.LocationObject> {
  if (FAKE) return fakeFix();
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
