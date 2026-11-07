import type { ObligationRow, ObligationStatus, SettlementRow } from '../api/types';

/** Statuses still awaiting action. Settlement supersedes only pending ones; marked_paid persists across weeks. */
export const OPEN_OBLIGATION_STATUSES: readonly ObligationStatus[] = ['pending', 'marked_paid'];

export interface ObligationGroup {
  settlementId: string;
  /** null if the settlement row isn't visible */
  weekStart: string | null;
  obligations: ObligationRow[];
}

function bySettlement(rows: ObligationRow[], weekOf: Map<string, string>): ObligationGroup[] {
  const groups = new Map<string, ObligationGroup>();
  for (const o of rows) {
    const g = groups.get(o.settlement_id) ?? {
      settlementId: o.settlement_id,
      weekStart: weekOf.get(o.settlement_id) ?? null,
      obligations: [],
    };
    g.obligations.push(o);
    groups.set(o.settlement_id, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.obligations.sort((a, b) => b.amount_cents - a.amount_cents || a.id.localeCompare(b.id));
  // newest week first; unknown weeks last
  return out.sort((a, b) => (b.weekStart ?? '').localeCompare(a.weekStart ?? ''));
}

/** Open obligations split into mine and others', each grouped by settlement week (newest first). */
export function groupOpenObligations(
  obligations: readonly ObligationRow[],
  settlements: readonly SettlementRow[],
  userId: string,
): { mine: ObligationGroup[]; others: ObligationGroup[] } {
  const weekOf = new Map(settlements.map((s) => [s.id, s.week_start]));
  const open = obligations.filter((o) => OPEN_OBLIGATION_STATUSES.includes(o.status));
  const isMine = (o: ObligationRow) => o.from_user === userId || o.to_user === userId;
  return {
    mine: bySettlement(open.filter(isMine), weekOf),
    others: bySettlement(
      open.filter((o) => !isMine(o)),
      weekOf,
    ),
  };
}
