import { describe, expect, it } from 'vitest';
import type { CheckinRow } from '../../api/types';
import {
  budgetLine,
  busyFootnote,
  buttonEnabled,
  buttonState,
  clockA11yLabel,
  clockCopy,
  panelForApproximate,
  panelForError,
  panelForPermission,
  panelForQueued,
  panelForRow,
  resultFootnote,
  tapRow,
} from './copy';

const TZ = 'America/Los_Angeles';
const DEADLINE = '2026-11-10T17:00:00Z'; // 9:00 AM PST
const row = (over: Partial<CheckinRow>): CheckinRow => ({
  id: 'c',
  instance_id: 'i',
  user_id: 'u',
  client_captured_at: '2026-11-10T16:58:00Z',
  server_received_at: '2026-11-10T16:58:02Z',
  lat: null,
  lng: null,
  accuracy_m: 18,
  distance_m: 12,
  is_simulated: false,
  verdict: 'in_fence',
  client_attempt_id: null,
  ...over,
});
const place = { label: 'Kane Hall 120', radiusM: 75 };

describe('panelForRow', () => {
  it('in_fence on time: success pill, counted at the tap time', () => {
    const p = panelForRow(row({}), place, DEADLINE, TZ, null);
    expect(p.headline).toBe("You're in");
    expect(p.body).toBe('Counted at 8:58 AM.');
    expect(p.pill).toBe('success');
    expect(p.haptic).toBe('success');
  });

  it('in_fence after the deadline is unverified and says the tap time counts', () => {
    const p = panelForRow(row({ server_received_at: '2026-11-10T17:00:05Z' }), place, DEADLINE, TZ, null);
    expect(p.headline).toBe('Sent after the deadline');
    expect(p.body).toContain('Your tap was at 8:58 AM');
    expect(p.body).toContain('unverified: no pledge moves');
    expect(p.tone).toBe('unverified');
  });

  it('out_of_fence gives distance, circle and GPS, and never says "never costs you"', () => {
    const p = panelForRow(row({ verdict: 'out_of_fence', distance_m: 140.4 }), place, DEADLINE, TZ, null);
    expect(p.headline).toBe('Not inside your circle yet');
    expect(p.body).toBe('About 140 m from the center of Kane Hall 120 (circle is 75 m, GPS ±18 m). Get closer and tap again.');
    expect(p.body).not.toMatch(/never costs/);
    expect(p.footnote).toBe('Only your best tap counts.');
    expect(p.haptic).toBe('warning');
  });

  it('out_of_fence after the deadline stands as missed', () => {
    const p = panelForRow(row({ verdict: 'out_of_fence', server_received_at: '2026-11-10T17:00:05Z' }), place, DEADLINE, TZ, null);
    expect(p.body).toMatch(/stands as missed/);
    expect(p.body).not.toMatch(/unverified/);
  });

  it('unjudgeable with weak GPS states the accuracy and the fail-open rule', () => {
    const p = panelForRow(row({ verdict: 'unjudgeable', accuracy_m: 320, distance_m: null }), place, DEADLINE, TZ, null);
    expect(p.headline).toBe('GPS too weak to judge');
    expect(p.body).toContain('Accuracy was ±320 m, more than the 200 m limit.');
    expect(p.body).toContain('unverified: no pledge moves');
  });

  it('unjudgeable with no fix is the No GPS fix panel with a Try again action', () => {
    const p = panelForRow(row({ verdict: 'unjudgeable', accuracy_m: null, distance_m: null }), place, DEADLINE, TZ, 'Could not get a GPS fix in time.');
    expect(p.headline).toBe('No GPS fix');
    expect(p.body).toContain('Your tap at 8:58 AM was recorded without a location');
    expect(p.body).toContain('never costs you');
    expect(p.action).toBe('tryAgain');
  });

  it('rejected_simulated is an error with no reassurance', () => {
    const p = panelForRow(row({ verdict: 'rejected_simulated' }), place, DEADLINE, TZ, null);
    expect(p.headline).toBe('Location rejected');
    expect(p.body).toMatch(/counts as a miss/);
    expect(p.haptic).toBe('error');
    expect(p.tone).toBe('forfeit');
  });
});

