import type { CheckinAttempt } from './checkinQueue';

/** The parts of expo-location's LocationObject a check-in needs (kept structural so this stays pure). */
export interface FixLike {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
  mocked?: boolean;
}

/**
 * Build the check-in attempt from a fix. client_captured_at is the earlier of the tap and the fix
 * (never the send time): a tap at 8:59:50 whose GPS fix completes at 9:00:05 still claims 8:59:50,
 * and a cached fix older than the tap reports when that position was actually measured.
 */
export function attemptFromFix(instanceId: string, fix: FixLike, tappedAtMs: number): CheckinAttempt {
  const fixMs = Number.isFinite(fix.timestamp) && fix.timestamp > 0 ? fix.timestamp : tappedAtMs;
  const capturedMs = Math.min(fixMs, tappedAtMs);
  const accuracy = fix.coords.accuracy;
  return {
    instanceId,
    lat: fix.coords.latitude,
    lng: fix.coords.longitude,
    accuracyM: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
    clientCapturedAt: new Date(capturedMs).toISOString(),
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

/**
 * Fail-open capture for one Check In tap: always yields an attempt to send. If the fix fails, times
 * out or is unusable, the attempt carries null coordinates stamped with the tap time, so the server
 * records it as unjudgeable (unverified) rather than the day ending with no check-in at all.
 */
export async function captureAttempt(
  instanceId: string,
  takeFix: () => Promise<FixLike>,
  tappedAtMs: number,
): Promise<{ attempt: CheckinAttempt; fixError: string | null }> {
  try {
    const fix = await takeFix();
    if (!Number.isFinite(fix.coords.latitude) || !Number.isFinite(fix.coords.longitude)) {
      return { attempt: attemptWithoutFix(instanceId, tappedAtMs), fixError: 'The GPS fix had no usable position.' };
    }
    return { attempt: attemptFromFix(instanceId, fix, tappedAtMs), fixError: null };
  } catch (e) {
    return {
      attempt: attemptWithoutFix(instanceId, tappedAtMs),
      fixError: e instanceof Error && e.message ? e.message : 'Could not get a GPS fix.',
    };
  }
}
