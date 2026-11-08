/**
 * How the check-in screen waits for the server at gate close. Cron closes due instances once a
 * minute and posts results and ledger lines in the same transaction, so a result row means the
 * money is final. From the deadline the instance query polls every 10 s until my result exists (or
 * the instance has left the window without me on its roster), for three minutes at most; after
 * that the card says to pull to refresh. Pure, so it is unit-tested.
 */
import type { InstanceStatus } from '../api/types';

export const GATE_CLOSE_POLL_MS = 10_000;
export const GATE_CLOSE_POLL_FOR_MS = 3 * 60_000;

export interface GatePollInput {
  instance: { deadline_at: string; status: InstanceStatus };
  /** null = not on this pact (nothing to wait for) */
  myPlace: unknown | null;
  myResult: { status: string } | null;
}

export function gateClosePollInterval(d: GatePollInput | undefined, nowMs: number): number | false {
  if (!d) return false;
  const deadline = Date.parse(d.instance.deadline_at);
  if (!Number.isFinite(deadline) || nowMs < deadline || nowMs - deadline > GATE_CLOSE_POLL_FOR_MS) return false;
  const notClosed = d.instance.status === 'scheduled' || d.instance.status === 'open';
  const mineMissing = d.myPlace !== null && (d.myResult === null || d.myResult.status === 'pending');
  return notClosed || mineMissing ? GATE_CLOSE_POLL_MS : false;
}
