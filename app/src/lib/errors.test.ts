import { describe, expect, it } from 'vitest';
import { CHECKIN_CAP_MESSAGE, classifyRpcError, userMessage } from './errors';

describe('classifyRpcError', () => {
  it('treats fetch failures (status 0) as network', () => {
    expect(classifyRpcError({ status: 0, message: 'TypeError: Network request failed', code: '' })).toBe('network');
    expect(classifyRpcError({ status: 0, message: 'AbortError: Aborted', code: '' })).toBe('network');
  });

  it('treats gateway and rate limit statuses as network', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 520]) {
      expect(classifyRpcError({ status, message: 'x', code: '' })).toBe('network');
    }
  });

  it('recognizes thrown fetch errors without a status', () => {
    expect(classifyRpcError(new TypeError('Network request failed'))).toBe('network');
    expect(classifyRpcError(new Error('Failed to fetch'))).toBe('network');
  });

  it('treats expired auth as auth (retryable after refresh)', () => {
    expect(classifyRpcError({ status: 401, message: 'JWT expired', code: 'PGRST303' })).toBe('auth');
  });

  it('treats business-rule exceptions as rejected', () => {
    expect(classifyRpcError({ status: 400, message: 'window not open', code: 'P0001' })).toBe('rejected');
    expect(classifyRpcError({ status: 403, message: 'not a participant', code: '42501' })).toBe('rejected');
    expect(classifyRpcError(new Error('something else'))).toBe('rejected');
  });
});

describe('userMessage', () => {
  it('maps the per-instance check-in cap to friendly copy', () => {
    for (const message of [
      'at most 20 check-ins per instance',
      'check-in limit reached for this instance',
      'too many check-ins for this instance',
    ]) {
      expect(userMessage({ status: 400, code: '23514', message })).toBe(CHECKIN_CAP_MESSAGE);
    }
    expect(CHECKIN_CAP_MESSAGE).toBe("You've already checked in enough times for today.");
  });

  it('maps leaving during an active window to friendly copy', () => {
    const message = 'cannot leave while a check-in window you are part of is open or awaiting its result';
    expect(userMessage({ status: 400, code: '23514', message })).toMatch(/can't leave while a check-in window/i);
  });

  it('does not treat other check-in rules as the cap', () => {
    expect(userMessage({ status: 400, code: '23514', message: 'check-in window is closed' })).toBe(
      'The check-in window is closed.',
    );
  });

  it('falls back to a generic message when there is none', () => {
    expect(userMessage({ status: 400, code: '23514', message: '' })).toBe('Something went wrong.');
    expect(userMessage(null)).toBe('Something went wrong.');
  });

  it('works on plain Errors and strings', () => {
    expect(userMessage(new Error('boom'))).toBe('boom');
    expect(userMessage('nope')).toBe('nope');
  });
});

const BANNED = /\b(bets?|stakes?|pots?|wagers?|gambl\w*)\b/i;

describe('userMessage maps every server error code', () => {
  const cases: [code: string, message: string, expected: RegExp][] = [
    ['28000', 'not authenticated', /signed out/i],
    ['42501', 'not a member of this group', /not a member of this group/i],
    ['42501', 'only the payer can mark an obligation paid', /only the person paying/i],
    ['42501', 'some brand new permission rule', /don't have permission/i],
    ['P0002', 'invalid invite code', /invite code/i],
    ['P0002', 'instance not found', /no longer exists/i],
    ['P0002', 'something % not found', /couldn't be found/i],
    ['22023', 'stake must be between 1 and 10000 cents', /pledge must be between \$0\.01 and \$100\.00/i],
    ['22023', 'client_captured_at is more than 2 minutes ahead of server time', /clock/i],
    ['22023', 'invalid time zone: PST (must be an IANA zone name)', /time zone/i],
    ['22023', 'place_radius_m must be between 25 and 500', /25 and 500/],
    ['22023', 'weird_param must be odd', /isn't valid/i],
    ['23514', 'freeze already used for ISO week 2026-W45', /already used this week's freeze/i],
    ['23514', 'group is full: at most 8 current members', /full/i],
    ['23514', 'this result has already had its appeal (one per instance)', /already had its appeal/i],
    ['23514', 'obligation is superseded by a later settlement', /newer settle-up/i],
    [
      '23514',
      'cannot join, rejoin or change your place once a check-in window has opened (until it closes)',
      /change your place while a check-in window is open/i,
    ],
    [
      '23514',
      'new row for relation "profiles" violates check constraint "profiles_venmo_username_check"',
      /venmo usernames/i,
    ],
    ['23514', 'ledger entry 1 lines sum to 3 (must sum to zero)', /isn't allowed right now/i],
    ['23505', 'post_entry: idempotency key stake:x already used with different lines', /already/i],
    ['55000', 'ledger_lines is append-only (UPDATE not allowed); post a correction entry instead', /can't be changed/i],
  ];

  for (const [code, message, expected] of cases) {
    it(`${code}: ${message}`, () => {
      const out = userMessage({ status: 400, code, message });
      expect(out).toMatch(expected);
      expect(out).not.toMatch(BANNED);
      expect(out).not.toMatch(/[a-z]_[a-z]|%/i);
    });
  }

  it('maps PostgREST "no rows" from .single() like not-found', () => {
    expect(userMessage({ status: 406, code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toMatch(
      /couldn't be found/i,
    );
  });

  it('gives network and expired-session errors their own copy', () => {
    expect(userMessage({ status: 0, code: '', message: 'TypeError: Network request failed' })).toMatch(/connection/i);
    expect(userMessage({ status: 401, code: 'PGRST303', message: 'JWT expired' })).toMatch(/sign in again/i);
  });

  it('never shows an unknown database message raw', () => {
    expect(userMessage({ status: 400, code: '22P02', message: 'invalid input syntax for type uuid: "x"' })).toBe(
      'Something went wrong.',
    );
  });
});
