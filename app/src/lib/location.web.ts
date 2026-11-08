/**
 * Web build of lib/location.ts (Metro picks this file for --platform web). Same exports.
 *
 * Browser geolocation through expo-location's web implementation (navigator.geolocation). The browser
 * has no "Approximate Location" switch, so a granted permission is always 'granted' (precise): the fence
 * math is identical to the phone's. Permission outcomes: 'granted' | 'denied' (the person refused this
 * origin; the browser lets them change it in the address bar, so it is never 'blocked').
 *
 * Demo builds (EXPO_PUBLIC_DEMO=1, the screenshot harness and the Pages demo) keep the fake fix so the
 * `?verdict=` / `?perm=` / `?fix=` scenarios still render.
 */
import * as Location from 'expo-location';
import { DEMO, getDemoSettings } from '../api/demo/settings';
import { precisionOutcome, type PermissionOutcome, type PreciseOutcome } from '../features/checkin/precision';

export type { PermissionOutcome, PreciseOutcome };

const FAKE_FIX_DELAY_MS = 1200;

export class FixTimeoutError extends Error {
  constructor() {
    super('Could not get a GPS fix in time.');
    this.name = 'FixTimeoutError';
  }
}

const FIX_TIMEOUT_MS = 25_000;

const hasGeolocation = (): boolean => typeof navigator !== 'undefined' && 'geolocation' in navigator;

/**
 * The browser's permission state. `navigator.permissions.query` is missing on some browsers (older
 * Safari); then the only way to know is to ask, which is what the Check In tap does anyway.
 */
async function foregroundPermission(): Promise<PermissionOutcome> {
  if (!hasGeolocation()) return 'denied';
  try {
    const current = await Location.getForegroundPermissionsAsync();
    if (current.granted) return 'granted';
    if (current.status === 'denied') return 'denied';
  } catch {
    // no Permissions API: fall through and ask
  }
  try {
    const asked = await Location.requestForegroundPermissionsAsync();
    return asked.granted ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Foreground permission only; the browser prompt is the request. Never 'blocked' on the web. */
export async function ensureForegroundPermission(): Promise<PermissionOutcome> {
  if (DEMO) return getDemoSettings().perm;
  return foregroundPermission();
}

/** Browsers have no reduced-accuracy mode, so a granted permission is precise by definition. */
export async function ensurePreciseForegroundPermission(): Promise<PreciseOutcome> {
  if (DEMO) {
    const s = getDemoSettings();
    return precisionOutcome({ permission: s.perm, iosAccuracy: s.precise ? 'full' : 'reduced' });
  }
  return precisionOutcome({ permission: await foregroundPermission() });
}

/** Kane Hall, with the accuracy the demo verdict implies, after a GPS-like pause (same as native). */
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

/**
 * One high-accuracy fix from the browser. A fresh reading is forced (`maximumAge: 0`): expo-location's
 * web default would hand back a cached position of any age, which a check-in must not use.
 */
export async function takeHighAccuracyFix(timeoutMs = FIX_TIMEOUT_MS): Promise<Location.LocationObject> {
  if (DEMO) return fakeFix();
  if (!hasGeolocation()) throw new FixTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FixTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        // passed through to navigator.geolocation.getCurrentPosition (expo-location web spreads options)
        ...({ maximumAge: 0, timeout: timeoutMs } as object),
      }),
      timeout,
    ]);
  } catch (e) {
    // GeolocationPositionError.TIMEOUT (3) / POSITION_UNAVAILABLE (2) are tracking failures: fail-open upstream
    const code = (e as { code?: number }).code;
    if (code === 2 || code === 3) throw new FixTimeoutError();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
