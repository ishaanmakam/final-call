import type { ObligationStatus, ResultStatus, ReviewStatus } from '../api/types';
import type { MemberDayState } from '../lib/instanceStatus';
import { glossary, type StateName } from '../theme/tokens';

/** Tone a pill is drawn in: a state color pair from the palette, or the tint. */
export type PillTone = StateName | 'tint';

/** Old badge tone names still used by a few screens until phase 2 migrates them. */
export type BadgeTone = PillTone | 'good' | 'bad' | 'warn' | 'neutral';

export const legacyTone: Record<'good' | 'bad' | 'warn' | 'neutral', PillTone> = {
  good: 'success',
  bad: 'forfeit',
  warn: 'unverified',
  neutral: 'pending',
};

export const resolveTone = (tone: BadgeTone): PillTone =>
  tone === 'good' || tone === 'bad' || tone === 'warn' || tone === 'neutral' ? legacyTone[tone] : tone;

export const resultLabel: Record<ResultStatus, { label: string; tone: PillTone }> = {
  pending: { label: glossary.pending, tone: 'pending' },
  success: { label: glossary.success, tone: 'success' },
  failed: { label: glossary.failed, tone: 'forfeit' },
  // A settled Unverified moved no money, so it is drawn neutral (UB2/U2); amber is kept for live
  // in-window guidance (Weak GPS, Not there yet, Late) and for Unpaid, where another action helps.
  unverified: { label: glossary.unverified, tone: 'pending' },
  frozen: { label: glossary.frozen, tone: 'frozen' },
  void: { label: glossary.void, tone: 'void' },
  excluded: { label: glossary.excluded, tone: 'excluded' },
};

/** Live state of a member on a day, before and after the result posts. */
export const dayStateLabel: Record<MemberDayState | 'pending', { label: string; tone: PillTone }> = {
  ...resultLabel,
  checked_in: { label: 'Checked in', tone: 'success' },
  late: { label: 'Late', tone: 'unverified' },
  unjudged: { label: 'Weak GPS', tone: 'unverified' },
  out_of_fence: { label: 'Not there yet', tone: 'unverified' },
  waiting: { label: glossary.pending, tone: 'pending' },
};

export type DayState = keyof typeof dayStateLabel;

export const reviewStatusLabel: Record<ReviewStatus, string> = {
  open: 'Voting open',
  accepted: 'Upheld',
  rejected: 'Turned down',
  defaulted: 'No votes, default applied',
};

export const reviewStatusTone: Record<ReviewStatus, PillTone> = {
  open: 'tint',
  accepted: 'success',
  rejected: 'void',
  defaulted: 'pending',
};

export const obligationLabel: Record<ObligationStatus, { label: string; tone: PillTone }> = {
  pending: { label: 'Unpaid', tone: 'unverified' },
  marked_paid: { label: 'Marked paid', tone: 'frozen' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  superseded: { label: 'Replaced', tone: 'pending' },
};
