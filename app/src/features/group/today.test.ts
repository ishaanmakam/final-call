import { describe, expect, it } from 'vitest';
import type { PactRow } from '../../api/types';
import type { InstanceSummary } from '../../lib/instanceStatus';
import { checkedInIds, closedTimingText, myPillState, nothingTodayBody, openTimingPrefix, pactDetailLine, resultTally, todayStatusLine } from './today';

const summary = (byUser: InstanceSummary['byUser']): InstanceSummary => {
  const counted = Object.values(byUser).filter((s) => !['frozen', 'void', 'excluded'].includes(s));
  const checkedIn = counted.filter((s) => s === 'checked_in' || s === 'success').length;
  return { byUser, total: counted.length, checkedIn, label: `${checkedIn} of ${counted.length} checked in` };
};

describe('todayStatusLine', () => {
  it('counts, and folds you in when you are', () => {
    expect(todayStatusLine(summary({ a: 'checked_in', b: 'waiting', c: 'waiting', d: 'waiting' }), 'waiting')).toBe('1 of 4 checked in');
    expect(todayStatusLine(summary({ a: 'checked_in', b: 'checked_in', c: 'waiting', d: 'waiting' }), 'checked_in')).toBe("You're in · 2 of 4");
    expect(todayStatusLine(summary({ a: 'checked_in', b: 'checked_in' }), 'checked_in')).toBe("Everyone's in");
    expect(todayStatusLine(summary({ a: 'waiting', b: 'waiting' }), 'waiting')).toBe('Nobody yet');
    expect(todayStatusLine(summary({ a: 'frozen' }), 'frozen')).toBe('Nobody is in this one yet');
  });
});

describe('resultTally and pills', () => {
  it('tallies a closed day in glossary words', () => {
    expect(resultTally(summary({ a: 'success', b: 'frozen', c: 'failed', d: 'unverified' }))).toBe('1 showed up · 1 missed · 1 unverified · 1 frozen');
  });
  it('rings whoever is in', () => {
    expect(checkedInIds(summary({ a: 'checked_in', b: 'waiting', c: 'success' }))).toEqual(['a', 'c']);
  });
  it('shows your pill only when it says something', () => {
    expect(myPillState('waiting', false)).toBeNull();
    expect(myPillState('checked_in', false)).toBeNull();
    expect(myPillState('out_of_fence', false)).toBe('out_of_fence');
    expect(myPillState('frozen', false)).toBe('frozen');
    expect(myPillState('success', true)).toBe('success');
    expect(myPillState(null, true)).toBeNull();
  });
});

describe('nothingTodayBody', () => {
  const pact = (over: Partial<PactRow>): PactRow => ({
    id: 'p',
    group_id: 'g',
    title: '9am in Kane Hall',
    days_of_week: [1, 2, 3, 4, 5],
    window_open_local: '08:00:00',
    deadline_local: '09:00:00',
    stake_cents: 500,
    tz: 'America/Los_Angeles',
    paused: false,
    created_by: 'u',
    created_at: '2026-01-01T00:00:00Z',
    kind: 'show_up',
    period: 'daily',
    goal_value: null,
    goal_unit: null,
    activity_types: null,
    race_start: null,
    race_end: null,
  proof_required: false,
    ...over,
  });
  // Sat Nov 14 2026, 10:00 PST
  const saturday = Date.parse('2026-11-14T18:00:00Z');
  it('names the soonest active pact and day', () => {
    expect(nothingTodayBody([pact({}), pact({ id: 'q', title: 'Sunrise run', days_of_week: [7], deadline_local: '07:00:00' })], saturday)).toBe('Next: Sunrise run, Sun by 7:00 AM.');
  });
  it('skips paused pacts and copes with none', () => {
    expect(nothingTodayBody([pact({ paused: true })], saturday)).toBe('Nothing scheduled this week.');
    expect(nothingTodayBody([], saturday)).toBe('Nothing scheduled this week.');
  });
});

it('pactDetailLine says pledge, never stake', () => {
  expect(pactDetailLine('Weekdays', '09:00:00', '$5.00')).toBe('Weekdays · by 9:00 AM · $5.00 pledge');
});

describe('timing line voice', () => {
  it('Boarding, then Final call from fifteen minutes out, then Gate closed', () => {
    expect(openTimingPrefix(54 * 60_000 + 12_000)).toBe('Boarding');
    expect(openTimingPrefix(15 * 60_000 + 1)).toBe('Boarding');
    expect(openTimingPrefix(15 * 60_000)).toBe('Final call');
    expect(openTimingPrefix(42_000)).toBe('Final call');
    expect(openTimingPrefix(0)).toBe('Boarding');
    expect(closedTimingText('9:00 AM')).toBe('Gate closed 9:00 AM');
  });
});
