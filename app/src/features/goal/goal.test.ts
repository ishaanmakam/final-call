import { describe, expect, it } from 'vitest';
import type { PactActivityRow, PactRow } from '../../api/types';
import {
  METERS_PER_MILE,
  activityLine,
  activityTypeLabel,
  distanceUnitForLocale,
  formatDistance,
  formatDuration,
  formatGoalValue,
  goalLabel,
  goalValue,
  isGoalKind,
  metersToUnit,
  ordinal,
  paceText,
  progressFraction,
  progressHeadline,
  rankLine,
  rejectionText,
  sourceLabel,
  standingsSummary,
  timeLeftText,
  toGoText,
  unitToMeters,
  formatDurationWords,
  tooShortText,
  evidenceNoun,
} from './goal';

const base: PactRow = {
  id: 'p7',
  group_id: 'g1',
  title: '15 miles a week',
  days_of_week: [],
  window_open_local: '00:00:00',
  deadline_local: '23:59:00',
  stake_cents: 500,
  tz: 'America/Los_Angeles',
  paused: false,
  created_by: 'u',
  created_at: '2026-01-01T00:00:00Z',
  kind: 'distance',
  period: 'weekly',
  goal_value: 24140,
  goal_unit: 'm',
  activity_types: ['running'],
  race_start: null,
  race_end: null,
  proof_required: false,
};
const workouts: PactRow = { ...base, id: 'p8', title: '3 workouts', kind: 'workouts', goal_value: '3', goal_unit: 'count', activity_types: ['running', 'strength'] };
const steps: PactRow = { ...base, kind: 'steps', period: 'daily', goal_value: 10000, goal_unit: 'steps', activity_types: null, days_of_week: [1, 2, 3, 4, 5] };
const custom: PactRow = { ...base, kind: 'custom', period: 'daily', goal_value: 1, goal_unit: 'count', activity_types: null };
const showUp: PactRow = { ...base, kind: 'show_up', period: 'daily', goal_value: null, goal_unit: null, activity_types: null };

describe('units', () => {
  it('miles for US-style locales, kilometres elsewhere', () => {
    expect(distanceUnitForLocale('en-US')).toBe('mi');
    expect(distanceUnitForLocale('en-GB')).toBe('mi');
    expect(distanceUnitForLocale('en-LR')).toBe('mi');
    expect(distanceUnitForLocale('de-DE')).toBe('km');
    expect(distanceUnitForLocale('en-CA')).toBe('km');
    expect(distanceUnitForLocale('fr')).toBe('km');
    expect(distanceUnitForLocale(undefined)).toBe('km');
  });

  it('converts both ways and stores whole metres', () => {
    expect(METERS_PER_MILE).toBe(1609.344);
    expect(unitToMeters(15, 'mi')).toBe(24140);
    expect(unitToMeters(10, 'km')).toBe(10000);
    expect(metersToUnit(24140, 'mi')).toBeCloseTo(15, 1);
    expect(metersToUnit(5000, 'km')).toBe(5);
  });

  it('formats distances to one decimal with the unit', () => {
    expect(formatDistance(18024, 'mi')).toBe('11.2 mi');
    expect(formatDistance(24140, 'mi')).toBe('15.0 mi');
    expect(formatDistance(0, 'km')).toBe('0.0 km');
    expect(formatDistance(10000, 'km')).toBe('10.0 km');
  });

  it('formats durations and pace', () => {
    expect(formatDuration(2710)).toBe('45:10');
    expect(formatDuration(3750)).toBe('1:02:30');
    expect(formatDuration(59)).toBe('0:59');
    expect(paceText(8046.72, 2610, 'mi')).toBe('8:42 /mi');
    expect(paceText(5000, 1500, 'km')).toBe('5:00 /km');
    expect(paceText(0, 1500, 'km')).toBeNull();
    expect(paceText(5000, 0, 'km')).toBeNull();
  });
});

