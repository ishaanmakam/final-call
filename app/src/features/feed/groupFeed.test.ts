import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../../api/queries';
import type { PactInstanceRow, PactRow, ProfileRow, ResultStatus } from '../../api/types';
import {
  carryNote,
  excludedFootnote,
  groupFeedByDay,
  instanceSubtitle,
  instanceSummary,
  joinNames,
  personDetail,
  type Namer,
} from './groupFeed';

const TZ = 'America/Los_Angeles';
const pact: PactRow = {
  id: 'p1',
  group_id: 'g',
  title: '9am in Kane Hall',
  days_of_week: [1, 2, 3, 4, 5],
  window_open_local: '08:00:00',
  deadline_local: '09:00:00',
  stake_cents: 500,
  tz: TZ,
  paused: false,
  created_by: 'me',
  created_at: '2026-10-01T00:00:00Z',
};

const instance = (id: string, localDate: string, deadlineIso: string, extra: Partial<PactInstanceRow> = {}): PactInstanceRow => ({
  id,
  pact_id: pact.id,
  local_date: localDate,
  window_open_at: deadlineIso,
  deadline_at: deadlineIso,
  status: 'closed',
  carry_in_cents: 0,
  closed_at: deadlineIso,
  deadline_soon_sent_at: null,
  ...extra,
});

const profiles = new Map<string, ProfileRow>([
  ['me', { id: 'me', display_name: 'Sam Okafor', venmo_username: null, created_at: '' }],
  ['maya', { id: 'maya', display_name: 'Maya Chen', venmo_username: null, created_at: '' }],
  ['diego', { id: 'diego', display_name: 'Diego Alvarez', venmo_username: null, created_at: '' }],
  ['priya', { id: 'priya', display_name: 'Priya Nair', venmo_username: null, created_at: '' }],
]);
const n: Namer = { userId: 'me', profiles };

const item = (inst: PactInstanceRow, user: string, status: ResultStatus, firstSuccessAt: string | null = null): FeedItem => ({
  result: { instance_id: inst.id, user_id: user, status, first_success_at: firstSuccessAt, decided_at: inst.deadline_at },
  instance: inst,
  pact,
  reviews: [],
});

// Mon Nov 10 2026 09:00 PST = 17:00Z
const mon = instance('i-mon', '2026-11-10', '2026-11-10T17:00:00Z');
const tue = instance('i-tue', '2026-11-11', '2026-11-11T17:00:00Z');

describe('groupFeedByDay', () => {
  it('groups by local date newest first and puts you first inside an instance', () => {
    const items = [
      item(mon, 'priya', 'success'),
      item(tue, 'diego', 'failed'),
      item(mon, 'me', 'success'),
      item(mon, 'diego', 'failed'),
      item(tue, 'me', 'success'),
    ];
    const days = groupFeedByDay(items, n);
    expect(days.map((d) => d.key)).toEqual(['2026-11-11', '2026-11-10']);
    expect(days[0]!.title).toBe('Wed, Nov 11');
    const monday = days[1]!.data[0]!;
    expect(monday.items.map((i) => i.result.user_id)).toEqual(['me', 'diego', 'priya']);
    expect(monday.counts.success).toBe(2);
    expect(monday.counts.failed).toBe(1);
    expect(monday.poolCents).toBe(500);
  });

  it('adds carry-in to the pool and reports it', () => {
    const withCarry = instance('i-c', '2026-11-12', '2026-11-12T17:00:00Z', { carry_in_cents: 1000 });
    const [day] = groupFeedByDay([item(withCarry, 'me', 'success'), item(withCarry, 'diego', 'failed')], n);
    const g = day!.data[0]!;
    expect(g.poolCents).toBe(1500);
    expect(carryNote(g)).toBe('Includes $10.00 carried over from days nobody made it.');
  });

  it('moves no money when nobody missed and nothing was carried', () => {
    const [day] = groupFeedByDay([item(mon, 'me', 'success'), item(mon, 'maya', 'unverified')], n);
    const g = day!.data[0]!;
    expect(g.poolCents).toBe(0);
    expect(carryNote(g)).toBeNull();
  });
});

