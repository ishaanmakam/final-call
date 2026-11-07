import { describe, expect, it } from 'vitest';
import {
  displayTimeOfDay,
  formatCountdown,
  formatDateInZone,
  formatTimeInZone,
  isValidTimeZone,
  localDateInZone,
  msUntil,
  nextOccurrence,
  parseTimeOfDay,
  toPgTime,
  windowState,
  zonedLocalToUtc,
} from './time';

const LA = 'America/Los_Angeles';
const ms = (iso: string) => Date.parse(iso);

describe('windowState', () => {
  const open = '2026-11-09T16:00:00Z';
  const deadline = '2026-11-09T17:00:00Z';

  it('is before until the exact open instant', () => {
    expect(windowState(ms(open) - 1, open, deadline)).toBe('before');
    expect(windowState(ms(open), open, deadline)).toBe('open');
  });

  it('includes the deadline instant and closes one ms after', () => {
    expect(windowState(ms(deadline) - 1, open, deadline)).toBe('open');
    expect(windowState(ms(deadline), open, deadline)).toBe('open');
    expect(windowState(ms(deadline) + 1, open, deadline)).toBe('closed');
  });
});

describe('countdown', () => {
  it('measures time until an instant', () => {
    expect(msUntil('2026-11-09T17:00:00Z', ms('2026-11-09T16:58:30Z'))).toBe(90_000);
  });

  it.each([
    [0, '0:00'],
    [-5_000, '0:00'],
    [999, '0:00'],
    [9_000, '0:09'],
    [90_000, '1:30'],
    [59 * 60_000 + 59_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_723_000, '1:02:03'],
    [26 * 3_600_000, '26:00:00'],
  ])('%i ms -> %s', (input, expected) => {
    expect(formatCountdown(input)).toBe(expected);
  });
});

describe('display in pact time zone', () => {
  it('formats a UTC instant as local wall time', () => {
    expect(formatTimeInZone('2026-11-09T17:00:00Z', LA)).toBe('9:00 AM');
    expect(formatTimeInZone('2026-11-09T17:00:00Z', 'Asia/Kolkata')).toBe('10:30 PM');
    expect(formatDateInZone('2026-11-09T17:00:00Z', LA)).toBe('Mon, Nov 9');
  });

  it('computes the local calendar date in a zone', () => {
    expect(localDateInZone(ms('2026-11-02T07:30:00Z'), LA)).toBe('2026-11-01');
    expect(localDateInZone(ms('2026-11-02T07:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-02');
  });

  it('formats Postgres time-of-day strings', () => {
    expect(displayTimeOfDay('09:00:00')).toBe('9:00 AM');
    expect(displayTimeOfDay('13:05')).toBe('1:05 PM');
    expect(displayTimeOfDay('00:00:00')).toBe('12:00 AM');
    expect(displayTimeOfDay('12:30:00')).toBe('12:30 PM');
  });

  it('parses and serializes time-of-day', () => {
    expect(parseTimeOfDay('09:00')).toBe(540);
    expect(parseTimeOfDay('23:59:00')).toBe(1439);
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('9am')).toBeNull();
    expect(toPgTime(540)).toBe('09:00:00');
    expect(toPgTime(0)).toBe('00:00:00');
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('DST', () => {
  it('maps the same local deadline to different UTC instants across fall-back', () => {
    // 2026-11-01 is the day PDT (UTC-7) ends and PST (UTC-8) begins in Los Angeles.
    expect(new Date(zonedLocalToUtc('2026-10-31', '09:00', LA)).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-11-01', '09:00', LA)).toISOString()).toBe('2026-11-01T17:00:00.000Z');
    expect(formatTimeInZone('2026-10-31T16:00:00Z', LA)).toBe('9:00 AM');
    expect(formatTimeInZone('2026-11-01T17:00:00Z', LA)).toBe('9:00 AM');
  });

  it('handles spring-forward, including a nonexistent local time', () => {
    // 2027-03-14: 02:00 PST jumps to 03:00 PDT.
    expect(new Date(zonedLocalToUtc('2027-03-14', '09:00', LA)).toISOString()).toBe('2027-03-14T16:00:00.000Z');
    // 02:30 does not exist; like Postgres, interpret with the pre-transition offset (UTC-8).
    expect(new Date(zonedLocalToUtc('2027-03-14', '02:30', LA)).toISOString()).toBe('2027-03-14T10:30:00.000Z');
  });

  it('opens and closes the window correctly on the DST day', () => {
    const open = '2026-11-01T16:00:00Z'; // 08:00 PST
    const deadline = '2026-11-01T17:00:00Z'; // 09:00 PST
    // 08:00 PDT on the previous offset would be 15:00Z: still before the window.
    expect(windowState(ms('2026-11-01T15:00:00Z'), open, deadline)).toBe('before');
    expect(windowState(ms('2026-11-01T16:30:00Z'), open, deadline)).toBe('open');
    expect(windowState(ms('2026-11-01T17:00:01Z'), open, deadline)).toBe('closed');
    expect(formatCountdown(msUntil(deadline, ms(open)))).toBe('1:00:00');
  });

  it('finds the next occurrence across a DST change', () => {
    // Saturday 2026-10-31 13:00 PDT
    const sat = ms('2026-10-31T20:00:00Z');
    expect(nextOccurrence(sat, [7], '09:00:00', LA)).toEqual({
      localDate: '2026-11-01',
      deadlineAt: ms('2026-11-01T17:00:00Z'),
    });
    // Sunday 08:59 PST: today still counts
    expect(nextOccurrence(ms('2026-11-01T16:59:00Z'), [7], '09:00', LA)?.localDate).toBe('2026-11-01');
    // Sunday 09:01 PST: next week
    expect(nextOccurrence(ms('2026-11-01T17:01:00Z'), [7], '09:00', LA)).toEqual({
      localDate: '2026-11-08',
      deadlineAt: ms('2026-11-08T17:00:00Z'),
    });
    expect(nextOccurrence(sat, [], '09:00', LA)).toBeNull();
  });
});
