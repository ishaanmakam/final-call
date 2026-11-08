import { describe, expect, it } from 'vitest';
import { COMMON_ZONES, allZones, searchZones, zoneCity, zoneDisplayName } from './timeZones';

const JAN = Date.UTC(2026, 0, 15, 12);
const JUL = Date.UTC(2026, 6, 15, 12);

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
    expect(r[0]?.tz).toBe('Asia/Tokyo');
    expect(r.filter((o) => o.tz === 'Asia/Tokyo')).toHaveLength(1);
    expect(r.length).toBe(COMMON_ZONES.length);
  });
  it('matches city, display name and id, common zones first', () => {
    const byCity = searchZones('los ang', 'UTC');
    expect(byCity[0]?.tz).toBe('America/Los_Angeles');
    const byName = searchZones('eastern', 'UTC');
    expect(byName.some((o) => o.tz === 'America/New_York')).toBe(true);
    expect(byName[0]?.tz).toBe('America/New_York');
    const byId = searchZones('europe/pa', 'UTC');
    expect(byId[0]?.tz).toBe('Europe/Paris');
  });
  it('finds zones outside the common list', () => {
    expect(searchZones('reykjavik', 'UTC', ['Atlantic/Reykjavik', 'UTC'])[0]?.tz).toBe('Atlantic/Reykjavik');
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