describe('instanceSummary', () => {
  it('names who missed and where the pool went, in pool words', () => {
    const [day] = groupFeedByDay(
      [item(mon, 'me', 'success'), item(mon, 'maya', 'success'), item(mon, 'priya', 'success'), item(mon, 'diego', 'failed')],
      n,
    );
    expect(instanceSummary(day!.data[0]!, n)).toBe('3 showed up · Diego missed. Pool $5.00 to you, Maya and Priya.');
  });

  it('says the pool carries over when nobody showed up', () => {
    const [day] = groupFeedByDay([item(mon, 'me', 'failed'), item(mon, 'diego', 'failed')], n);
    expect(instanceSummary(day!.data[0]!, n)).toBe(
      'You and Diego missed. Nobody showed up, so the $10.00 pool carries over to the next day someone does.',
    );
  });

  it('says no money moved for unverified and frozen days', () => {
    const [day] = groupFeedByDay([item(mon, 'me', 'success'), item(mon, 'priya', 'unverified'), item(mon, 'maya', 'frozen')], n);
    expect(instanceSummary(day!.data[0]!, n)).toBe('1 showed up · Priya unverified · Maya frozen. No money moved.');
  });

  it('explains a void day', () => {
    const voided = instance('i-v', '2026-11-13', '2026-11-13T17:00:00Z', { status: 'voided', carry_in_cents: null });
    const [day] = groupFeedByDay([item(voided, 'me', 'void'), item(voided, 'priya', 'void')], n);
    expect(instanceSummary(day!.data[0]!, n)).toBe("Didn't count: fewer than two people were in it. No money moved.");
    expect(day!.data[0]!.poolCents).toBe(0);
  });

  it('never uses code words', () => {
    const [day] = groupFeedByDay([item(mon, 'me', 'success'), item(mon, 'diego', 'failed')], n);
    const text = `${instanceSummary(day!.data[0]!, n)} ${instanceSubtitle(day!.data[0]!)}`;
    expect(text).not.toMatch(/\b(stake|pot|bet|wager|rake)\b/i);
    expect(instanceSubtitle(day!.data[0]!)).toBe('9:00 AM · $5.00 pledge');
  });
});

describe('personDetail', () => {
  it('describes each result in pledge words', () => {
    const [day] = groupFeedByDay(
      [
        item(mon, 'me', 'success', '2026-11-10T16:41:00Z'),
        item(mon, 'diego', 'failed'),
        item(mon, 'priya', 'unverified'),
        item(mon, 'maya', 'excluded'),
      ],
      n,
    );
    const g = day!.data[0]!;
    const by = (id: string) => personDetail(g.items.find((i) => i.result.user_id === id)!, g);
    expect(by('me')).toBe('Counted at 8:41 AM · shares the pool');
    expect(by('diego')).toBe('Forfeited $5.00 to the pool');
    expect(by('priya')).toBe('No money moved');
    expect(by('maya')).toBe('No money moved');
  });

  it('omits the pool share when nothing was in it', () => {
    const [day] = groupFeedByDay([item(mon, 'me', 'success', '2026-11-10T16:41:00Z'), item(mon, 'maya', 'success')], n);
    const g = day!.data[0]!;
    expect(personDetail(g.items[0]!, g)).toBe('Counted at 8:41 AM');
    expect(personDetail(g.items[1]!, g)).toBeUndefined();
  });
});

describe('names', () => {
  it('joins with commas and "and"', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Maya'])).toBe('Maya');
    expect(joinNames(['Maya', 'you'])).toBe('Maya and you');
    expect(joinNames(['Maya', 'Priya', 'you'])).toBe('Maya, Priya and you');
  });

  it('writes the excluded footnote, most first, or nothing', () => {
    expect(excludedFootnote(new Map(), n)).toBeNull();
    expect(excludedFootnote(new Map([['diego', 1], ['priya', 2]]), n)).toMatch(/^Excluded this month: Priya Nair 2, Diego Alvarez 1\./);
  });
});
