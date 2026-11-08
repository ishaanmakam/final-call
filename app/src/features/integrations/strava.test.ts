import { describe, expect, it } from 'vitest';
import {
  connectionFrom,
  functionsBaseFrom,
  parseStravaReturn,
  stateRequestBody,
  stravaConnectUrl,
  stravaReturnMessage,
  webReturnUrlFrom,
} from './strava';

describe('stravaConnectUrl', () => {
  it('points at the function connect hop with the state encoded', () => {
    expect(stravaConnectUrl('https://ref.supabase.co/functions/v1', 'abc.def')).toBe('https://ref.supabase.co/functions/v1/strava-sync/connect?state=abc.def');
    expect(stravaConnectUrl('https://ref.supabase.co/functions/v1/', 'a b+c')).toBe('https://ref.supabase.co/functions/v1/strava-sync/connect?state=a%20b%2Bc');
  });
  it('functionsBaseFrom builds the functions base from the project URL', () => {
    expect(functionsBaseFrom('https://ref.supabase.co')).toBe('https://ref.supabase.co/functions/v1');
    expect(functionsBaseFrom('http://127.0.0.1:54321/')).toBe('http://127.0.0.1:54321/functions/v1');
  });
});

describe('parseStravaReturn', () => {
  it('reads connected and error off the app scheme, a web URL and a bare query', () => {
    expect(parseStravaReturn('finalcall://settings?strava=connected')).toEqual({ status: 'connected' });
    expect(parseStravaReturn('https://ishaanmakam.github.io/final-call/app/settings?strava=error&reason=access_denied')).toEqual({ status: 'error', reason: 'access_denied' });
    expect(parseStravaReturn('finalcall://settings?strava=error')).toEqual({ status: 'error', reason: null });
    expect(parseStravaReturn('?strava=connected')).toEqual({ status: 'connected' });
    expect(parseStravaReturn('strava=connected')).toEqual({ status: 'connected' });
  });
  it('returns null when there is nothing about Strava in the URL', () => {
    expect(parseStravaReturn('finalcall://settings')).toBeNull();
    expect(parseStravaReturn('finalcall://join/ABC')).toBeNull();
    expect(parseStravaReturn('finalcall://settings?strava=weird')).toBeNull();
    expect(parseStravaReturn('')).toBeNull();
    expect(parseStravaReturn(null)).toBeNull();
    expect(parseStravaReturn(undefined)).toBeNull();
  });
  it('messages use plain words and the product voice (no bet/stake/pot)', () => {
    const banned = /\b(bet|bets|stake|stakes|pot)\b/i;
    for (const ret of [
      { status: 'connected' as const },
      { status: 'error' as const, reason: 'access_denied' },
      { status: 'error' as const, reason: 'scope' },
      { status: 'error' as const, reason: 'exchange' },
      { status: 'error' as const, reason: 'server' },
      { status: 'error' as const, reason: null },
    ]) {
      const msg = stravaReturnMessage(ret);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toMatch(banned);
    }
    expect(stravaReturnMessage({ status: 'error', reason: 'access_denied' })).toBe('Strava connection cancelled.');
  });
});

describe('connectionFrom', () => {
  it('maps the my_integrations rows to a connection', () => {
    expect(connectionFrom([])).toEqual({ status: 'disconnected' });
    expect(connectionFrom(null)).toEqual({ status: 'disconnected' });
    expect(connectionFrom([{ provider: 'strava', athlete_id: '4242', connected_at: '2026-11-08T17:00:00Z' }])).toEqual({
      status: 'connected',
      athleteId: '4242',
      connectedAt: '2026-11-08T17:00:00Z',
    });
    expect(connectionFrom([{ provider: 'garmin', athlete_id: '1', connected_at: '2026-11-08T17:00:00Z' }])).toEqual({ status: 'disconnected' });
  });
});

describe('state request', () => {
  it('sends the user id, and the web return URL only when given', () => {
    expect(stateRequestBody('u1')).toEqual({ user_id: 'u1' });
    expect(stateRequestBody('u1', null)).toEqual({ user_id: 'u1' });
    expect(stateRequestBody('u1', 'https://ishaanmakam.github.io/final-call/app/settings')).toEqual({ user_id: 'u1', redirect: 'https://ishaanmakam.github.io/final-call/app/settings' });
  });
  it('the web return URL is origin + path without the query', () => {
    expect(webReturnUrlFrom({ origin: 'https://ishaanmakam.github.io', pathname: '/final-call/app/settings' })).toBe('https://ishaanmakam.github.io/final-call/app/settings');
  });
});
