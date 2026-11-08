import { describe, expect, it } from 'vitest';
import { routeFromData } from './pushRoute';

describe('routeFromData', () => {
  it('prefers the url the server sent, when it is an in-app path', () => {
    expect(routeFromData({ url: '/pacts/p1', kind: 'place_changed', pact_id: 'p2' })).toBe('/pacts/p1');
    expect(routeFromData({ url: 'https://evil.example/x', kind: 'settlement', group_id: 'g1' })).toBe('/groups/g1/ledger');
  });

  it('place_changed opens the pact, then falls back like any other kind', () => {
    expect(routeFromData({ kind: 'place_changed', pact_id: 'p1', group_id: 'g1' })).toBe('/pacts/p1');
    expect(routeFromData({ kind: 'place_changed', group_id: 'g1' })).toBe('/groups/g1');
    expect(routeFromData({ kind: 'place_changed' })).toBeNull();
  });

  it('routes older payloads by kind', () => {
    expect(routeFromData({ kind: 'result', group_id: 'g1' })).toBe('/groups/g1/feed');
    expect(routeFromData({ kind: 'review_opened', group_id: 'g1' })).toBe('/groups/g1/feed');
    expect(routeFromData({ kind: 'settlement', group_id: 'g1' })).toBe('/groups/g1/ledger');
    expect(routeFromData({ kind: 'window_open', instance_id: 'i1', group_id: 'g1' })).toBe('/checkin/i1');
    expect(routeFromData({ kind: 'anything', group_id: 'g1' })).toBe('/groups/g1');
    expect(routeFromData(undefined)).toBeNull();
  });
});
