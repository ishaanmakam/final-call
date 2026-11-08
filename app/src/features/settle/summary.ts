/**
 * Display helpers for the settle-up screen: your net position in words, which pill an obligation
 * shows from each side, and the this-week / earlier split. All money is integer cents.
 */
import type { ObligationRow, ObligationStatus } from '../../api/types';
import { obligationLabel, type PillTone } from '../../components/status';
import { formatCents } from '../../lib/money';
import type { ObligationGroup } from '../../lib/obligations';

export interface SettleSummary {
  /** open obligations you pay (pending + marked paid, until confirmed) */
  payCents: number;
  /** open obligations paid to you (pending + marked paid, until you confirm) */
  receiveCents: number;
  /** receive − pay */
  netCents: number;
  payees: string[];
  payers: string[];
}

export function settleSummary(obligations: readonly ObligationRow[], userId: string): SettleSummary {
  let payCents = 0;
  let receiveCents = 0;
  const payees: string[] = [];
  const payers: string[] = [];
  for (const o of obligations) {
    if (o.status !== 'pending' && o.status !== 'marked_paid') continue;
    if (o.from_user === userId) {
      payCents += o.amount_cents;
      if (!payees.includes(o.to_user)) payees.push(o.to_user);
    } else if (o.to_user === userId) {
      receiveCents += o.amount_cents;
      if (!payers.includes(o.from_user)) payers.push(o.from_user);
    }
  }
  return { payCents, receiveCents, netCents: receiveCents - payCents, payees, payers };
}

/** "You're owed $7.00" / "You owe $5.00" / "All square" */
export function settleHeadline(s: SettleSummary): string {
  if (s.netCents > 0) return `You're owed ${formatCents(s.netCents)}`;
  if (s.netCents < 0) return `You owe ${formatCents(-s.netCents)}`;
  return 'All square';
}

export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The sentence under the headline: who pays whom. One clause per direction, no instructions (the
 * rows below carry the buttons and their footnotes).
 */
export function settleSubline(s: SettleSummary, nameOf: (id: string) => string, hasSettlement: boolean): string {
  const lines: string[] = [];
  if (s.payCents > 0) lines.push(`You pay ${joinNames(s.payees.map(nameOf))} ${formatCents(s.payCents)}`);
  if (s.receiveCents > 0) {
    const names = joinNames(s.payers.map(nameOf));
    lines.push(`${names} ${s.payers.length === 1 ? 'pays' : 'pay'} you ${formatCents(s.receiveCents)}`);
  }
  if (lines.length === 0) {
    return hasSettlement
      ? 'Nothing open for you. Next settle-up: Monday at noon, group time.'
      : 'The first settle-up runs Monday at noon, group time. Until then this week shows only in the running balance.';
  }
  return `${lines.join('; ')}, on Venmo.`;
}

/** Pill from your side of the obligation: a payee waits, a payer has something unpaid. */
export function obligationPill(status: ObligationStatus, side: 'pay' | 'receive' | 'other'): { label: string; tone: PillTone } {
  if (status === 'pending' && side === 'receive') return { label: 'Waiting', tone: 'pending' };
  return obligationLabel[status];
}

export interface WeekSplit {
  thisWeek: ObligationGroup | null;
  earlier: ObligationGroup[];
}

/** The latest settlement's group is this week; everything older collapses under "Earlier". */
export function splitWeeks(groups: readonly ObligationGroup[], latestSettlementId: string | null): WeekSplit {
  const thisWeek = groups.find((g) => g.settlementId === latestSettlementId) ?? null;
  return { thisWeek, earlier: groups.filter((g) => g !== thisWeek) };
}

/** Which side of an obligation the user is on. */
export function sideOf(o: ObligationRow, userId: string): 'pay' | 'receive' | 'other' {
  if (o.from_user === userId) return 'pay';
  if (o.to_user === userId) return 'receive';
  return 'other';
}

/** Running-balance amount with its sign, in label colour (never red). */
export const signedBalance = (cents: number): string => formatCents(cents, { signed: true });
