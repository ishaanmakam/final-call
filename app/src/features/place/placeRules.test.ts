import { describe, expect, it } from 'vitest';
import type { PactInstanceRow } from '../../api/types';
import { placeSaveState } from './placeRules';

const T0 = Date.parse('2026-11-10T16:30:00Z');
const inst = (id: string, openOffsetMin: number, deadlineOffsetMin: number, status: PactInstanceRow['status'] = 'scheduled'): PactInstanceRow => ({
  id,
  pact_id: 'p1',
  local_date: '2026-11-10',
  window_open_at: new Date(T0 + openOffsetMin * 60_000).toISOString(),
  deadline_at: new Date(T0 + deadlineOffsetMin * 60_000).toISOString(),
  status,
  carry_in_cents: null,
  closed_at: null,
  deadline_soon_sent_at: null,
});

describe('placeSaveState', () => {
  it('first join is immediate and never locked, even during an open window', () => {
    const s = placeSaveState({ hasPlace: false, upcoming: [inst('a', -30, 30, 'open')], nowMs: T0 });
    expect(s.mode).toBe('join');
    expect(s.locked).toBe(false);
    expect(s.nextWindow?.id).toBeUndefined();
  });

  it('a change is refused while a window is open, and says when to try again', () => {
    const s = placeSaveState({ hasPlace: true, upcoming: [inst('a', -30, 30, 'open'), inst('b', 1410, 1470)], nowMs: T0 });
    expect(s.mode).toBe('change');
    expect(s.locked).toBe(true);
    expect(s.lockedUntil).toBe(new Date(T0 + 30 * 60_000).toISOString());
    expect(s.nextWindow?.id).toBe('b');
  });

  it('a change outside any window is allowed and reports the next window', () => {
    const s = placeSaveState({ hasPlace: true, upcoming: [inst('a', -120, -60, 'closed'), inst('b', 180, 240)], nowMs: T0 });
    expect(s.locked).toBe(false);
    expect(s.nextWindow?.id).toBe('b');
  });

  it('a voided day does not lock anything', () => {
    const s = placeSaveState({ hasPlace: true, upcoming: [inst('a', -30, 30, 'voided')], nowMs: T0 });
    expect(s.locked).toBe(false);
  });
});
