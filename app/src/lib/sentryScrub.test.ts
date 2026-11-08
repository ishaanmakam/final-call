import { describe, expect, it } from 'vitest';
import { LOCATION_KEYS, scrubLocation } from './sentryScrub';

describe('scrubLocation: no coordinates ever leave the phone through Sentry', () => {
  it('strips lat / lng / accuracy keys at any depth, case-insensitively, and keeps everything else', () => {
    const event = {
      message: 'check-in failed',
      extra: { lat: 47.65, lng: -122.3, accuracy_m: 12, instanceId: 'i1' },
      breadcrumbs: [{ data: { latitude: 1, longitude: 2, Accuracy: 3, kind: 'fix' } }],
      contexts: { place: { place_lat: 1, place_lng: 2, radius_m: 100 } },
    };
    expect(scrubLocation(event)).toEqual({
      message: 'check-in failed',
      extra: { instanceId: 'i1' },
      breadcrumbs: [{ data: { kind: 'fix' } }],
      contexts: { place: { radius_m: 100 } },
    });
  });

  it('handles arrays, nulls and primitives', () => {
    expect(scrubLocation(null)).toBeNull();
    expect(scrubLocation('x')).toBe('x');
    expect(scrubLocation([{ lat: 1, a: 2 }, 3])).toEqual([{ a: 2 }, 3]);
  });

  it('does not mutate its input', () => {
    const input = { extra: { lat: 1, ok: true } };
    scrubLocation(input);
    expect(input).toEqual({ extra: { lat: 1, ok: true } });
  });

  it('redacts a coordinate pair that appears inside a string value', () => {
    const out = scrubLocation({ message: 'fix at 47.655312,-122.303501 was late' }) as { message: string };
    expect(out.message).toBe('fix at [coords] was late');
  });

  it('the key list covers the names the app uses', () => {
    for (const k of ['lat', 'lng', 'latitude', 'longitude', 'accuracy', 'accuracy_m', 'place_lat', 'place_lng', 'coords']) {
      expect(LOCATION_KEYS.some((re) => re.test(k)), k).toBe(true);
    }
    expect(LOCATION_KEYS.some((re) => re.test('late'))).toBe(false);
    expect(LOCATION_KEYS.some((re) => re.test('radius_m'))).toBe(false);
  });
});