describe('goal copy', () => {
  it('knows which kinds are goals and reads the goal as a number, even when PostgREST sends a string', () => {
    expect(isGoalKind('show_up')).toBe(false);
    for (const k of ['distance', 'workouts', 'steps', 'custom'] as const) expect(isGoalKind(k)).toBe(true);
    expect(goalValue(base)).toBe(24140);
    expect(goalValue(workouts)).toBe(3);
    expect(goalValue(showUp)).toBe(0);
  });

  it('says the goal in the pact unit, per period', () => {
    expect(goalLabel(base, 'mi')).toBe('15.0 mi a week');
    expect(goalLabel({ ...base, period: 'once', race_start: '2026-11-21', race_end: '2026-11-22' }, 'km')).toBe('24.1 km by Nov 22');
    expect(goalLabel(workouts, 'mi')).toBe('3 workouts a week');
    expect(goalLabel(steps, 'mi')).toBe('10,000 steps a day');
    expect(goalLabel(custom, 'mi')).toBe('Done every day');
    expect(goalLabel({ ...custom, period: 'weekly' }, 'mi')).toBe('Done every week');
  });

  it('value / goal in one line', () => {
    expect(formatGoalValue(base, 18024, 'mi')).toBe('11.2 / 15.0 mi');
    expect(formatGoalValue(workouts, 2, 'mi')).toBe('2 / 3 workouts');
    expect(formatGoalValue(steps, 7500, 'mi')).toBe('7,500 / 10,000 steps');
    expect(formatGoalValue(custom, 1, 'mi')).toBe('Done');
    expect(formatGoalValue(custom, 0, 'mi')).toBe('Not marked yet');
  });

  it('what is left, and the fraction', () => {
    expect(toGoText(base, 18024, 'mi')).toBe('3.8 mi to go');
    expect(toGoText(base, 24140, 'mi')).toBe('Reached');
    expect(toGoText(base, 26554, 'mi')).toBe('Reached');
    expect(toGoText(workouts, 2, 'mi')).toBe('1 workout to go');
    expect(toGoText(workouts, 0, 'mi')).toBe('3 workouts to go');
    expect(toGoText(steps, 7500, 'mi')).toBe('2,500 steps to go');
    expect(progressFraction(18024, 24140)).toBeCloseTo(0.7466, 3);
    expect(progressFraction(30000, 24140)).toBe(1);
    expect(progressFraction(5, 0)).toBe(0);
  });

  it('time left in days, then hours, then minutes', () => {
    const t = Date.parse('2026-11-13T18:00:00Z');
    expect(timeLeftText('2026-11-16T08:00:00Z', t)).toBe('2 days left');
    expect(timeLeftText('2026-11-14T20:00:00Z', t)).toBe('1 day left');
    expect(timeLeftText('2026-11-14T00:30:00Z', t)).toBe('6 hr left');
    expect(timeLeftText('2026-11-13T18:25:00Z', t)).toBe('25 min left');
    expect(timeLeftText('2026-11-13T17:00:00Z', t)).toBe('Closed');
  });

  it('the header line: value, to go, time left', () => {
    const t = Date.parse('2026-11-13T18:00:00Z');
    expect(progressHeadline(base, 18024, 'mi', '2026-11-16T08:00:00Z', t)).toBe('11.2 / 15.0 mi · 3.8 mi to go · 2 days left');
    expect(progressHeadline(base, 24140, 'mi', '2026-11-16T08:00:00Z', t)).toBe('15.0 / 15.0 mi · Reached');
    expect(progressHeadline(base, 19470, 'mi', '2026-11-13T17:00:00Z', t)).toBe('12.1 / 15.0 mi · 2.9 mi short');
  });
});

describe('standings copy', () => {
  const nameOf = (id: string) => ({ you: 'You', maya: 'Maya Chen', diego: 'Diego Alvarez', priya: 'Priya Nair' })[id] ?? 'Someone';
  const standings = [
    { instance_id: 'w', user_id: 'maya', rank: 1, value: 26554, goal: 24140, reached_at: '2026-11-12T10:00:00Z' },
    { instance_id: 'w', user_id: 'you', rank: 2, value: '18024', goal: '24140', reached_at: null },
    { instance_id: 'w', user_id: 'diego', rank: 3, value: 6437, goal: 24140, reached_at: null },
    { instance_id: 'w', user_id: 'priya', rank: 4, value: 0, goal: 24140, reached_at: null },
  ];

  it('ordinals and rank lines', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
    expect(rankLine(2, 4)).toBe('2nd of 4');
  });

  it('the group home line: leader, your place, what you have left', () => {
    expect(standingsSummary(standings, 'you', nameOf, base, 'mi')).toBe("Maya leads · you're 2nd · 3.8 mi to go");
    expect(standingsSummary(standings, 'maya', nameOf, base, 'mi')).toBe("You lead · 3 behind you");
    expect(standingsSummary(standings, 'priya', nameOf, base, 'mi')).toBe("Maya leads · you're 4th · 15.0 mi to go");
    expect(standingsSummary(standings, 'nobody', nameOf, base, 'mi')).toBe('Maya leads · 1 of 4 reached');
    expect(standingsSummary([], 'you', nameOf, base, 'mi')).toBe('Nobody has logged a run yet');
    expect(standingsSummary([{ ...standings[0]!, user_id: 'you' }], 'you', nameOf, base, 'mi')).toBe('You lead · reached');
  });
});

