import { describe, expect, it } from 'vitest';
import { COMPLETION_FOOTNOTE, completionHeadline, completionLine, completionPercent, completionTone, openCount, weeksLine } from './completion';
import { firstName, longestStreak, memberRecapLine, netTone, netWord, recapSentence, sortRecaps, type RecapRow } from './recap';
import {
  DEFAULT_SEASON_WEEKS,
  SEASON_WEEK_OPTIONS,
  daysBetween,
  formatLocalDay,
  nextMonday,
  seasonDetailLine,
  seasonEnd,
  seasonOf,
  seasonProgress,
  seasonProgressLine,
  seasonShortLabel,
  seasonSummary,
} from './season';
import { sortStreaks, streakAccessibilityLabel, streakFor, streakLine, streakValue } from './streak';

const nameOf = (id: string) => ({ you: 'Sam Okafor', maya: 'Maya Chen', diego: 'Diego Alvarez' })[id] ?? 'Someone';

describe('season window', () => {
  it('reads the pact columns and computes the finish line as start + 7 × weeks − 1', () => {
    expect(seasonOf({ season_start: null, season_weeks: null })).toBeNull();
    expect(seasonOf({})).toBeNull();
    const s = seasonOf({ season_start: '2026-11-09', season_weeks: 4 })!;
    expect(s).toEqual({ start: '2026-11-09', weeks: 4 });
    expect(seasonEnd(s)).toBe('2026-12-06');
    expect(seasonEnd({ start: '2030-01-07', weeks: 1 })).toBe('2030-01-13');
    expect(DEFAULT_SEASON_WEEKS).toBe(4);
    expect(SEASON_WEEK_OPTIONS).toContain(4);
  });

  it('counts local days, so a week with a DST change is still 7 days', () => {
    expect(daysBetween('2026-11-01', '2026-11-08')).toBe(7); // fall back on Nov 1
    expect(daysBetween('2026-03-08', '2026-03-15')).toBe(7); // spring forward
    expect(daysBetween('2030-01-13', '2030-01-07')).toBe(-6);
    const s = { start: '2026-10-26', weeks: 2 };
    expect(seasonEnd(s)).toBe('2026-11-08');
    expect(seasonProgress(s, '2026-11-02')).toMatchObject({ phase: 'running', week: 2, daysLeft: 6 });
  });

  it('progress: before, during (week and days left) and after the season', () => {
    const s = { start: '2026-11-09', weeks: 4 };
    expect(seasonProgress(s, '2026-11-08')).toEqual({ phase: 'upcoming', week: 0, weeks: 4, daysLeft: 28, fraction: 0, finishLine: '2026-12-06' });
    expect(seasonProgress(s, '2026-11-09')).toMatchObject({ phase: 'running', week: 1, daysLeft: 27, fraction: 0 });
    expect(seasonProgress(s, '2026-11-15')).toMatchObject({ phase: 'running', week: 1, daysLeft: 21 });
    const mid = seasonProgress(s, '2026-11-30');
    expect(mid).toMatchObject({ phase: 'running', week: 4, daysLeft: 6 });
    expect(mid.fraction).toBeCloseTo(21 / 28);
    expect(seasonProgress(s, '2026-11-23')).toMatchObject({ phase: 'running', week: 3, daysLeft: 13 });
    expect(seasonProgress(s, '2026-12-06')).toMatchObject({ phase: 'running', week: 4, daysLeft: 0 });
    expect(seasonProgress(s, '2026-12-07')).toEqual({ phase: 'finished', week: 4, weeks: 4, daysLeft: 0, fraction: 1, finishLine: '2026-12-06' });
  });

  it('writes the progress line in plain words', () => {
    const s = { start: '2026-11-09', weeks: 4 };
    expect(formatLocalDay('2026-12-06')).toBe('Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-11-30'))).toBe('Week 4 of 4 · 6 days left · finish line Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-11-16'))).toBe('Week 2 of 4 · 20 days left · finish line Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-12-05'))).toBe('Week 4 of 4 · 1 day left · finish line Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-12-06'))).toBe('Week 4 of 4 · last day · finish line Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-11-01'), s.start)).toBe('4 weeks from Mon, Nov 9 · finish line Sun, Dec 6');
    expect(seasonProgressLine(seasonProgress(s, '2026-12-20'))).toBe('Finished Sun, Dec 6 · 4 weeks');
    expect(seasonProgressLine(seasonProgress({ start: '2026-11-09', weeks: 1 }, '2026-12-20'))).toBe('Finished Sun, Nov 15 · 1 week');
    expect(seasonDetailLine(seasonProgress(s, '2026-11-16'))).toBe('20 days left · finish line Sun, Dec 6');
    expect(seasonDetailLine(seasonProgress(s, '2026-11-01'))).toBe('4 weeks · finish line Sun, Dec 6');
    expect(seasonDetailLine(seasonProgress(s, '2026-12-20'))).toBe('Sun, Dec 6 · 4 weeks');
    expect(seasonShortLabel(seasonProgress(s, '2026-11-16'), s.start)).toBe('Week 2 of 4');
    expect(seasonShortLabel(seasonProgress(s, '2026-11-01'), s.start)).toBe('Starts Mon, Nov 9');
    expect(seasonShortLabel(seasonProgress(s, '2026-12-20'), s.start)).toBe('Finished');
    expect(seasonSummary(s)).toBe('4-week season from Mon, Nov 9 to Sun, Dec 6');
  });

  it('next Monday is the coming Monday, today included when today is one', () => {
    expect(nextMonday('2026-11-07')).toBe('2026-11-09'); // Saturday
    expect(nextMonday('2026-11-08')).toBe('2026-11-09'); // Sunday
    expect(nextMonday('2026-11-09')).toBe('2026-11-09'); // Monday
    expect(nextMonday('2026-11-10')).toBe('2026-11-16'); // Tuesday
    expect(nextMonday('2026-12-31')).toBe('2027-01-04');
  });
});

