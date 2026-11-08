import { describe, expect, it } from 'vitest';
import type { CheckinRow } from '../api/types';
import type { QueuedCheckin } from './checkinQueue';
import { queueNotice } from './queueNotice';

const entry: QueuedCheckin = {
  key: 'k',
  instanceId: 'i-open',
  lat: 1,
  lng: 2,
  accuracyM: 10,
  clientCapturedAt: '2026-11-07T16:58:00Z',
  isSimulated: false,
  enqueuedAt: 0,
  attempts: 1,
  nextAttemptAt: 0,
  lastError: null,
};

const row = (verdict: CheckinRow['verdict'], receivedAt = '2026-11-07T16:59:00Z'): CheckinRow => ({
  id: 'c',
  instance_id: 'i-open',
  user_id: 'u',
  client_captured_at: entry.clientCapturedAt,
  server_received_at: receivedAt,
  lat: 1,
  lng: 2,
  accuracy_m: 10,
  distance_m: 5,
  is_simulated: false,
  verdict,
  client_attempt_id: 'a',
});

const ctx = { pactTitle: '9am in Kane Hall', deadlineAt: '2026-11-07T17:00:00Z', tz: 'America/Los_Angeles' };

describe('queueNotice', () => {
  it('in-fence before the deadline: delivered, no caveat', () => {
    const n = queueNotice({ type: 'sent', entry, result: row('in_fence') }, ctx);
    expect(n.message).toBe('Offline check-in delivered · You were at your place for 9am in Kane Hall.');
    expect(n.tone).toBe('success');
  });
  it('in-fence after the deadline: says unverified and that no pledge moves', () => {
    const n = queueNotice({ type: 'sent', entry, result: row('in_fence', '2026-11-07T17:00:05Z') }, ctx);
    expect(n.message).toMatch(/unverified because it arrived after 9:00 AM; no pledge moves/);
    expect(n.tone).toBe('unverified');
  });
  it('out of fence: honest about the miss and points to the appeal', () => {
    const n = queueNotice({ type: 'sent', entry, result: row('out_of_fence') }, ctx);
    expect(n.message).toMatch(/stands as missed\. Appeal it in the feed/);
    expect(n.message).not.toMatch(/never costs/);
  });
  it('unjudgeable: unverified, no pledge moves', () => {
    expect(queueNotice({ type: 'sent', entry, result: row('unjudgeable') }, ctx).message).toBe(
      'Offline check-in delivered · GPS was too weak to judge, so 9am in Kane Hall counts as unverified. No pledge moves.',
    );
  });
  it('simulated and rejected', () => {
    expect(queueNotice({ type: 'sent', entry, result: row('rejected_simulated') }).message).toMatch(/looked simulated/);
    expect(queueNotice({ type: 'rejected', entry, error: 'The check-in window is closed.' }).message).toBe(
      'Offline check-in not accepted · The check-in window is closed.',
    );
  });
  it('expired: the day stands as recorded, with the date when known', () => {
    expect(queueNotice({ type: 'expired', entry }, ctx).message).toMatch(/so Sat, Nov 7 stands as recorded/);
    expect(queueNotice({ type: 'expired', entry }).message).toMatch(/so that day stands as recorded/);
  });
  it('works without context', () => {
    expect(queueNotice({ type: 'sent', entry, result: row('in_fence') }).message).toBe('Offline check-in delivered · You were at your place.');
  });
});
