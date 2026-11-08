import { describe, expect, it } from 'vitest';
import { COMMON_TIME_ZONES, searchTimeZones, timeZoneDisplayName, timeZoneOptions } from './timeZones';

describe('time zone names', () => {
  it('shows a friendly name for common zones and never the IANA string', () => {
    expect(timeZoneDisplayName('America/Los_Angeles')).toBe('Pacific Time');
    expect(timeZoneDisplayName('America/New_York')).toBe('Eastern Time');
    expect(timeZoneDisplayName('Asia/Kolkata')).toBe('India Time');
    expect(timeZoneDisplayName('UTC')).toBe('UTC');
  });

  it('humanizes an unknown but valid zone from its city', () => {
    const name = timeZoneDisplayName('America/Argentina/Ushuaia');
    expect(name).not.toContain('/');
    expect(name).not.toContain('_');
    expect(name.length).toBeGreaterThan(0);
  });

  it('lists every common zone once with the device zone included', () => {
    const opts = timeZoneOptions('Pacific/Chatham');
    expect(opts.some((o) => o.id === 'Pacific/Chatham')).toBe(true);
    expect(new Set(opts.map((o) => o.id)).size).toBe(opts.length);
    expect(opts.length).toBeGreaterThanOrEqual(COMMON_TIME_ZONES.length);
  });

  it('searches by friendly name, city and IANA id, case-insensitively', () => {
    const opts = timeZoneOptions('America/Los_Angeles');
    expect(searchTimeZones(opts, 'pacific').map((o) => o.id)).toContain('America/Los_Angeles');
    expect(searchTimeZones(opts, 'tokyo').map((o) => o.id)).toEqual(['Asia/Tokyo']);
    expect(searchTimeZones(opts, 'Europe/Lon').map((o) => o.id)).toEqual(['Europe/London']);
    expect(searchTimeZones(opts, '')).toEqual(opts);
  });
});
