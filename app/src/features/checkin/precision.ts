/**
 * Pure decision logic for Precise Location (iOS 14+ "accuracy authorization"). No React, no Expo.
 *
 * iOS "Approximate Location" yields kilometre-level fixes, so every tap would be unjudgeable and
 * every day Unverified: the person would never pay. That is a choice, not a tracking failure, so it
 * must not get the fail-open treatment (CLAUDE.md, DECISIONS.md N2-5): the check-in button refuses to
 * send anything and the screen says the day counts as missed until Precise Location is on.
 *
 * expo-location 58 reports `ios.accuracy: 'full' | 'reduced'` and `android.accuracy: 'fine' |
 * 'coarse' | 'none'` on every permission response; it has no temporary-full-accuracy request, so the
 * only way back is Settings.
 */
export type PermissionOutcome = 'granted' | 'denied' | 'blocked';
export type PreciseOutcome = PermissionOutcome | 'approximate';

export interface PrecisionFacts {
  permission: PermissionOutcome;
  /** iOS accuracy authorization; undefined/null off iOS or below iOS 14 */
  iosAccuracy?: 'full' | 'reduced' | null;
  /** Android provider accuracy; 'none' (no provider) is left to the fix itself (a tracking failure) */
  androidAccuracy?: 'fine' | 'coarse' | 'none' | null;
}

/** True when the OS will only ever hand out approximate fixes. */
export const isReducedAccuracy = (f: Pick<PrecisionFacts, 'iosAccuracy' | 'androidAccuracy'>): boolean =>
  f.iosAccuracy === 'reduced' || f.androidAccuracy === 'coarse';

/** The outcome of a Check In tap's permission step. Permission problems come first; precision second. */
export function precisionOutcome(f: PrecisionFacts): PreciseOutcome {
  if (f.permission !== 'granted') return f.permission;
  return isReducedAccuracy(f) ? 'approximate' : 'granted';
}

/** A tap may be sent only with a precise, granted permission. */
export const maySendCheckin = (o: PreciseOutcome): boolean => o === 'granted';
