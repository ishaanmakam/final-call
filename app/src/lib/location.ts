import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { DEMO, getDemoSettings } from '../api/demo/settings';
import { precisionOutcome, type PermissionOutcome, type PreciseOutcome } from '../features/checkin/precision';

export type { PermissionOutcome, PreciseOutcome };

/** Demo mode and the web build never touch the device's location. */
const FAKE = DEMO || Platform.OS === 'web';
const FAKE_FIX_DELAY_MS = 1200;

const outcomeOf = (r: Pick<Location.LocationPermissionResponse, 'granted' | 'canAskAgain'>): PermissionOutcome =>
  r.granted ? 'granted' : r.canAskAgain ? 'denied' : 'blocked';

/** Get, and if it has never been asked, request the foreground permission. Never asks twice. */
async function foregroundPermission(): Promise<Location.LocationPermissionResponse> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted || !current.canAskAgain) return current;
  return Location.requestForegroundPermissionsAsync();
}

/** Foreground ("When In Use") permission only. This app never requests background location. */
export async function ensureForegroundPermission(): Promise<PermissionOutcome> {
  if (FAKE) return getDemoSettings().perm;
  return outcomeOf(await foregroundPermission());
}

/**
 * The check-in tap's permission step: foreground permission AND precise accuracy. iOS "Approximate
 * Location" (reduced accuracy authorization) comes back as 'approximate' and the tap must not be
 * sent (features/checkin/precision.ts). expo-location 58 has no temporary-full-accuracy request, so
 * the screen sends the person to Settings.
 */
export async function ensurePreciseForegroundPermission(): Promise<PreciseOutcome> {
  if (FAKE) {
    const s = getDemoSettings();
    return precisionOutcome({ permission: s.perm, iosAccuracy: s.precise ? 'full' : 'reduced' });
  }
  const r = await foregroundPermission();
  return precisionOutcome({ permission: outcomeOf(r), iosAccuracy: r.ios?.accuracy, androidAccuracy: r.android?.accuracy });
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
  if (getDemoSettings().fix === 'none') throw new FixTimeoutError();
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
