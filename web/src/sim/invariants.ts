import { simplifyDebts } from '@final-call/rules';
import { billableBalances, memberById } from './engine';
import { accountBalances, carryBalance, memberBalances, potBalances } from './ledger';
import type { World } from './types';

export interface Conservation {
  /** sum of member balances + carry + every pot: always 0 in a double-entry ledger */
  total: number;
  membersTotal: number;
  carry: number;
  /** pots of closed days are empty; only a day mid-posting could hold money, and none does here */
  nonEmptyPots: string[];
  entriesBalanced: boolean;
  ok: boolean;
}

/** The checks the tests run after every step; the UI shows the same numbers. */
export function conservation(w: World): Conservation {
  const members = memberBalances(w);
  const membersTotal = Object.values(members).reduce((a, b) => a + b, 0);
  const carry = carryBalance(w);
  const pots = potBalances(w);
  const nonEmptyPots = [...pots.entries()].filter(([, v]) => v !== 0).map(([k]) => k);
  const total = [...accountBalances(w.entries).values()].reduce((a, b) => a + b, 0);
  const entriesBalanced = w.entries.every((e) => e.lines.reduce((a, l) => a + l.amountCents, 0) === 0 && e.lines.every((l) => l.amountCents !== 0));
  return {
    total,
    membersTotal,
    carry,
    nonEmptyPots,
    entriesBalanced,
    ok: total === 0 && membersTotal + carry === 0 && nonEmptyPots.length === 0 && entriesBalanced,
  };
}

/** The latest settlement's live obligations must be exactly what the oracle says for the billed balances. */
export function obligationsMatchOracle(w: World): boolean {
  const last = w.settlements.at(-1);
  if (!last) return w.obligations.length === 0;
  const live = w.obligations.filter((o) => o.settlementId === last.id).map((o) => ({ from: o.from, to: o.to, amountCents: o.amountCents }));
  // rebuild the balances as they were when the settlement ran: undo payments confirmed since, and
  // re-add marked-paid amounts that were provisional then
  const balances = billableBalances(w);
  for (const e of w.entries) {
    if (e.kind !== 'settlement_payment' || e.createdAt < last.ranAt) continue;
    for (const l of e.lines) balances[l.account.slice('member:'.length) as keyof typeof balances] -= l.amountCents;
  }
  for (const o of w.obligations) {
    if (o.settlementId !== last.id || o.status !== 'marked_paid') continue;
    balances[o.from] -= o.amountCents;
    balances[o.to] += o.amountCents;
  }
  const expected = simplifyDebts(balances).obligations;
  if (expected.length !== live.length) return false;
  return expected.every((e, i) => e.from === live[i]!.from && e.to === live[i]!.to && e.amountCents === live[i]!.amountCents);
}

export function describeBalances(w: World): string {
  return w.members.map((m) => `${memberById(w, m.id).name} ${memberBalances(w)[m.id]}`).join(', ');
}
