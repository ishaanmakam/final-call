/**
 * Time zones as people name them ("Pacific Time", "Los Angeles"), never as IANA strings in copy.
 * Pure: Intl only, so the picker's list and search are unit-tested.
 */

/** A short list that covers most groups; search widens to every zone the device knows. */
export const COMMON_ZONES: readonly string[] = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Vancouver',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Istanbul',
  'Africa/Cairo',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Taipei',
  'Asia/Manila',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
];

/** "America/Los_Angeles" → "Los Angeles"; "UTC" → "UTC". */
export function zoneCity(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

const nameCache = new Map<string, string>();

function timeZoneNamePart(tz: string, style: 'longGeneric' | 'long', at: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style as 'long' }).formatToParts(at);
    const v = parts.find((p) => p.type === 'timeZoneName')?.value ?? null;
    // engines without longGeneric fall back to a GMT offset; that is not a name
    return v && !/^GMT|^UTC[+-]/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The zone's everyday name: "Pacific Time", "Central European Time", "India Standard Time".
 * Falls back from the generic name, to the long name with Standard/Daylight stripped, to the city.
 */
export function zoneDisplayName(tz: string, at: number = Date.now()): string {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  const cached = nameCache.get(tz);
  if (cached) return cached;
  let name = timeZoneNamePart(tz, 'longGeneric', at);
  if (!name) {
    const long = timeZoneNamePart(tz, 'long', at);
    name = long ? long.replace(/\s(Standard|Daylight|Summer)\sTime$/i, ' Time') : null;
  }
  const result = name ?? zoneCity(tz);
  nameCache.set(tz, result);
  return result;
}

/** Every zone the engine knows, or the common list where `Intl.supportedValuesOf` is missing. */
export function allZones(): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.('timeZone');
    // engines list canonical ids (Asia/Calcutta); the common list keeps the names people know
    if (all && all.length > 0) return [...new Set([...COMMON_ZONES, ...all])];
  } catch {
    // older engines
  }
  return COMMON_ZONES;
}

export interface ZoneOption {
  tz: string;
  name: string;
  city: string;
}

export const zoneOption = (tz: string): ZoneOption => ({ tz, name: zoneDisplayName(tz), city: zoneCity(tz) });

const fold = (s: string): string => s.toLowerCase().replace(/[_/]/g, ' ');

/**
 * No query: the device zone first, then the common list. With a query: every known zone whose
 * city, display name or IANA id contains it, common zones first, then alphabetical.
 */
export function searchZones(query: string, deviceTz: string, zones: readonly string[] = allZones()): ZoneOption[] {
  const q = fold(query.trim());
  if (q.length === 0) {
    const rest = COMMON_ZONES.filter((z) => z !== deviceTz && zones.includes(z));
    return [deviceTz, ...rest].map(zoneOption);
  }
  const common = new Set(COMMON_ZONES);
  const hits = zones
    .map(zoneOption)
    .filter((o) => fold(o.city).includes(q) || fold(o.name).includes(q) || fold(o.tz).includes(q));
  // a zone whose city or name starts with the query outranks a substring hit; common zones next,
  // in the curated order (US first); the rest alphabetically by city
  const rank = (o: ZoneOption): number =>
    (fold(o.city).startsWith(q) || fold(o.name).startsWith(q) ? 0 : 2) + (common.has(o.tz) ? 0 : 1);
  const order = (o: ZoneOption): number => {
    const i = COMMON_ZONES.indexOf(o.tz);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || order(a) - order(b) || a.city.localeCompare(b.city));
}
