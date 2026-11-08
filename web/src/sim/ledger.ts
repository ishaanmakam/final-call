import type { AccountKey, EntryKind, LedgerEntry, LedgerLine, MemberId, World } from './types';

export const memberAccount = (id: MemberId): AccountKey => `member:${id}`;
export const potAccount = (instanceId: string): AccountKey => `pot:${instanceId}`;
export const carryAccount = (pactId: string): AccountKey => `carry:${pactId}`;

/** Merge lines on the same account and drop zero amounts (CONTRACT.md ledger invariant 3). */
export function normalizeLines(lines: readonly LedgerLine[]): LedgerLine[] {
  const sums = new Map<AccountKey, number>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amountCents)) throw new Error(`non-integer amount on ${l.account}`);
    sums.set(l.account, (sums.get(l.account) ?? 0) + l.amountCents);
  }
  return [...sums.entries()]
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, amountCents]) => ({ account, amountCents }));
}

const sameLines = (a: readonly LedgerLine[], b: readonly LedgerLine[]) =>
  a.length === b.length && a.every((l, i) => l.account === b[i]!.account && l.amountCents === b[i]!.amountCents);

/**
 * `post_entry`: append-only, zero-sum, idempotent. Returns the entry id, or null when the lines net
 * to nothing. The same key with identical lines is a no-op; with different lines it throws.
 */
export function postEntry(
  w: World,
  kind: EntryKind,
  key: string,
  instanceId: string | null,
  memo: string,
  rawLines: readonly LedgerLine[],
): string | null {
  const lines = normalizeLines(rawLines);
  if (lines.length === 0) return null;
  const total = lines.reduce((a, l) => a + l.amountCents, 0);
  if (total !== 0) throw new Error(`entry ${key} does not sum to zero (${total})`);
  const existing = w.entries.find((e) => e.idempotencyKey === key);
  if (existing) {
    if (sameLines(existing.lines, lines)) return existing.id;
    throw new Error(`idempotency key ${key} reused with different lines`);
  }
  const id = `e${++w.seq}`;
  const entry: LedgerEntry = { id, kind, idempotencyKey: key, instanceId, memo, lines, createdAt: w.now };
  w.entries.push(entry);
  return id;
}

/** `account_balances`: derived by summing lines, never stored. */
export function accountBalances(entries: readonly LedgerEntry[], filter?: (e: LedgerEntry) => boolean): Map<AccountKey, number> {
  const out = new Map<AccountKey, number>();
  for (const e of entries) {
    if (filter && !filter(e)) continue;
    for (const l of e.lines) out.set(l.account, (out.get(l.account) ?? 0) + l.amountCents);
  }
  return out;
}

export function memberBalances(w: World, filter?: (e: LedgerEntry) => boolean): Record<MemberId, number> {
  const all = accountBalances(w.entries, filter);
  const out = {} as Record<MemberId, number>;
  for (const m of w.members) out[m.id] = all.get(memberAccount(m.id)) ?? 0;
  return out;
}

export function carryBalance(w: World): number {
  return accountBalances(w.entries).get(carryAccount(w.pact.id)) ?? 0;
}

export function potBalances(w: World): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of accountBalances(w.entries)) if (k.startsWith('pot:')) out.set(k.slice(4), v);
  return out;
}

/** Net posted per account for one instance (all its entries, corrections included). */
export function postedForInstance(w: World, instanceId: string): Map<AccountKey, number> {
  return accountBalances(w.entries, (e) => e.instanceId === instanceId);
}
