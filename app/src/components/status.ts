import type { ObligationStatus, ResultStatus, ReviewStatus } from '../api/types';
import type { MemberDayState } from '../lib/instanceStatus';
import type { BadgeTone } from './ui';

export const resultLabel: Record<ResultStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  success: { label: 'Showed up', tone: 'good' },
  failed: { label: 'Missed', tone: 'bad' },
  unverified: { label: 'Unverified', tone: 'warn' },
  frozen: { label: 'Frozen', tone: 'neutral' },
  void: { label: 'Void', tone: 'neutral' },
  excluded: { label: 'Excluded', tone: 'neutral' },
};

export const dayStateLabel: Record<MemberDayState, { label: string; tone: BadgeTone }> = {
  ...resultLabel,
  checked_in: { label: 'Checked in', tone: 'good' },
  late: { label: 'Late', tone: 'warn' },
  unjudged: { label: 'Weak GPS', tone: 'warn' },
  out_of_fence: { label: 'Not there yet', tone: 'warn' },
  waiting: { label: 'Waiting', tone: 'neutral' },
};

export const reviewStatusLabel: Record<ReviewStatus, string> = {
  open: 'Voting open',
  accepted: 'Upheld',
  rejected: 'Turned down',
  defaulted: 'No votes (default applied)',
};

export const obligationLabel: Record<ObligationStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Unpaid', tone: 'warn' },
  marked_paid: { label: 'Marked paid', tone: 'neutral' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  superseded: { label: 'Replaced', tone: 'neutral' },
};
