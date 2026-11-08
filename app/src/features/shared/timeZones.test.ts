import { describe, expect, it } from 'vitest';
import {
  COMMON_TIME_ZONES,
  COMMON_ZONES,
  allZones,
  searchTimeZones,
  searchZones,
  timeZoneDisplayName,
  timeZoneOptions,
  zoneCity,
  zoneDisplayName,
} from './timeZones';

const JAN = Date.UTC(2026, 0, 15, 12);
const JUL = Date.UTC(2026, 6, 15, 12);

// ---------- the group picker's behaviour (formerly features/groups/timeZones) ----------

describe('zoneDisplayName', () => {
  it('names zones the way people do, independent of DST', () => {
    expect(zoneDisplayName('America/Los_Angeles', JAN)).toBe('Pacific Time');
    expect(zoneDisplayName('America/Los_Angeles', JUL)).toBe('Pacific Time');
    expect(zoneDisplayName('America/New_York', JUL)).toBe('Eastern Time');
    expect(zoneDisplayName('UTC')).toBe('UTC');
  });
  it('never prints an IANA id', () => {
    for (const tz of COMMON_ZONES) expect(zoneDisplayName(tz)).not.toMatch(/\//);
  });
  it('falls back to the city for an unknown zone', () => {
    expect(zoneDisplayName('Mars/Olympus_Mons')).toBe('Olympus Mons');
  });
});

describe('zoneCity', () => {
  it('takes the last segment and unescapes underscores', () => {
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('UTC')).toBe('UTC');
  });
});

describe('searchZones', () => {
  it('leads with the device zone and then the common list when empty', () => {
    const r = searchZones('', 'Asia/Tokyo');
    expect(r[0]?.id).toBe('Asia/Tokyo');
    expect(r.filter((o) => o.id === 'Asia/Tokyo')).toHaveLength(1);
    expect(r.length).toBe(COMMON_ZONES.length);
  });
  it('matches city, display name and id, common zones first', () => {
    const byCity = searchZones('los ang', 'UTC');
    expect(byCity[0]?.id).toBe('America/Los_Angeles');
    const byName = searchZones('eastern', 'UTC');
    expect(byName.some((o) => o.id === 'America/New_York')).toBe(true);
    expect(byName[0]?.id).toBe('America/New_York');
    const byId = searchZones('europe/pa', 'UTC');
    expect(byId[0]?.id).toBe('Europe/Paris');
  });
  it('finds zones outside the common list', () => {
    expect(searchZones('reykjavik', 'UTC', ['Atlantic/Reykjavik', 'UTC'])[0]?.id).toBe('Atlantic/Reykjavik');
  });
  it('returns nothing for nonsense', () => {
    expect(searchZones('zzzzqq', 'UTC')).toEqual([]);
  });
});

describe('allZones', () => {
  it('always includes UTC and the common zones', () => {
    const all = allZones();
    expect(all).toContain('UTC');
    for (const tz of COMMON_ZONES) expect(all).toContain(tz);
  });
});

// ---------- the pact wizard's behaviour (formerly features/pact/timeZones) ----------

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

// ---------- one list, one vocabulary ----------

describe('both pickers agree', () => {
  it('give the same name and city for every curated zone', () => {
    for (const z of COMMON_TIME_ZONES) {
      expect(zoneDisplayName(z.id)).toBe(z.name);
      expect(searchZones(z.city, 'UTC', COMMON_ZONES).some((o) => o.id === z.id)).toBe(true);
    }
  });
});