describe('recap copy', () => {
  const me: RecapRow = { user_id: 'you', days: 20, showed_up: 17, missed: 2, unverified: 1, frozen: 0, net_cents: 1250 };
  const streaks = [
    { user_id: 'you', current_streak: 3, best_streak: 9 },
    { user_id: 'maya', current_streak: 14, best_streak: 14 },
    { user_id: 'diego', current_streak: 0, best_streak: 1 },
  ];

  it('the finished-season sentence with the longest streak', () => {
    expect(recapSentence(me, longestStreak(streaks, nameOf), true, 'you')).toBe(
      'You showed up 17 of 20 days and came out +$12.50. Maya had the longest streak: 14.',
    );
    expect(recapSentence({ ...me, net_cents: -300 }, null, true, 'you')).toBe('You showed up 17 of 20 days and came out -$3.00.');
    expect(recapSentence({ ...me, net_cents: 0, days: 1, showed_up: 1 }, null, true, 'you')).toBe('You showed up 1 of 1 day and came out even.');
  });

  it('the running-season sentence, and when you hold the longest streak', () => {
    const mine = [{ user_id: 'you', current_streak: 6, best_streak: 9 }, { user_id: 'maya', current_streak: 2, best_streak: 5 }];
    expect(recapSentence(me, longestStreak(mine, nameOf), false, 'you')).toBe(
      "So far you've shown up 17 of 20 days and are +$12.50. You have the longest streak: 9.",
    );
    expect(recapSentence(me, longestStreak(streaks, nameOf), false, 'you')).toBe(
      "So far you've shown up 17 of 20 days and are +$12.50. Maya has the longest streak: 14.",
    );
    expect(recapSentence(null, null, false, 'you')).toBe('No closed days for you yet.');
    expect(recapSentence(null, null, true, 'you')).toBe("You weren't in any of this season's days.");
  });

  it('longest streak needs at least 2 in a row; ties go to the first name alphabetically', () => {
    expect(longestStreak([{ user_id: 'diego', current_streak: 1, best_streak: 1 }], nameOf)).toBeNull();
    expect(longestStreak([], nameOf)).toBeNull();
    expect(
      longestStreak(
        [
          { user_id: 'you', current_streak: 0, best_streak: 5 },
          { user_id: 'maya', current_streak: 0, best_streak: 5 },
        ],
        nameOf,
      ),
    ).toEqual({ userId: 'maya', name: 'Maya Chen', streak: 5 });
  });

  it('member rows, nets and sorting', () => {
    expect(memberRecapLine(me)).toBe('17 of 20 days · 2 missed · 1 unverified');
    expect(memberRecapLine({ ...me, missed: 0, unverified: 0, frozen: 1 })).toBe('17 of 20 days · 1 frozen');
    expect(netWord(0)).toBe('even');
    expect(netWord(-50)).toBe('-$0.50');
    expect(netTone(1)).toBe('success');
    expect(netTone(-1)).toBe('forfeit');
    expect(netTone(0)).toBe('secondary');
    const rows: RecapRow[] = [
      { ...me, user_id: 'diego', showed_up: 10, net_cents: -500 },
      { ...me, user_id: 'maya', showed_up: 17, net_cents: 1250 },
      me,
    ];
    expect(sortRecaps(rows, nameOf).map((r) => r.user_id)).toEqual(['maya', 'you', 'diego']);
    expect(firstName('Maya Chen')).toBe('Maya');
    expect(firstName('You')).toBe('You');
  });
});

