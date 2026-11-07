import { describe, expect, it } from 'vitest';
import { summarizeInstance } from './instanceStatus';

const deadlineAt = '2026-11-09T17:00:00Z';

describe('summarizeInstance', () => {
  it('counts in-fence check-ins received by the deadline', () => {
    const s = summarizeInstance({
      participantIds: ['a', 'b', 'c', 'd'],
      deadlineAt,
      checkins: [
        { user_id: 'a', verdict: 'in_fence', server_received_at: '2026-11-09T16:40:00Z' },
        { user_id: 'a', verdict: 'in_fence', server_received_at: '2026-11-09T16:45:00Z' },
        { user_id: 'b', verdict: 'out_of_fence', server_received_at: '2026-11-09T16:41:00Z' },
        { user_id: 'b', verdict: 'in_fence', server_received_at: '2026-11-09T16:50:00Z' },
        { user_id: 'c', verdict: 'in_fence', server_received_at: '2026-11-09T17:00:01Z' },
        { user_id: 'd', verdict: 'unjudgeable', server_received_at: '2026-11-09T16:30:00Z' },
      ],
      results: [],
    });
    expect(s.checkedIn).toBe(2);
    expect(s.total).toBe(4);
    expect(s.byUser).toEqual({ a: 'checked_in', b: 'checked_in', c: 'late', d: 'unjudged' });
    expect(s.label).toBe('2 of 4 checked in');
  });

  it('prefers posted results and leaves frozen people out of the total', () => {
    const s = summarizeInstance({
      participantIds: ['a', 'b', 'c'],
      deadlineAt,
      checkins: [{ user_id: 'b', verdict: 'out_of_fence', server_received_at: '2026-11-09T16:41:00Z' }],
      results: [
        { user_id: 'a', status: 'success' },
        { user_id: 'b', status: 'failed' },
        { user_id: 'c', status: 'frozen' },
      ],
    });
    expect(s.total).toBe(2);
    expect(s.checkedIn).toBe(1);
    expect(s.byUser).toEqual({ a: 'success', b: 'failed', c: 'frozen' });
  });

  it('marks people with no check-in as waiting', () => {
    const s = summarizeInstance({ participantIds: ['a'], deadlineAt, checkins: [], results: [] });
    expect(s.byUser).toEqual({ a: 'waiting' });
    expect(s.label).toBe('0 of 1 checked in');
  });
});
