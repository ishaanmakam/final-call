import { describe, expect, it } from 'vitest';
import type { ObligationRow } from '../../api/types';
import type { ObligationGroup } from '../../lib/obligations';
import { obligationPill, settleHeadline, settleSubline, settleSummary, sideOf, signedBalance, splitWeeks } from './summary';

let n = 0;
const ob = (p: Partial<ObligationRow>): ObligationRow => ({
  id: `o${++n}`,
  settlement_id: 's-latest',
  group_id: 'g',
  from_user: 'diego',
  to_user: 'me',
  amount_cents: 825,
  status: 'pending',
  marked_paid_at: null,
  confirmed_at: null,
  ...p,
});

const names: Record<string, string> = { me: 'You', maya: 'Maya', diego: 'Diego', priya: 'Priya' };
const nameOf = (id: string) => names[id] ?? 'Someone';

describe('settleSummary', () => {
  it('nets what you receive against what you pay, counting marked paid until confirmed', () => {
    const s = settleSummary(
      [
        ob({ from_user: 'diego', to_user: 'me', amount_cents: 825 }),
        ob({ from_user: 'priya', to_user: 'me', amount_cents: 425, status: 'marked_paid' }),
        ob({ from_user: 'me', to_user: 'maya', amount_cents: 200 }),
        ob({ from_user: 'priya', to_user: 'maya', amount_cents: 375 }),
        ob({ from_user: 'me', to_user: 'maya', amount_cents: 9999, status: 'confirmed' }),
        ob({ from_user: 'me', to_user: 'maya', amount_cents: 9999, status: 'superseded' }),
      ],
      'me',
    );
    expect(s).toEqual({ payCents: 200, receiveCents: 1250, netCents: 1050, payees: ['maya'], payers: ['diego', 'priya'] });
    expect(settleHeadline(s)).toBe("You're owed $10.50");
  });

  it('says you owe when you pay more than you receive, and all square at zero', () => {
    expect(settleHeadline(settleSummary([ob({ from_user: 'me', to_user: 'maya', amount_cents: 500 })], 'me'))).toBe('You owe $5.00');
    expect(settleHeadline(settleSummary([], 'me'))).toBe('All square');
  });

  it('writes the subline for each side', () => {
    const both = settleSummary(
      [ob({ from_user: 'diego', to_user: 'me', amount_cents: 825 }), ob({ from_user: 'me', to_user: 'maya', amount_cents: 200 })],
      'me',
    );
    expect(settleSubline(both, nameOf, true)).toBe(
      "You pay Maya $2.00 on Venmo, then mark it paid; they confirm and it's done. Diego pays you $8.25 on Venmo. Confirm when it lands.",
    );
    const two = settleSummary(
      [ob({ from_user: 'diego', to_user: 'me', amount_cents: 825 }), ob({ from_user: 'priya', to_user: 'me', amount_cents: 100 })],
      'me',
    );
    expect(settleSubline(two, nameOf, true)).toBe('Diego and Priya pay you $9.25 on Venmo. Confirm when it lands.');
    expect(settleSubline(settleSummary([], 'me'), nameOf, true)).toMatch(/Monday at noon/);
    expect(settleSubline(settleSummary([], 'me'), nameOf, false)).toMatch(/first settle-up/);
  });

  it('never uses code words', () => {
    const s = settleSummary([ob({})], 'me');
    expect(`${settleHeadline(s)} ${settleSubline(s, nameOf, true)}`).not.toMatch(/\b(stake|pot|ledger|bet|wager|rake)\b/i);
  });
});

describe('obligationPill', () => {
  it('shows Waiting to a payee and Unpaid to a payer', () => {
    expect(obligationPill('pending', 'receive')).toEqual({ label: 'Waiting', tone: 'pending' });
    expect(obligationPill('pending', 'pay').label).toBe('Unpaid');
    expect(obligationPill('pending', 'other').label).toBe('Unpaid');
    expect(obligationPill('marked_paid', 'receive').label).toBe('Marked paid');
    expect(obligationPill('confirmed', 'pay').tone).toBe('success');
  });
});

describe('weeks', () => {
  const g = (settlementId: string, weekStart: string | null): ObligationGroup => ({ settlementId, weekStart, obligations: [] });
  it('splits the latest settlement from earlier ones', () => {
    const groups = [g('s-latest', '2026-11-02'), g('s-prev', '2026-10-26'), g('s-old', null)];
    const split = splitWeeks(groups, 's-latest');
    expect(split.thisWeek?.settlementId).toBe('s-latest');
    expect(split.earlier.map((x) => x.settlementId)).toEqual(['s-prev', 's-old']);
  });
  it('has no this-week group when nothing open belongs to the latest settlement', () => {
    const split = splitWeeks([g('s-prev', '2026-10-26')], 's-latest');
    expect(split.thisWeek).toBeNull();
    expect(split.earlier).toHaveLength(1);
  });
});

describe('small helpers', () => {
  it('sideOf and signedBalance', () => {
    expect(sideOf(ob({ from_user: 'me' }), 'me')).toBe('pay');
    expect(sideOf(ob({ to_user: 'me', from_user: 'x' }), 'me')).toBe('receive');
    expect(sideOf(ob({ to_user: 'y', from_user: 'x' }), 'me')).toBe('other');
    expect(signedBalance(1250)).toBe('+$12.50');
    expect(signedBalance(-825)).toBe('-$8.25');
    expect(signedBalance(0)).toBe('$0.00');
  });
});
