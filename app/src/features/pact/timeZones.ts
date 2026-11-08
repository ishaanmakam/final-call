/**
 * A short, searchable list of time zones with human names. The device zone is the default and is
 * always in the list; the IANA id is stored, never shown.
 */
import { isValidTimeZone } from '../../lib/time';

export interface TimeZoneOption {
  /** IANA id, what the pact stores */
  id: string;
  /** "Pacific Time" */
  name: string;
  /** "Los Angeles" */
  city: string;
}

export const COMMON_TIME_ZONES: readonly TimeZoneOption[] = [
  { id: 'Pacific/Honolulu', name: 'Hawaii Time', city: 'Honolulu' },
  { id: 'America/Anchorage', name: 'Alaska Time', city: 'Anchorage' },
  { id: 'America/Los_Angeles', name: 'Pacific Time', city: 'Los Angeles' },
  { id: 'America/Vancouver', name: 'Pacific Time', city: 'Vancouver' },
  { id: 'America/Phoenix', name: 'Arizona Time', city: 'Phoenix' },
  { id: 'America/Denver', name: 'Mountain Time', city: 'Denver' },
  { id: 'America/Edmonton', name: 'Mountain Time', city: 'Edmonton' },
  { id: 'America/Chicago', name: 'Central Time', city: 'Chicago' },
  { id: 'America/Mexico_City', name: 'Central Time', city: 'Mexico City' },
  { id: 'America/Winnipeg', name: 'Central Time', city: 'Winnipeg' },
  { id: 'America/New_York', name: 'Eastern Time', city: 'New York' },
  { id: 'America/Toronto', name: 'Eastern Time', city: 'Toronto' },
  { id: 'America/Halifax', name: 'Atlantic Time', city: 'Halifax' },
  { id: 'America/St_Johns', name: 'Newfoundland Time', city: "St. John's" },
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

const byId = new Map(COMMON_TIME_ZONES.map((z) => [z.id, z]));

/** "America/Argentina/Ushuaia" -> "Ushuaia" */
function cityOf(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.replace(/_/g, ' ');
}

/** Friendly name from the list, else the platform's generic name, else the city. Never the IANA id. */
export function timeZoneDisplayName(id: string): string {
  const known = byId.get(id);
  if (known) return known.name;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longGeneric' }).formatToParts(Date.now());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^GMT/.test(name) && !name.includes('/')) return name;
  } catch {
    // unsupported option or zone: fall through to the city
  }
  return cityOf(id);
}

/** Current UTC offset as "GMT-8", for the row subtitle. */
export function timeZoneOffsetLabel(id: string, at = Date.now()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'shortOffset' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** The common list with the device (or current) zone guaranteed present, device zone first. */
export function timeZoneOptions(deviceZone: string): TimeZoneOption[] {
  const rest = COMMON_TIME_ZONES.filter((z) => z.id !== deviceZone);
  const device =
    byId.get(deviceZone) ??
    (isValidTimeZone(deviceZone) ? { id: deviceZone, name: timeZoneDisplayName(deviceZone), city: cityOf(deviceZone) } : null);
  return device ? [device, ...rest] : [...rest];
}

export function searchTimeZones(options: readonly TimeZoneOption[], query: string): TimeZoneOption[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...options];
  return options.filter(
    (o) => o.name.toLowerCase().includes(q) || o.city.toLowerCase().includes(q) || o.id.toLowerCase().includes(q),
  );
}
