import { describe, expect, it } from 'vitest';
import type { PactActivityRow, PactInstanceRow, PactRow } from '../../api/types';
import {
  FINAL_CALL_WEEKLY_LOCAL,
  currentLocalDate,
  mondayOf,
  progressRows,
  standingsFrom,
  summaryFromProgress,
  weekTimingLine,
  weeklyFinalCallAt,
} from './progress';

const TZ = 'America/Los_Angeles';
const pact: PactRow = {
  id: 'p7',
  group_id: 'g1',
  title: '15 miles a week',
  days_of_week: [],
  window_open_local: '00:00:00',
  deadline_local: '23:59:00',
  stake_cents: 500,
  tz: TZ,
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
// Mon 9 Nov 2026 00:00 PST → Mon 16 Nov 00:00 PST
const week: PactInstanceRow = {
  id: 'w',
  pact_id: 'p7',
  local_date: '2026-11-09',
  window_open_at: '2026-11-09T08:00:00Z',
  deadline_at: '2026-11-16T08:00:00Z',
  status: 'open',
  carry_in_cents: null,
  closed_at: null,
  deadline_soon_sent_at: null,
};
const act = (over: Partial<PactActivityRow>): PactActivityRow => ({
  pact_id: 'p7',
  instance_id: 'w',
  user_id: 'you',
  activity_id: Math.random().toString(36).slice(2),
  source: 'healthkit',
  activity_type: 'running',
  started_at: '2026-11-10T14:00:00Z',
  ended_at: '2026-11-10T14:40:00Z',
  distance_m: 8046,
  duration_s: 2400,
  steps: null,
  device: null,
  app_bundle: null,
  is_manual: false,
  verdict: 'accepted',
  reject_reason: null,
  ...over,
});

describe('periods', () => {
  it('Monday of a local date, and the instance date for each period', () => {
    expect(mondayOf('2026-11-13')).toBe('2026-11-09');
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');
    const fri = Date.parse('2026-11-13T18:00:00Z'); // Fri 10:00 PST
    expect(currentLocalDate(pact, fri)).toBe('2026-11-09');
    expect(currentLocalDate({ ...pact, period: 'daily' }, fri)).toBe('2026-11-13');
    expect(currentLocalDate({ ...pact, period: 'once', race_start: '2026-11-21', race_end: '2026-11-22' }, fri)).toBe('2026-11-21');
  });

  it('the weekly Final call is Sunday 18:00 in the pact zone', () => {
    expect(FINAL_CALL_WEEKLY_LOCAL).toBe('18:00:00');
    expect(new Date(weeklyFinalCallAt(week, TZ)).toISOString()).toBe('2026-11-16T02:00:00.000Z');
  });

  it('Boarding with days left, Final call from Sunday 6 PM, Gate closed after Monday 00:00', () => {
    expect(weekTimingLine(week, TZ, Date.parse('2026-11-13T18:00:00Z'))).toEqual({ prefix: 'Boarding', text: 'Boarding · 2 days left · ends Sunday night' });
    expect(weekTimingLine(week, TZ, Date.parse('2026-11-16T03:00:00Z'))).toEqual({ prefix: 'Final call', text: 'Final call · 5 hr left · ends Sunday night' });
    expect(weekTimingLine(week, TZ, Date.parse('2026-11-16T07:40:00Z'))).toEqual({ prefix: 'Final call', text: 'Final call · 20 min left · ends Sunday night' });
    expect(weekTimingLine(week, TZ, Date.parse('2026-11-16T09:00:00Z'))).toEqual({ prefix: 'Gate closed', text: 'Gate closed · week of Nov 9' });
    expect(weekTimingLine(week, TZ, Date.parse('2026-11-08T09:00:00Z'))).toEqual({ prefix: 'Boarding', text: 'Starts Monday' });
  });
});

describe('progressRows (the demo stand-in for instance_progress)', () => {
  it('sums accepted distance of allowed types inside the window and marks when the goal was crossed', () => {
    const rows = progressRows(
      week,
      pact,
      ['you', 'maya'],
      [
        act({ user_id: 'you', distance_m: 8046 }),
        act({ user_id: 'you', distance_m: 9978, started_at: '2026-11-12T14:00:00Z', ended_at: '2026-11-12T15:00:00Z' }),
        act({ user_id: 'you', distance_m: 5000, verdict: 'rejected_manual' }),
        act({ user_id: 'you', distance_m: 5000, activity_type: 'cycling' }),
        act({ user_id: 'you', distance_m: 5000, started_at: '2026-11-08T14:00:00Z', ended_at: '2026-11-08T15:00:00Z' }),
        act({ user_id: 'maya', distance_m: 16000, started_at: '2026-11-10T14:00:00Z', ended_at: '2026-11-10T16:00:00Z' }),
        act({ user_id: 'maya', distance_m: 10554, started_at: '2026-11-12T14:00:00Z', ended_at: '2026-11-12T15:30:00Z' }),
      ],
    );
    expect(rows).toEqual([
      { instance_id: 'w', user_id: 'you', value: 18024, goal: 24140, activity_count: 2, reached_at: null },
      { instance_id: 'w', user_id: 'maya', value: 26554, goal: 24140, activity_count: 2, reached_at: '2026-11-12T15:30:00Z' },
    ]);
  });

  it('counts workouts of at least ten minutes, and sums steps', () => {
    const w: PactRow = { ...pact, kind: 'workouts', goal_value: 3, goal_unit: 'count', activity_types: ['running', 'strength'] };
    const rows = progressRows(week, w, ['you'], [
      act({ duration_s: 1800, activity_type: 'strength', distance_m: null }),
      act({ duration_s: 500 }),
      act({ duration_s: 600, started_at: '2026-11-11T14:00:00Z', ended_at: '2026-11-11T14:10:00Z' }),
    ]);
    expect(rows[0]).toMatchObject({ value: 2, activity_count: 2, reached_at: null });
    const s: PactRow = { ...pact, kind: 'steps', period: 'daily', goal_value: 10000, goal_unit: 'steps', activity_types: null };
    const day = { ...week, deadline_at: '2026-11-11T08:00:00Z' };
    expect(progressRows(day, s, ['you'], [act({ activity_type: 'steps', steps: 6000, distance_m: null }), act({ activity_type: 'steps', steps: 4500, distance_m: null, ended_at: '2026-11-10T20:00:00Z' }), act({ activity_type: 'walking', steps: 900, distance_m: null })])[0]).toMatchObject({
      value: 10500,
      reached_at: '2026-11-10T20:00:00Z',
    });
  });

  it('ranks whoever reached first (by reached_at), then the rest by value, then user id (the view)', () => {
    const standings = standingsFrom([
      { instance_id: 'w', user_id: 'b', value: 10, goal: 10, activity_count: 1, reached_at: '2026-11-10T10:00:00Z' },
      { instance_id: 'w', user_id: 'a', value: 10, goal: 10, activity_count: 1, reached_at: '2026-11-09T10:00:00Z' },
      { instance_id: 'w', user_id: 'c', value: 12, goal: 10, activity_count: 1, reached_at: '2026-11-11T10:00:00Z' },
      { instance_id: 'w', user_id: 'e', value: 4, goal: 10, activity_count: 1, reached_at: null },
      { instance_id: 'w', user_id: 'd', value: 0, goal: 10, activity_count: 0, reached_at: null },
      { instance_id: 'w', user_id: 'f', value: 4, goal: 10, activity_count: 1, reached_at: null },
    ]);
    expect(standings.map((s) => [s.rank, s.user_id])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [4, 'e'],
      [5, 'f'],
      [6, 'd'],
    ]);
  });

  it('folds progress into the live summary: reached counts like checked in, results win once posted', () => {
    const summary = summaryFromProgress(
      ['you', 'maya', 'diego'],
      week.deadline_at,
      [
        { instance_id: 'w', user_id: 'you', value: 18024, goal: 24140, activity_count: 2, reached_at: null },
        { instance_id: 'w', user_id: 'maya', value: 26554, goal: 24140, activity_count: 2, reached_at: '2026-11-12T15:30:00Z' },
      ],
      [{ user_id: 'diego', status: 'frozen' }],
    );
    expect(summary.byUser).toEqual({ you: 'waiting', maya: 'checked_in', diego: 'frozen' });
    expect(summary.checkedIn).toBe(1);
    expect(summary.total).toBe(2);
  });
});