describe('streak copy', () => {
  it('reads current and best', () => {
    expect(streakLine(3, 9)).toBe('3 in a row · Best 9');
    expect(streakLine(9, 9)).toBe('9 in a row');
    expect(streakLine(0, 9)).toBe('Best 9');
    expect(streakLine(1, 1)).toBe('1 in a row');
    expect(streakLine(0, 0)).toBeNull();
    expect(streakValue(3)).toBe('3 in a row');
    expect(streakValue(0)).toBe('No streak');
    expect(streakFor([], 'you')).toEqual({ user_id: 'you', current_streak: 0, best_streak: 0 });
    expect(streakAccessibilityLabel('Maya', 3, 9)).toBe('Maya, 3 days in a row, best 9');
    expect(streakAccessibilityLabel('Maya', 1, 1)).toBe('Maya, 1 day in a row');
    expect(streakAccessibilityLabel('Maya', 0, 4)).toBe('Maya, no current streak, best 4');
  });

  it('sorts the hottest streak first', () => {
    const rows = [
      { user_id: 'you', current_streak: 3, best_streak: 9 },
      { user_id: 'maya', current_streak: 14, best_streak: 14 },
      { user_id: 'diego', current_streak: 3, best_streak: 3 },
    ];
    expect(sortStreaks(rows, nameOf).map((r) => r.user_id)).toEqual(['maya', 'you', 'diego']);
  });
});

describe('settle-up completion', () => {
  const stats = { obligations_created: 10, obligations_confirmed: 9, completion_rate: '0.9000', weeks_settled: 3, last_settled_week: '2026-11-02' };

  it('the headline number and the line', () => {
    expect(completionPercent(stats)).toBe(90);
    expect(completionHeadline(stats)).toBe('90%');
    expect(completionLine(stats)).toBe('Settled up 9 of 10 times · 90%');
    expect(completionLine({ ...stats, obligations_created: 1, obligations_confirmed: 1 })).toBe('Settled up 1 of 1 · 100%');
    expect(completionLine({ ...stats, obligations_created: 2, obligations_confirmed: 1 })).toBe('Settled up 1 of 2 times · 50%');
    expect(completionLine({ ...stats, obligations_created: 3, obligations_confirmed: 1 })).toBe('Settled up 1 of 3 times · 33%');
    expect(openCount(stats)).toBe(1);
  });

  it('nothing to divide by yet', () => {
    const none = { obligations_created: 0, obligations_confirmed: 0, completion_rate: null, weeks_settled: 0, last_settled_week: null };
    expect(completionPercent(none)).toBeNull();
    expect(completionHeadline(none)).toBe('—');
    expect(completionLine(none)).toBe('No settle-ups yet');
    expect(completionLine({ ...none, weeks_settled: 1, last_settled_week: '2026-11-02' })).toBe('Nothing owed yet, so nothing to settle');
    expect(completionTone(none)).toBe('pending');
    expect(weeksLine(none)).toBe('No weeks settled yet');
  });

  it('tone bands and the weeks line', () => {
    expect(completionTone(stats)).toBe('success');
    expect(completionTone({ ...stats, obligations_confirmed: 8 })).toBe('success');
    expect(completionTone({ ...stats, obligations_confirmed: 7 })).toBe('unverified');
    expect(completionTone({ ...stats, obligations_confirmed: 5 })).toBe('unverified');
    expect(completionTone({ ...stats, obligations_confirmed: 4 })).toBe('forfeit');
    expect(weeksLine(stats)).toBe('3 weeks settled · last week of Nov 2');
    expect(weeksLine({ ...stats, weeks_settled: 1 })).toBe('1 week settled · last week of Nov 2');
    expect(COMPLETION_FOOTNOTE).toMatch(/confirmed on Venmo/);
    for (const text of [COMPLETION_FOOTNOTE, completionLine(stats), weeksLine(stats)]) expect(text).not.toMatch(/\b(stake|pot|wager|bet|rake|ledger)\b/i);
  });
});