describe('activity rows', () => {
  const row = (over: Partial<PactActivityRow> = {}): PactActivityRow => ({
    pact_id: 'p7',
    instance_id: 'w',
    user_id: 'you',
    activity_id: 'a1',
    source: 'healthkit',
    activity_type: 'running',
    started_at: '2026-11-12T14:00:00Z',
    ended_at: '2026-11-12T14:45:10Z',
    distance_m: 8046.72,
    duration_s: 2710,
    steps: null,
    device: 'Apple Watch',
    app_bundle: 'com.apple.health',
    is_manual: false,
    verdict: 'accepted',
    reject_reason: null,
    ...over,
  });

  it('labels types and sources in plain words', () => {
    expect(activityTypeLabel('running')).toBe('Run');
    expect(activityTypeLabel('cycling')).toBe('Ride');
    expect(activityTypeLabel('strength')).toBe('Strength');
    expect(activityTypeLabel('whatever')).toBe('Workout');
    expect(sourceLabel('healthkit')).toBe('Apple Health');
    expect(sourceLabel('strava')).toBe('Strava');
    expect(sourceLabel('manual')).toBe('Manual');
  });

  it('distance, duration and pace for a run; duration only for a strength session; steps for a step day', () => {
    expect(activityLine(row(), 'mi')).toBe('5.0 mi · 45 min · 9:02 /mi');
    expect(activityLine(row({ activity_type: 'strength', distance_m: null, duration_s: 1800 }), 'mi')).toBe('30 min');
    // an 8-minute session must not read as 8 o'clock (audit, day 2)
    expect(activityLine(row({ activity_type: 'strength', distance_m: null, duration_s: 480 }), 'mi')).toBe('8 min');
    expect(formatDurationWords(3900)).toBe('1 hr 5 min');
    expect(formatDurationWords(3600)).toBe('1 hr');
    expect(formatDurationWords(40)).toBe('40 sec');
    expect(tooShortText(600)).toBe("Under 10 minutes · doesn't count");
    expect(evidenceNoun({ kind: 'distance', activity_types: ['running'] })).toBe('runs');
    expect(evidenceNoun({ kind: 'distance', activity_types: ['cycling'] })).toBe('rides');
    expect(evidenceNoun({ kind: 'distance', activity_types: ['running', 'walking'] })).toBe('walks and runs');
    expect(evidenceNoun({ kind: 'workouts', activity_types: ['running', 'yoga'] })).toBe('workouts');
    expect(evidenceNoun({ kind: 'steps', activity_types: null })).toBe('steps');
    expect(activityLine(row({ activity_type: 'walking', distance_m: null, duration_s: 0, steps: 10432 }), 'mi')).toBe('10,432 steps');
  });

  it('says plainly why a row did not count', () => {
    expect(rejectionText(row({ verdict: 'rejected_manual', is_manual: true }), 'mi')).toBe("A manually entered 5.0 mi run from Apple Health doesn't count");
    expect(rejectionText(row({ verdict: 'rejected_duplicate', source: 'strava' }), 'mi')).toBe('Already counted from another source');
    expect(rejectionText(row({ verdict: 'rejected_type', activity_type: 'cycling' }), 'mi')).toBe("Rides don't count in this challenge");
    expect(rejectionText(row({ verdict: 'rejected_future' }), 'mi')).toBe('Ends in the future');
    expect(rejectionText(row(), 'mi')).toBeNull();
  });
});