describe('other panels', () => {
  it('queued names the tap time and the deadline', () => {
    const p = panelForQueued('2026-11-10T16:58:00Z', DEADLINE, TZ);
    expect(p.headline).toBe('Saved, will send');
    expect(p.body).toContain('Your tap at 8:58 AM');
    expect(p.body).toContain('after 9:00 AM');
    expect(p.haptic).toBe('warning');
  });

  it('permission denied offers a re-prompt and says the day counts as missed', () => {
    const p = panelForPermission(false);
    expect(p.action).toBe('allowLocation');
    expect(p.body).toMatch(/counts as missed/);
    expect(p.body).not.toMatch(/never costs/);
    expect(panelForPermission(true).action).toBe('openSettings');
  });

  it('approximate location refuses to send, routes to Settings and says missed, not unverified', () => {
    const p = panelForApproximate();
    expect(p.headline).toBe('Precise Location is off');
    expect(p.action).toBe('openSettings');
    expect(p.body).toMatch(/nothing was sent/);
    expect(p.body).toMatch(/Settings → Final Call → Location/);
    expect(p.body).toMatch(/Precise Location/);
    expect(p.footnote).toMatch(/counts as missed/);
    expect(p.footnote).toMatch(/not unverified/);
    expect(`${p.body} ${p.footnote}`).not.toMatch(/never costs/);
    expect(p.haptic).toBe('error');
  });

  it('budget line appears from the first unverified day and counts down to the vote', () => {
    expect(budgetLine(0)).toBeNull();
    expect(budgetLine(-1)).toBeNull();
    expect(budgetLine(Number.NaN)).toBeNull();
    expect(budgetLine(1)).toBe('1 unverified this month. Two more and the group votes on it.');
    expect(budgetLine(2)).toBe('2 unverified this month. One more and the group votes on it.');
    expect(budgetLine(3)).toBe('3 unverified this month. Another one goes to a group vote.');
    expect(budgetLine(5)).toMatch(/^5 unverified this month/);
    for (const n of [1, 2, 3]) expect(budgetLine(n)).not.toMatch(/stake|pot|bet|wager/i);
  });

  it('maps the cap, the roster rule and auth to their panels', () => {
    const cap = panelForError({ code: '23514', message: 'check-in limit of 20 per instance reached', status: 400 });
    expect(cap.headline).toBe("That's enough taps for today");
    const roster = panelForError({ code: '42501', message: 'not a participant of this pact instance', status: 403 });
    expect(roster.headline).toBe("You're not counted for this day");
    const auth = panelForError({ status: 401, message: 'JWT expired' });
    expect(auth.action).toBe('signIn');
    const closed = panelForError({ code: '23514', message: 'check-in window is closed', status: 400 });
    expect(closed.body).toBe('The check-in window is closed.');
    expect(closed.haptic).toBe('error');
  });
});

describe('clock', () => {
  it('before: Opens in + digits, footnote with open and deadline', () => {
    const c = clockCopy('before', 12 * 60_000 + 4000, '8:00 AM', '9:00 AM');
    expect(c).toEqual({ prefix: 'Opens in', showCountdown: true, footnote: '8:00 AM · window until 9:00 AM', urgent: false, final: false });
  });

  it('open: Boarding, then Final call from 15 minutes, urgent footnote in the last minute', () => {
    const boarding = clockCopy('open', 54 * 60_000 + 12_000, '8:00 AM', '9:00 AM');
    expect(boarding.prefix).toBe('Boarding ·');
    expect(boarding.footnote).toBe('left · by 9:00 AM');
    expect(boarding.final).toBe(false);
    expect(clockCopy('open', 15 * 60_000 + 1, '8:00 AM', '9:00 AM').final).toBe(false);
    const final = clockCopy('open', 14 * 60_000 + 59_000, '8:00 AM', '9:00 AM');
    expect(final.prefix).toBe('Final call ·');
    expect(final.final).toBe(true);
    expect(final.urgent).toBe(false);
    expect(final.footnote).toBe('left · by 9:00 AM');
    const last = clockCopy('open', 42_000, '8:00 AM', '9:00 AM');
    expect(last.urgent).toBe(true);
    expect(last.final).toBe(true);
    expect(last.footnote).toBe('Tap now. Your tap time is what counts.');
    expect(clockCopy('open', 60_001, '8:00 AM', '9:00 AM').urgent).toBe(false);
  });

  it('closed: a word, not digits', () => {
    expect(clockCopy('closed', -5000, '8:00 AM', '9:00 AM')).toEqual({ showCountdown: false, big: 'Gate closed', footnote: 'Deadline was 9:00 AM', urgent: false, final: false });
  });

  it('VoiceOver label changes per minute, not per second', () => {
    expect(clockA11yLabel('open', 54 * 60_000 + 12_000, '8:00 AM', '9:00 AM')).toBe('Boarding. 55 minutes left, deadline 9:00 AM');
    expect(clockA11yLabel('open', 14 * 60_000 + 32_000, '8:00 AM', '9:00 AM')).toBe('Final call. 15 minutes left, deadline 9:00 AM');
    expect(clockA11yLabel('open', 14 * 60_000 + 1000, '8:00 AM', '9:00 AM')).toBe('Final call. 15 minutes left, deadline 9:00 AM');
    expect(clockA11yLabel('open', 59_000, '8:00 AM', '9:00 AM')).toMatch(/^Final call. One minute left/);
    expect(clockA11yLabel('before', 61_000, '8:00 AM', '9:00 AM')).toBe('Check-in opens in 2 minutes, at 8:00 AM');
    expect(clockA11yLabel('closed', -1, '8:00 AM', '9:00 AM')).toBe('Gate closed. Deadline was 9:00 AM');
  });
});

