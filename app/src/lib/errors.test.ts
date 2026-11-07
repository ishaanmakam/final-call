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

  it('passes rule-violation (23514) messages through, e.g. leaving during an active window', () => {
    const message = 'cannot leave while a check-in window is open';
    expect(userMessage({ status: 400, code: '23514', message })).toBe(message);
  });

  it('does not treat other check-in rules as the cap', () => {
    expect(userMessage({ status: 400, code: '23514', message: 'check-in window is closed' })).toBe(
      'check-in window is closed',
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
