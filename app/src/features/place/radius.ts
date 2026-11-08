/** Radius presets and the helper copy that turns metres into something a person can picture. */

export const RADIUS_MIN = 25;
export const RADIUS_MAX = 500;
export const RADIUS_STEP = 5;
export const RADIUS_DEFAULT = 75;

/** Where the slider gives a selection tick. */
export const RADIUS_DETENTS: readonly number[] = [25, 50, 75, 100, 150, 200, 300, 500];

const SIZES: ReadonlyArray<[upTo: number, words: string]> = [
  [25, 'a small room'],
  [50, 'a classroom'],
  [75, 'a lecture hall'],
  [100, 'a building'],
  [150, 'a big building'],
  [200, 'a city block'],
  [300, 'a couple of blocks'],
  [Infinity, 'a whole campus'],
];

export function radiusWords(m: number): string {
  return SIZES.find(([upTo]) => m <= upTo)![1];
}

export const radiusLine = (m: number): string => `${m} m · about ${radiusWords(m)}`;

export function snapRadius(m: number): number {
  const stepped = Math.round(m / RADIUS_STEP) * RADIUS_STEP;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, stepped));
}

/** Above this, the fix is called rough and the person is nudged toward a window. */
export const ROUGH_FIX_M = 50;

export const isRoughFix = (accuracyM: number | null): boolean => accuracyM !== null && accuracyM > ROUGH_FIX_M;

export const accuracyLine = (accuracyM: number | null): string =>
  accuracyM === null ? 'Saved earlier' : `Accurate to about ${Math.round(accuracyM)} m`;
