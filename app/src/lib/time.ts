export type WindowState = 'before' | 'open' | 'closed';

const toMs = (iso: string | number): number => (typeof iso === 'number' ? iso : Date.parse(iso));

/** Inside the window iff window_open_at <= now <= deadline_at (matches server acceptance rules). */
export function windowState(nowMs: number, windowOpenAt: string, deadlineAt: string): WindowState {
  if (nowMs < toMs(windowOpenAt)) return 'before';
  if (nowMs <= toMs(deadlineAt)) return 'open';
  return 'closed';
}

export function msUntil(instant: string | number, nowMs: number): number {
  return toMs(instant) - nowMs;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const cacheKey = `${key}|${tz}`;
  let f = formatterCache.get(cacheKey);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz });
    formatterCache.set(cacheKey, f);
  }
  return f;
}

// ICU uses narrow no-break spaces before AM/PM; normalize so UI and tests see plain spaces.
const normalizeSpaces = (s: string): string => s.replace(/[  ]/g, ' ');

export function formatTimeInZone(instant: string | number, tz: string): string {
  return normalizeSpaces(formatter('time', tz, { hour: 'numeric', minute: '2-digit' }).format(toMs(instant)));
}

export function formatDateInZone(instant: string | number, tz: string): string {
  return normalizeSpaces(
    formatter('date', tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(toMs(instant)),
  );
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = formatter('parts', tz, {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value;
    return v === undefined ? 0 : Number(v);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function localDateInZone(nowMs: number, tz: string): string {
  const p = zonedParts(nowMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Offset of the zone from UTC at an instant, in ms (e.g. -7h for PDT). */
export function tzOffsetMs(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** Parse 'HH:MM' or 'HH:MM:SS' into minutes after midnight. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 60 + min;
}

export function toPgTime(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}:00`;
}

export function displayMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(minutes % 60)} ${suffix}`;
}

export function displayTimeOfDay(pgTime: string): string {
  const minutes = parseTimeOfDay(pgTime);
  return minutes === null ? pgTime : displayMinutes(minutes);
}

function parseLocalDate(localDate: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) throw new RangeError(`Invalid local date ${localDate}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Convert a wall-clock time on a local date in an IANA zone to a UTC instant (ms).
 * Mirrors the server's `_local_to_utc` (20261107000200): a nonexistent time (spring-forward
 * gap) uses the offset before the transition, so the clock moves forward by the gap; an
 * ambiguous time (fall-back) resolves to the EARLIER instant (the first occurrence).
 */
export function zonedLocalToUtc(localDate: string, localTime: string, tz: string): number {
  const [y, mo, d] = parseLocalDate(localDate);
  const minutes = parseTimeOfDay(localTime);
  if (minutes === null) throw new RangeError(`Invalid local time ${localTime}`);
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, 0);
  const DAY = 86_400_000;
  const before = tzOffsetMs(naive - DAY, tz);
  const after = tzOffsetMs(naive + DAY, tz);
  const consistent = (off: number): boolean => tzOffsetMs(naive - off, tz) === off;
  const okBefore = consistent(before);
  const okAfter = consistent(after);
  if (okBefore && okAfter) return Math.min(naive - before, naive - after); // ambiguous: earlier instant
  if (okAfter) return naive - after;
  if (okBefore) return naive - before;
  // In a gap neither offset reproduces the wall time: pre-transition offset, like Postgres.
  return naive - before;
}

function addDays(localDate: string, days: number): string {
  const [y, m, d] = parseLocalDate(localDate);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** ISO weekday 1=Mon..7=Sun of a 'YYYY-MM-DD' date. */
export function isoWeekday(localDate: string): number {
  const [y, m, d] = parseLocalDate(localDate);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** Next scheduled day (today counts if its deadline has not passed). */
export function nextOccurrence(
  nowMs: number,
  isoDays: readonly number[],
  deadlineLocal: string,
  tz: string,
): { localDate: string; deadlineAt: number } | null {
  if (isoDays.length === 0) return null;
  const today = localDateInZone(nowMs, tz);
  for (let i = 0; i <= 7; i += 1) {
    const localDate = addDays(today, i);
    if (!isoDays.includes(isoWeekday(localDate))) continue;
    const deadlineAt = zonedLocalToUtc(localDate, deadlineLocal, tz);
    if (deadlineAt >= nowMs) return { localDate, deadlineAt };
  }
  return null;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

export const ISO_DAY_LABELS: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

export function describeDays(isoDays: readonly number[]): string {
  const sorted = [...isoDays].sort((a, b) => a - b);
  const key = sorted.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '6,7') return 'Weekends';
  if (key === '1,2,3,4,5,6,7') return 'Every day';
  return sorted.map((d) => ISO_DAY_LABELS[d] ?? '?').join(' ');
}

/** Monday-start label for a week, e.g. 'Nov 2'. week_start is a 'YYYY-MM-DD' date. */
export function formatLocalDateShort(localDate: string): string {
  const [y, m, d] = parseLocalDate(localDate);
  return normalizeSpaces(
    formatter('short', 'UTC', { month: 'short', day: 'numeric' }).format(Date.UTC(y, m - 1, d)),
  );
}

export { addDays as addDaysToLocalDate };
