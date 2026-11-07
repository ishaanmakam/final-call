import { describe, expect, it } from 'vitest';
import type { ObligationRow, SettlementRow } from '../api/types';
import { groupOpenObligations } from './obligations';

const settlements: SettlementRow[] = [
  { id: 's1', group_id: 'g', week_start: '2026-10-26', ran_at: '2026-11-02T20:00:00Z' },
  { id: 's2', group_id: 'g', week_start: '2026-11-02', ran_at: '2026-11-09T20:00:00Z' },
];

let n = 0;
const ob = (p: Partial<ObligationRow>): ObligationRow => ({
  id: `o${++n}`,
  settlement_id: 's2',
  group_id: 'g',
  from_user: 'me',
  to_user: 'b',
  amount_cents: 500,
  status: 'pending',
  marked_paid_at: null,
  confirmed_at: null,
  ...p,
});

describe('groupOpenObligations', () => {
  it('keeps only pending and marked_paid, hiding superseded and confirmed', () => {
    const rows = [
      ob({ id: 'p', status: 'pending' }),
      ob({ id: 'm', status: 'marked_paid' }),
      ob({ id: 's', status: 'superseded' }),
      ob({ id: 'c', status: 'confirmed' }),
    ];
    const { mine, others } = groupOpenObligations(rows, settlements, 'me');
    expect(others).toEqual([]);
    expect(mine.flatMap((g) => g.obligations.map((o) => o.id)).sort()).toEqual(['m', 'p']);
  });

  it('keeps marked_paid obligations from older settlements, grouped by week, newest first', () => {
    const rows = [
      ob({ id: 'old', settlement_id: 's1', status: 'marked_paid', to_user: 'me', from_user: 'c' }),
      ob({ id: 'new', settlement_id: 's2', status: 'pending' }),
    ];
    const { mine } = groupOpenObligations(rows, settlements, 'me');
    expect(mine.map((g) => [g.settlementId, g.weekStart, g.obligations.map((o) => o.id)])).toEqual([
      ['s2', '2026-11-02', ['new']],
      ['s1', '2026-10-26', ['old']],
    ]);
  });

  it('separates obligations between other members', () => {
    const rows = [ob({ id: 'x', from_user: 'b', to_user: 'c' }), ob({ id: 'y', from_user: 'c', to_user: 'me' })];
    const { mine, others } = groupOpenObligations(rows, settlements, 'me');
    expect(mine.flatMap((g) => g.obligations.map((o) => o.id))).toEqual(['y']);
    expect(others.flatMap((g) => g.obligations.map((o) => o.id))).toEqual(['x']);
  });

  it('orders within a week by amount, largest first', () => {
    const rows = [ob({ id: 'small', amount_cents: 100 }), ob({ id: 'big', amount_cents: 900 })];
    const { mine } = groupOpenObligations(rows, settlements, 'me');
    expect(mine[0]?.obligations.map((o) => o.id)).toEqual(['big', 'small']);
  });

  it('still shows an obligation whose settlement row is missing, with a null week', () => {
    const rows = [ob({ id: 'orphan', settlement_id: 'gone' })];
    const { mine } = groupOpenObligations(rows, settlements, 'me');
    expect(mine).toEqual([{ settlementId: 'gone', weekStart: null, obligations: [rows[0]] }]);
  });
});
