import { useMemo } from 'react';
import { distanceUnitForLocale, type DistanceUnit } from './goal';

/** The device locale's region decides miles or kilometres (goal.ts); the pact itself stores metres. */
export function deviceDistanceUnit(): DistanceUnit {
  try {
    return distanceUnitForLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return 'km';
  }
}

export function useDistanceUnit(): DistanceUnit {
  return useMemo(deviceDistanceUnit, []);
}
