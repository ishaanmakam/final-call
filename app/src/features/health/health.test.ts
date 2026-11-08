import { describe, expect, it } from 'vitest';
import { HK_READ_TYPES, hashInput, mapWorkout, rollupSteps, withHashes, type HKWorkoutLike, type HKStepBucketLike } from './health';

const workout = (over: Partial<HKWorkoutLike> = {}): HKWorkoutLike => ({
  uuid: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
  workoutActivityType: 37,
  startDate: new Date('2026-11-12T14:00:00Z'),
  endDate: new Date('2026-11-12T14:45:10Z'),
  duration: { quantity: 2710, unit: 's' },
  totalDistance: { quantity: 8046.72, unit: 'm' },
  metadata: {},
  sourceRevision: { source: { name: 'Apple Watch', bundleIdentifier: 'com.apple.health.xyz' }, productType: 'Watch6,2', operatingSystemVersion: '10.0' },
  device: { name: 'Apple Watch', model: 'Watch' },
  ...over,
});

describe('mapWorkout', () => {
  it('maps a run: HK uuid as external id, seconds, metres, device and bundle', () => {
    expect(mapWorkout(workout())).toEqual({
      source: 'healthkit',
      external_id: '3F2504E0-4F89-11D3-9A0C-0305E82C3301',
      activity_type: 'running',
      started_at: '2026-11-12T14:00:00.000Z',
      ended_at: '2026-11-12T14:45:10.000Z',
      distance_m: 8047,
      duration_s: 2710,
      steps: null,
      device: 'Apple Watch',
      app_bundle: 'com.apple.health.xyz',
      is_manual: false,
      raw_hash: null,
    });
  });

  it('maps the HealthKit activity codes and names to our types, anything else to other', () => {
    const type = (t: number | string) => mapWorkout(workout({ workoutActivityType: t })).activity_type;
    expect(type(37)).toBe('running');
    expect(type(52)).toBe('walking');
    expect(type(13)).toBe('cycling');
    expect(type(46)).toBe('swimming');
    expect(type(24)).toBe('hiking');
    expect(type(35)).toBe('rowing');
    expect(type(50)).toBe('strength');
    expect(type(20)).toBe('strength');
    expect(type(57)).toBe('yoga');
    expect(type(16)).toBe('other');
    expect(type('running')).toBe('running');
    expect(type('traditionalStrengthTraining')).toBe('strength');
    expect(type('danceInspiredTraining')).toBe('other');
  });

  it('HKWasUserEntered marks the row manual (the server rejects it; the toast explains)', () => {
    expect(mapWorkout(workout({ metadata: { HKWasUserEntered: true } })).is_manual).toBe(true);
    expect(mapWorkout(workout({ metadata: { HKWasUserEntered: 1 } })).is_manual).toBe(true);
    expect(mapWorkout(workout({ metadata: { HKWasUserEntered: false } })).is_manual).toBe(false);
  });

  it('converts distance and duration units, and copes with missing distance or device', () => {
    expect(mapWorkout(workout({ totalDistance: { quantity: 5, unit: 'mi' } })).distance_m).toBe(8047);
    expect(mapWorkout(workout({ totalDistance: { quantity: 10, unit: 'km' } })).distance_m).toBe(10000);
    expect(mapWorkout(workout({ totalDistance: undefined })).distance_m).toBeNull();
    expect(mapWorkout(workout({ duration: { quantity: 45, unit: 'min' } })).duration_s).toBe(2700);
    expect(mapWorkout(workout({ duration: 2710 })).duration_s).toBe(2710);
    expect(mapWorkout(workout({ startDate: '2026-11-12T14:00:00Z', endDate: '2026-11-12T14:45:10Z' })).started_at).toBe('2026-11-12T14:00:00.000Z');
    expect(mapWorkout(workout({ device: undefined, sourceRevision: { source: { name: 'Strava', bundleIdentifier: 'com.strava.stravaride' }, operatingSystemVersion: '1' } })).device).toBe('Strava');
    expect(mapWorkout(workout({ device: undefined, sourceRevision: undefined })).device).toBeNull();
  });
});

describe('steps', () => {
  it('rolls daily buckets up into one steps row per local day with a deterministic id', () => {
    const buckets: HKStepBucketLike[] = [
      { startDate: new Date('2026-11-12T08:00:00Z'), endDate: new Date('2026-11-13T08:00:00Z'), sumQuantity: { quantity: 10432, unit: 'count' } },
      { startDate: new Date('2026-11-13T08:00:00Z'), endDate: new Date('2026-11-14T08:00:00Z'), sumQuantity: { quantity: 2210.4, unit: 'count' } },
      { startDate: new Date('2026-11-14T08:00:00Z'), endDate: new Date('2026-11-15T08:00:00Z'), sumQuantity: undefined },
    ];
    const rows = rollupSteps(buckets, 'America/Los_Angeles', Date.parse('2026-11-13T18:00:00Z'));
    expect(rows).toEqual([
      {
        source: 'healthkit',
        external_id: 'steps:2026-11-12',
        activity_type: 'steps',
        started_at: '2026-11-12T08:00:00.000Z',
        ended_at: '2026-11-13T07:59:59.000Z',
        distance_m: null,
        duration_s: 0,
        steps: 10432,
        device: null,
        app_bundle: null,
        is_manual: false,
        raw_hash: null,
      },
      {
        source: 'healthkit',
        external_id: 'steps:2026-11-13',
        activity_type: 'steps',
        started_at: '2026-11-13T08:00:00.000Z',
        // today's bucket ends now, never in the future (the server rejects ended_at > now + 5 min)
        ended_at: '2026-11-13T18:00:00.000Z',
        distance_m: null,
        duration_s: 0,
        steps: 2210,
        device: null,
        app_bundle: null,
        is_manual: false,
        raw_hash: null,
      },
    ]);
  });
});

describe('hashes', () => {
  it('the hash input covers every judged field, so a changed workout changes the hash', () => {
    const a = mapWorkout(workout());
    const input = hashInput(a);
    expect(input).toBe('healthkit|3F2504E0-4F89-11D3-9A0C-0305E82C3301|running|2026-11-12T14:00:00.000Z|2026-11-12T14:45:10.000Z|8047|2710||false');
    expect(hashInput({ ...a, distance_m: 8000 })).not.toBe(input);
    expect(hashInput({ ...a, is_manual: true })).not.toBe(input);
  });

  it('fills raw_hash through the injected digest', async () => {
    const digest = async (s: string) => `sha256:${s.length}`;
    const rows = await withHashes([mapWorkout(workout()), mapWorkout(workout({ uuid: 'b' }))], digest);
    expect(rows[0]!.raw_hash).toBe(`sha256:${hashInput(rows[0]!).length}`);
    expect(rows[1]!.raw_hash).toBe(`sha256:${hashInput(rows[1]!).length}`);
  });

  it('asks to read workouts, distance and steps, nothing else', () => {
    expect(HK_READ_TYPES).toEqual(['HKWorkoutTypeIdentifier', 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'HKQuantityTypeIdentifierStepCount']);
  });
});