describe('button', () => {
  const base = { phase: 'open' as const, finished: false, frozen: false, alreadyIn: false, busy: null };
  it('is idle only inside an open window for someone not frozen', () => {
    expect(buttonState(base)).toBe('idle');
    expect(buttonState({ ...base, phase: 'before' })).toBe('before');
    expect(buttonState({ ...base, phase: 'closed' })).toBe('closed');
    expect(buttonState({ ...base, finished: true })).toBe('closed');
    expect(buttonState({ ...base, frozen: true })).toBe('frozen');
    expect(buttonState({ ...base, alreadyIn: true })).toBe('done');
  });
  it('busy wins over everything and is never enabled', () => {
    expect(buttonState({ ...base, busy: 'locating', alreadyIn: true })).toBe('locating');
    expect(buttonEnabled('locating')).toBe(false);
    expect(buttonEnabled('sending')).toBe(false);
    expect(buttonEnabled('before')).toBe(false);
    expect(buttonEnabled('frozen')).toBe(false);
    expect(buttonEnabled('closed')).toBe(false);
    expect(buttonEnabled('idle')).toBe(true);
    expect(buttonEnabled('done')).toBe(true);
  });
  it('footnote while locating names the locked tap time', () => {
    expect(busyFootnote('locating', '2026-11-10T16:58:00Z', TZ)).toBe('Up to 25 seconds. Your tap at 8:58 AM is locked in.');
    expect(busyFootnote('idle', '2026-11-10T16:58:00Z', TZ)).toBeNull();
    expect(busyFootnote('locating', null, TZ)).toBeNull();
  });
});

describe('tap rows and result footnote', () => {
  it('never shows a raw verdict code', () => {
    const r = tapRow(row({ verdict: 'out_of_fence', distance_m: 140 }), DEADLINE, TZ);
    expect(r).toEqual({ title: '8:58 AM', subtitle: '140 m away · GPS ±18 m', state: 'out_of_fence' });
    expect(tapRow(row({}), DEADLINE, TZ).state).toBe('checked_in');
    expect(tapRow(row({ server_received_at: '2026-11-10T17:00:05Z' }), DEADLINE, TZ).state).toBe('late');
    expect(tapRow(row({ verdict: 'unjudgeable', accuracy_m: 480, distance_m: null }), DEADLINE, TZ)).toEqual({ title: '8:58 AM', subtitle: 'GPS ±480 m', state: 'unjudged' });
    expect(tapRow(row({ verdict: 'rejected_simulated' }), DEADLINE, TZ).state).toBe('failed');
  });
  it('explains the no-money states once', () => {
    expect(resultFootnote('unverified')).toMatch(/never costs a pledge/);
    expect(resultFootnote('success')).toBeUndefined();
    expect(resultFootnote('failed')).toMatch(/forfeited to the pool/);
  });
});
