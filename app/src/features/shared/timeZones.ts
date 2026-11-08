/**
 * Time zones as people name them ("Pacific Time", "Los Angeles"), never as IANA strings in copy.
 * One module for both pickers (new group: "Settles up in"; new pact: "Time zone"), so the same zone
 * has the same name everywhere. Pure: Intl only, so the lists and search are unit-tested.
 *
 * Names come from a curated list first (`Intl.supportedValuesOf` and `longGeneric` are not
 * guaranteed on Hermes); unknown zones fall back to the engine's generic name, then to the city.
 */
import { isValidTimeZone } from '../../lib/time';

export interface TimeZoneOption {
  /** IANA id, what the group or pact stores */
  id: string;
  /** "Pacific Time" */
  name: string;
  /** "Los Angeles" */
  city: string;
}

/** The zones most groups will pick, in the order the picker shows them (US first). */
export const COMMON_TIME_ZONES: readonly TimeZoneOption[] = [
  { id: 'America/Los_Angeles', name: 'Pacific Time', city: 'Los Angeles' },
  { id: 'America/Denver', name: 'Mountain Time', city: 'Denver' },
  { id: 'America/Phoenix', name: 'Arizona Time', city: 'Phoenix' },
  { id: 'America/Chicago', name: 'Central Time', city: 'Chicago' },
  { id: 'America/New_York', name: 'Eastern Time', city: 'New York' },
  { id: 'America/Anchorage', name: 'Alaska Time', city: 'Anchorage' },
  { id: 'Pacific/Honolulu', name: 'Hawaii Time', city: 'Honolulu' },
  { id: 'America/Vancouver', name: 'Pacific Time', city: 'Vancouver' },
  { id: 'America/Edmonton', name: 'Mountain Time', city: 'Edmonton' },
  { id: 'America/Winnipeg', name: 'Central Time', city: 'Winnipeg' },
  { id: 'America/Toronto', name: 'Eastern Time', city: 'Toronto' },
  { id: 'America/Halifax', name: 'Atlantic Time', city: 'Halifax' },
  { id: 'America/St_Johns', name: 'Newfoundland Time', city: "St. John's" },
  { id: 'America/Mexico_City', name: 'Central Time', city: 'Mexico City' },
  { id: 'America/Bogota', name: 'Colombia Time', city: 'Bogotá' },
  { id: 'America/Lima', name: 'Peru Time', city: 'Lima' },
  { id: 'America/Santiago', name: 'Chile Time', city: 'Santiago' },
  { id: 'America/Sao_Paulo', name: 'Brasília Time', city: 'São Paulo' },
  { id: 'America/Argentina/Buenos_Aires', name: 'Argentina Time', city: 'Buenos Aires' },
  { id: 'UTC', name: 'UTC', city: 'Coordinated Universal Time' },
  { id: 'Europe/London', name: 'UK Time', city: 'London' },
  { id: 'Europe/Dublin', name: 'Ireland Time', city: 'Dublin' },
  { id: 'Europe/Lisbon', name: 'Western European Time', city: 'Lisbon' },
  { id: 'Europe/Paris', name: 'Central European Time', city: 'Paris' },
  { id: 'Europe/Berlin', name: 'Central European Time', city: 'Berlin' },
  { id: 'Europe/Madrid', name: 'Central European Time', city: 'Madrid' },
  { id: 'Europe/Rome', name: 'Central European Time', city: 'Rome' },
  { id: 'Europe/Amsterdam', name: 'Central European Time', city: 'Amsterdam' },
  { id: 'Europe/Stockholm', name: 'Central European Time', city: 'Stockholm' },
  { id: 'Europe/Warsaw', name: 'Central European Time', city: 'Warsaw' },
  { id: 'Europe/Athens', name: 'Eastern European Time', city: 'Athens' },
  { id: 'Europe/Helsinki', name: 'Eastern European Time', city: 'Helsinki' },
  { id: 'Europe/Istanbul', name: 'Turkey Time', city: 'Istanbul' },
  { id: 'Europe/Moscow', name: 'Moscow Time', city: 'Moscow' },
  { id: 'Africa/Cairo', name: 'Egypt Time', city: 'Cairo' },
  { id: 'Africa/Johannesburg', name: 'South Africa Time', city: 'Johannesburg' },
  { id: 'Africa/Lagos', name: 'West Africa Time', city: 'Lagos' },
  { id: 'Africa/Nairobi', name: 'East Africa Time', city: 'Nairobi' },
  { id: 'Asia/Dubai', name: 'Gulf Time', city: 'Dubai' },
  { id: 'Asia/Tehran', name: 'Iran Time', city: 'Tehran' },
  { id: 'Asia/Karachi', name: 'Pakistan Time', city: 'Karachi' },
  { id: 'Asia/Kolkata', name: 'India Time', city: 'Mumbai' },
  { id: 'Asia/Dhaka', name: 'Bangladesh Time', city: 'Dhaka' },
  { id: 'Asia/Bangkok', name: 'Indochina Time', city: 'Bangkok' },
  { id: 'Asia/Jakarta', name: 'Western Indonesia Time', city: 'Jakarta' },
  { id: 'Asia/Singapore', name: 'Singapore Time', city: 'Singapore' },
  { id: 'Asia/Hong_Kong', name: 'Hong Kong Time', city: 'Hong Kong' },
  { id: 'Asia/Shanghai', name: 'China Time', city: 'Shanghai' },
  { id: 'Asia/Taipei', name: 'Taipei Time', city: 'Taipei' },
  { id: 'Asia/Manila', name: 'Philippine Time', city: 'Manila' },
  { id: 'Asia/Seoul', name: 'Korea Time', city: 'Seoul' },
  { id: 'Asia/Tokyo', name: 'Japan Time', city: 'Tokyo' },
  { id: 'Australia/Perth', name: 'Western Australia Time', city: 'Perth' },
  { id: 'Australia/Adelaide', name: 'Central Australia Time', city: 'Adelaide' },
  { id: 'Australia/Brisbane', name: 'Queensland Time', city: 'Brisbane' },
  { id: 'Australia/Sydney', name: 'Eastern Australia Time', city: 'Sydney' },
  { id: 'Australia/Melbourne', name: 'Eastern Australia Time', city: 'Melbourne' },
  { id: 'Pacific/Auckland', name: 'New Zealand Time', city: 'Auckland' },
];

