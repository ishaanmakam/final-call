/**
 * Strips location from anything bound for Sentry. Pure, so it can be unit-tested; `sentry.ts`
 * installs it as `beforeSend` / `beforeBreadcrumb`. The server already nulls raw coordinates
 * after 30 days (CLAUDE.md); an error tracker must never become a second copy.
 */

/** Key names that hold a coordinate or its precision. Anchored: `late` and `radius_m` are fine. */
export const LOCATION_KEYS: readonly RegExp[] = [
  /^lat(itude)?$/i,
  /^l(ng|on|ong|ongitude)$/i,
  /^accuracy(_m)?$/i,
  /^(horizontal|vertical)_?accuracy$/i,
  /_lat$/i,
  /_lng$/i,
  /_latitude$/i,
  /_longitude$/i,
  /^coords?$/i,
  /^coordinates?$/i,
  /^altitude$/i,
];

/** "47.655312,-122.303501" inside a string becomes "[coords]". */
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g;

const isLocationKey = (key: string): boolean => LOCATION_KEYS.some((re) => re.test(key));

/** Returns a deep copy with location keys removed and coordinate pairs in strings redacted. */
export function scrubLocation<T>(value: T): T {
  if (typeof value === 'string') return value.replace(COORD_PAIR, '[coords]') as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v: unknown) => scrubLocation(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isLocationKey(k)) continue;
    out[k] = scrubLocation(v);
  }
  return out as T;
}
