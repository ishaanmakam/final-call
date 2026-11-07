import { describe, expect, it } from 'vitest';
import { classifyRpcError } from './errors';

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