/** The curated ids, in picker order. */
export const COMMON_ZONES: readonly string[] = COMMON_TIME_ZONES.map((z) => z.id);

const byId = new Map(COMMON_TIME_ZONES.map((z) => [z.id, z]));

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
    return v && !/^GMT|^UTC[+-]/.test(v) && !v.includes('/') ? v : null;
  } catch {
    return null;
  }
}

/**
 * The zone's everyday name: "Pacific Time", "Central European Time", "India Time". The curated
 * list first; then the engine's generic name, the long name with Standard/Daylight stripped, and
 * finally the city. Never the IANA id.
 */
export function zoneDisplayName(tz: string, at: number = Date.now()): string {
  const known = byId.get(tz);
  if (known) return known.name;
  if (tz === 'Etc/UTC') return 'UTC';
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

/** Same as `zoneDisplayName`; the name the pact wizard imports. */
export const timeZoneDisplayName = (id: string): string => zoneDisplayName(id);

/** Current UTC offset as "GMT-8", for a row subtitle. */
export function timeZoneOffsetLabel(id: string, at = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'shortOffset' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** Every zone the engine knows, or the curated list where `Intl.supportedValuesOf` is missing. */
export function allZones(): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.('timeZone');
    // engines list canonical ids (Asia/Calcutta); the curated list keeps the names people know
    if (all && all.length > 0) return [...new Set([...COMMON_ZONES, ...all])];
  } catch {
    // older engines
  }
  return COMMON_ZONES;
}

/** One picker row for any zone id: curated name and city when known, else derived. */
export function zoneOption(id: string): TimeZoneOption {
  return byId.get(id) ?? { id, name: zoneDisplayName(id), city: zoneCity(id) };
}

/** The curated list with the device zone guaranteed present and first. */
export function timeZoneOptions(deviceZone: string): TimeZoneOption[] {
  const rest = COMMON_TIME_ZONES.filter((z) => z.id !== deviceZone);
  const device = byId.get(deviceZone) ?? (isValidTimeZone(deviceZone) ? zoneOption(deviceZone) : null);
  return device ? [device, ...rest] : [...rest];
}

const fold = (s: string): string => s.toLowerCase().replace(/[_/]/g, ' ');

/** Filters a fixed option list by friendly name, city or id, case-insensitively. */
export function searchTimeZones(options: readonly TimeZoneOption[], query: string): TimeZoneOption[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...options];
  return options.filter(
    (o) => o.name.toLowerCase().includes(q) || o.city.toLowerCase().includes(q) || o.id.toLowerCase().includes(q),
  );
}

/**
 * No query: the device zone first, then the curated list. With a query: every known zone whose
 * city, display name or IANA id contains it; a zone whose city or name starts with the query
 * outranks a substring hit, curated zones come next in their own order, the rest alphabetically.
 */
export function searchZones(query: string, deviceTz: string, zones: readonly string[] = allZones()): TimeZoneOption[] {
  const q = fold(query.trim());
  if (q.length === 0) {
    const rest = COMMON_ZONES.filter((z) => z !== deviceTz && zones.includes(z));
    return [deviceTz, ...rest].map(zoneOption);
  }
  const common = new Set(COMMON_ZONES);
  const hits = zones.map(zoneOption).filter((o) => fold(o.city).includes(q) || fold(o.name).includes(q) || fold(o.id).includes(q));
  const rank = (o: TimeZoneOption): number =>
    (fold(o.city).startsWith(q) || fold(o.name).startsWith(q) ? 0 : 2) + (common.has(o.id) ? 0 : 1);
  const order = (o: TimeZoneOption): number => {
    const i = COMMON_ZONES.indexOf(o.id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || order(a) - order(b) || a.city.localeCompare(b.city));
}
