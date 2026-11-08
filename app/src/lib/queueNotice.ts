/**
 * Copy for an offline check-in that was finally delivered (or not), shown as a toast wherever
 * the person is. The money consequence is stated plainly and only where the contract makes it so
 * (docs/UX_AUDIT.md 5.15, docs/DECISIONS.md UB3).
 */
import type { CheckinRow } from '../api/types';
import type { QueueEvent } from './checkinQueue';
import { formatDateInZone, formatTimeInZone } from './time';
import type { StateName } from '../theme/tokens';

export interface NoticeContext {
  /** the pact's title, when the instance is in the query cache */
  pactTitle?: string;
  /** ISO deadline of the instance, when cached */
  deadlineAt?: string;
  /** the pact's zone for formatting the deadline */
  tz?: string;
}

export interface QueueNotice {
  message: string;
  tone: StateName | 'neutral';
  icon: 'checkmark' | 'exclamationmark.triangle' | 'wifi.slash' | 'xmark';
}

const DELIVERED = 'Offline check-in delivered';

export function queueNotice(event: QueueEvent<CheckinRow>, ctx: NoticeContext = {}): QueueNotice {
  const pact = ctx.pactTitle ? ` for ${ctx.pactTitle}` : '';
  const tz = ctx.tz ?? 'UTC';
  if (event.type === 'sent') {
    const { verdict, server_received_at } = event.result;
    if (verdict === 'in_fence') {
      const late = ctx.deadlineAt !== undefined && Date.parse(server_received_at) > Date.parse(ctx.deadlineAt);
      const tail = late && ctx.deadlineAt ? ` It counts as unverified because it arrived after ${formatTimeInZone(ctx.deadlineAt, tz)}; no pledge moves.` : '';
      return { message: `${DELIVERED} · You were at your place${pact}.${tail}`, tone: late ? 'unverified' : 'success', icon: 'checkmark' };
    }
    if (verdict === 'out_of_fence') {
      return {
        message: `${DELIVERED} · You were outside your circle${pact}, so that day stands as missed. Appeal it in the feed if that's wrong.`,
        tone: 'forfeit',
        icon: 'exclamationmark.triangle',
      };
    }
    if (verdict === 'unjudgeable') {
      return {
        message: `${DELIVERED} · GPS was too weak to judge, so ${ctx.pactTitle ?? 'that day'} counts as unverified. No pledge moves.`,
        tone: 'unverified',
        icon: 'exclamationmark.triangle',
      };
    }
    return { message: 'Offline check-in not counted · That location looked simulated.', tone: 'forfeit', icon: 'xmark' };
  }
  if (event.type === 'rejected') {
    return { message: `Offline check-in not accepted · ${event.error}`, tone: 'forfeit', icon: 'xmark' };
  }
  const day = ctx.deadlineAt ? formatDateInZone(ctx.deadlineAt, tz) : 'that day';
  return {
    message: `Offline check-in couldn't be sent · It never reached the server within 24 hours, so ${day} stands as recorded. If you were there, appeal it in the feed.`,
    tone: 'unverified',
    icon: 'wifi.slash',
  };
}
