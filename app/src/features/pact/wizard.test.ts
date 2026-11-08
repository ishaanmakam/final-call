import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAFT,
  QUICK_PICKS,
  WINDOW_PRESETS,
  activeQuickPick,
  applyQuickPick,
  dateToMinutes,
  describeWindow,
  isDraftDirty,
  minutesToDate,
  offsetLabel,
  presetLabel,
  toggleDay,
  validatePledge,
  validateWhat,
  validateWhen,
  windowOpenMinutes,
} from './wizard';

describe('days', () => {
  it('toggles a day in and out, keeping ISO order', () => {
    expect(toggleDay([1, 2, 3], 7)).toEqual([1, 2, 3, 7]);
    expect(toggleDay([1, 2, 3, 7], 2)).toEqual([1, 3, 7]);
    expect(toggleDay([3, 1], 2)).toEqual([1, 2, 3]);
  });

  it('quick picks set the whole week shape and read back which one is active', () => {
    expect(applyQuickPick('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(applyQuickPick('weekends')).toEqual([6, 7]);
    expect(applyQuickPick('everyday')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(activeQuickPick([5, 4, 3, 2, 1])).toBe('weekdays');
    expect(activeQuickPick([7, 6])).toBe('weekends');
    expect(activeQuickPick([1, 2, 3, 4, 5, 6, 7])).toBe('everyday');
    expect(activeQuickPick([1, 3, 5])).toBeNull();
    expect(QUICK_PICKS.map((q) => q.label)).toEqual(['Weekdays', 'Weekends', 'Every day']);
  });
});

describe('window presets', () => {
  it('derives the open time from the deadline and a preset', () => {
    expect(windowOpenMinutes(9 * 60, 60)).toBe(8 * 60);
    expect(windowOpenMinutes(9 * 60, 15)).toBe(8 * 60 + 45);
    // crosses midnight: not the same local day, so the open is reported as invalid (negative)
    expect(windowOpenMinutes(30, 60)).toBe(-30);
  });

  it('labels presets and custom offsets in plain words', () => {
    expect(WINDOW_PRESETS).toEqual([15, 30, 60, 120]);
    expect(presetLabel(15)).toBe('15 min');
    expect(presetLabel(60)).toBe('1 hr');
    expect(presetLabel(120)).toBe('2 hr');
    expect(offsetLabel(8 * 60, 9 * 60)).toBe('1 hr before');
    expect(offsetLabel(8 * 60 + 30, 9 * 60)).toBe('30 min before');
    expect(offsetLabel(7 * 60 + 30, 9 * 60)).toBe('1 hr 30 min before');
    expect(describeWindow(8 * 60, 9 * 60)).toBe('8:00 AM to 9:00 AM');
  });

  it('converts between minutes after midnight and a Date for the native picker', () => {
    const d = minutesToDate(9 * 60 + 5);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(5);
    expect(dateToMinutes(d)).toBe(9 * 60 + 5);
    expect(dateToMinutes(minutesToDate(0))).toBe(0);
    expect(dateToMinutes(minutesToDate(23 * 60 + 59))).toBe(23 * 60 + 59);
  });
});

describe('validation copy', () => {
  it('step 1 needs a title and at least one day', () => {
    expect(validateWhat({ title: ' ', days: [1] })).toEqual({ title: 'Give the pact a title, like "9am class".' });
    expect(validateWhat({ title: 'a', days: [1] })).toEqual({ title: 'Give the pact a title, like "9am class".' });
    expect(validateWhat({ title: '9am class', days: [] })).toEqual({ days: 'Pick at least one day.' });
    expect(validateWhat({ title: '9am class', days: [1] })).toEqual({});
  });

  it('step 2 needs the window to open before the deadline on the same day', () => {
    expect(validateWhen({ windowOpen: 8 * 60, deadline: 9 * 60, tz: 'America/Los_Angeles' })).toEqual({});
    expect(validateWhen({ windowOpen: 9 * 60, deadline: 9 * 60, tz: 'America/Los_Angeles' })).toEqual({
      window: 'The window must open before the deadline on the same day.',
    });
    expect(validateWhen({ windowOpen: -30, deadline: 30, tz: 'America/Los_Angeles' })).toEqual({
      window: 'The window must open before the deadline on the same day.',
    });
    expect(validateWhen({ windowOpen: 8 * 60, deadline: 9 * 60, tz: 'Mars/Olympus' })).toEqual({
      tz: 'Pick a time zone from the list.',
    });
  });

  it('step 3 needs a dollar amount between $0.01 and $100.00', () => {
    expect(validatePledge('abc')).toEqual({ amount: 'Enter a dollar amount like 5 or 2.50.' });
    expect(validatePledge('')).toEqual({ amount: 'Enter a dollar amount like 5 or 2.50.' });
    expect(validatePledge('0')).toEqual({ amount: 'Pledge must be between $0.01 and $100.00.' });
    expect(validatePledge('100.01')).toEqual({ amount: 'Pledge must be between $0.01 and $100.00.' });
    expect(validatePledge('5')).toEqual({});
    expect(validatePledge('$2.50')).toEqual({});
  });
});

describe('draft', () => {
  it('defaults to weekdays, 8 to 9, $5, and knows when the person has typed something', () => {
    expect(DEFAULT_DRAFT.days).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_DRAFT.deadline).toBe(9 * 60);
    expect(DEFAULT_DRAFT.windowOffset).toBe(60);
    expect(DEFAULT_DRAFT.dollars).toBe('5.00');
    expect(isDraftDirty(DEFAULT_DRAFT)).toBe(false);
    expect(isDraftDirty({ ...DEFAULT_DRAFT, title: 'x' })).toBe(true);
    expect(isDraftDirty({ ...DEFAULT_DRAFT, days: [1] })).toBe(true);
    expect(isDraftDirty({ ...DEFAULT_DRAFT, dollars: '5.00' })).toBe(false);
  });
});

describe('season toggle', () => {
  it('is off by default, marks the draft dirty, and asks for 4 weeks from the coming Monday in the pact zone', async () => {
    const { draftSeason } = await import('./wizard');
    expect(DEFAULT_DRAFT.season).toBe(false);
    expect(isDraftDirty({ ...DEFAULT_DRAFT, season: true })).toBe(true);
    expect(draftSeason({ season: false, tz: 'America/Los_Angeles' }, Date.parse('2026-11-07T20:00:00Z'))).toBeNull();
    // Saturday 7 Nov 2026 in Los Angeles: the coming Monday is the 9th
    expect(draftSeason({ season: true, tz: 'America/Los_Angeles' }, Date.parse('2026-11-07T20:00:00Z'))).toEqual({ start: '2026-11-09', weeks: 4 });
    // 23:30 Sunday in Kolkata is already Monday 02:00 in Sydney: the zone decides the date
    expect(draftSeason({ season: true, tz: 'Australia/Sydney' }, Date.parse('2026-11-08T18:00:00Z'))?.start).toBe('2026-11-09');
    expect(draftSeason({ season: true, tz: 'Asia/Kolkata' }, Date.parse('2026-11-08T18:00:00Z'))?.start).toBe('2026-11-09');
    // 09:00Z Tuesday is still Monday 23:00 in Honolulu (today counts); two hours later it is Tuesday there
    expect(draftSeason({ season: true, tz: 'Pacific/Honolulu' }, Date.parse('2026-11-10T09:00:00Z'))?.start).toBe('2026-11-09');
    expect(draftSeason({ season: true, tz: 'Pacific/Honolulu' }, Date.parse('2026-11-10T11:00:00Z'))?.start).toBe('2026-11-16');
    expect(draftSeason({ season: true, tz: 'nope/zone' }, Date.now())).toBeNull();
  });
});
