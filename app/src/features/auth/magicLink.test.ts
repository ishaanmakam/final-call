import { describe, expect, it } from 'vitest';
import {
  LINK_EXPIRED,
  LINK_MISSING_CODE,
  callbackErrorFromParams,
  exchangeErrorMessage,
  isValidEmail,
  safeNext,
} from './magicLink';

describe('safeNext', () => {
  it('keeps in-app paths and defaults to /groups', () => {
    expect(safeNext('/groups/g1')).toBe('/groups/g1');
    expect(safeNext(['/pacts/p1', '/x'])).toBe('/pacts/p1');
    expect(safeNext(undefined)).toBe('/groups');
    expect(safeNext('')).toBe('/groups');
  });

  it('never redirects off-app or back into auth', () => {
    expect(safeNext('https://evil.example')).toBe('/groups');
    expect(safeNext('//evil.example')).toBe('/groups');
    expect(safeNext('/sign-in?next=/groups')).toBe('/groups');
    expect(safeNext('/auth-callback?code=x')).toBe('/groups');
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses and trims', () => {
    expect(isValidEmail('sam@uw.edu')).toBe(true);
    expect(isValidEmail('  first.last+tag@example.co.uk ')).toBe(true);
  });
  it('rejects the usual typos', () => {
    expect(isValidEmail('sam')).toBe(false);
    expect(isValidEmail('sam@')).toBe(false);
    expect(isValidEmail('sam@uw')).toBe(false);
    expect(isValidEmail('sam @uw.edu')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

describe('callbackErrorFromParams', () => {
  it('returns null when there is a code to exchange', () => {
    expect(callbackErrorFromParams({ code: 'abc' })).toBeNull();
  });
  it('names a missing code', () => {
    expect(callbackErrorFromParams({})).toBe(LINK_MISSING_CODE);
  });
  it('maps Supabase otp_expired to the one-hour copy', () => {
    expect(callbackErrorFromParams({ error: 'access_denied', error_code: 'otp_expired', error_description: 'Email+link+is+invalid+or+has+expired' })).toBe(LINK_EXPIRED);
    expect(callbackErrorFromParams({ error_description: 'Token has expired' })).toBe(LINK_EXPIRED);
  });
  it('shows other descriptions with plus-signs unescaped', () => {
    expect(callbackErrorFromParams({ error: 'server_error', error_description: 'Something+odd' })).toBe('Something odd');
  });
});

describe('exchangeErrorMessage', () => {
  it('maps expiry and PKCE mismatches', () => {
    expect(exchangeErrorMessage({ code: 'otp_expired', message: 'x' })).toBe(LINK_EXPIRED);
    expect(exchangeErrorMessage(new Error('invalid flow state, no valid flow state found'))).toBe(LINK_EXPIRED);
    expect(exchangeErrorMessage(new Error('PKCE code verifier not found in storage'))).toBe('Open the link on the phone you requested it from.');
  });
  it('falls back to the message', () => {
    expect(exchangeErrorMessage(new Error('Network request failed'))).toBe('Network request failed');
    expect(exchangeErrorMessage(null)).toBe('null');
  });
});
