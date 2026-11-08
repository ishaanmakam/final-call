import { DateTime } from 'luxon';

/** Local date (yyyy-MM-dd) of an instant in a zone. */
export function localDateOf(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate()!;
}

/** The instant of a local wall time on a local date in a zone. */
export function instantOf(localDate: string, hhmm: string, tz: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return DateTime.fromISO(localDate, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
}

export function addDays(localDate: string, days: number): string {
  return DateTime.fromISO(localDate).plus({ days }).toISODate()!;
}

/** ISO weekday, 1 = Monday. */
export function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate).weekday;
}

/** Monday of the week containing the date. */
export function weekStartOf(localDate: string): string {
  return DateTime.fromISO(localDate).startOf('week').toISODate()!;
}

export function isoWeekOf(localDate: string): string {
  const d = DateTime.fromISO(localDate);
  return `${d.weekYear}-W${String(d.weekNumber).padStart(2, '0')}`;
}

export function monthOf(localDate: string): string {
  return localDate.slice(0, 7);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function fmtTime(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');
}

export function fmtDayShort(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc, LLL d');
}

export function fmtDateShort(localDate: string): string {
  return DateTime.fromISO(localDate).toFormat('ccc, LLL d');
}

export function fmtDateHeader(localDate: string): string {
  return DateTime.fromISO(localDate).toFormat('ccc, LLL d').toUpperCase();
}

export function fmtClock(ms: number, tz: string): string {
  const d = DateTime.fromMillis(ms, { zone: tz });
  return `${d.toFormat('ccc, LLL d')} · ${d.toFormat('h:mm a')} ${d.offsetNameShort}`;
}

/** h:mm:ss or mm:ss, tabular. */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}
