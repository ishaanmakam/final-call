/**
 * Words for reviews. Vote buttons name the outcome, never "agree / disagree", because "agree"
 * has no referent when a friend is appealing a missed day.
 */
import type { ReviewKind, ReviewRow, ReviewStatus, ReviewVoteRow } from '../../api/types';
import { reviewStatusLabel } from '../../components/status';

export interface VoteLabels {
  /** the button for `supports: true` */
  yes: string;
  /** the button for `supports: false` */
  no: string;
}

export function voteLabels(kind: ReviewKind): VoteLabels {
  return kind === 'appeal'
    ? { yes: 'They showed up', no: "They didn't" }
    : { yes: "They didn't show up", no: 'Result stands' };
}

export const kindLabel: Record<ReviewKind, string> = { appeal: 'Appeal', challenge: 'Challenge' };

/** "1 says they showed up, 0 say they didn't" */
export function tallyText(kind: ReviewKind, yes: number, no: number): string {
  const says = (count: number) => (count === 1 ? 'says' : 'say');
  return kind === 'appeal'
    ? `${yes} ${says(yes)} they showed up, ${no} ${says(no)} they didn't`
    : `${yes} ${says(yes)} they didn't show up, ${no} ${says(no)} the result stands`;
}

/** What you said, in the same words as the buttons. */
export function myVoteText(kind: ReviewKind, supports: boolean): string {
  const l = voteLabels(kind);
  const words = supports ? l.yes : l.no;
  return `You said ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

/**
 * What happens if the group stays silent; the one rule a voter needs. Either kind: the result
 * stands (N3-1: an unvoted appeal no longer excludes the day, so appealing every miss gains nothing).
 */
export function defaultFootnote(kind: ReviewKind): string {
  return kind === 'appeal'
    ? 'If nobody votes by Monday noon, the miss stands and the pledge is forfeited.'
    : 'If nobody votes by Monday noon, the result stands.';
}

/** Status words from status.ts, with the defaulted case spelled out per kind. */
export function reviewOutcomeText(review: Pick<ReviewRow, 'kind' | 'status'>): string {
  if (review.status === 'defaulted') {
    return review.kind === 'appeal' ? 'No votes, so the miss stands' : 'No votes, so the result stands';
  }
  return reviewStatusLabel[review.status];
}

export const reviewStatusIsFinal = (status: ReviewStatus): boolean => status !== 'open';

export interface VoteEligibilityInput {
  review: Pick<ReviewRow, 'status' | 'subject_user_id' | 'kind' | 'opened_by'>;
  userId: string;
  /** users with a result row on the instance: who the server lets vote */
  roster: readonly string[];
}

/**
 * Voting stays open to every other participant while the review is open, and a vote can be changed.
 * The opener of a challenge does not vote on it (RT-1: they profit from acceptance); the server's
 * `_review_voters` refuses them with 42501, so the buttons are not shown.
 */
export function canVoteOn(i: VoteEligibilityInput): boolean {
  return (
    i.review.status === 'open' &&
    i.review.subject_user_id !== i.userId &&
    !(i.review.kind === 'challenge' && i.review.opened_by === i.userId) &&
    i.roster.includes(i.userId)
  );
}

export function tally(votes: readonly ReviewVoteRow[]): { yes: number; no: number } {
  const yes = votes.filter((v) => v.supports).length;
  return { yes, no: votes.length - yes };
}

/** "{Opener} appealed" / "{Opener} challenged"; the unverified-budget challenge has no opener (N2-2). */
export function openerLine(kind: ReviewKind, opener: string, systemOpened = false): string {
  if (systemOpened) return 'Automatic review: 3rd unverified day this month';
  return `${opener} ${kind === 'appeal' ? 'appealed' : 'challenged'}`;
}

export interface ReviewSheetCopy {
  title: string;
  fieldLabel: string;
  placeholder: string;
  /** one sentence saying what happens next */
  rule: string;
}

export function reviewSheetCopy(kind: ReviewKind, dayLabel: string, subjectName: string): ReviewSheetCopy {
  const rule =
    kind === 'appeal'
      ? `The others in that day vote. Most votes win; a tie keeps the result. ${defaultFootnote('appeal')} One appeal per person per day.`
      : `The others in that day vote. Most votes win; a tie keeps the result. ${defaultFootnote('challenge')} One challenge per person per day.`;
  return kind === 'appeal'
    ? {
        title: `Appeal ${dayLabel}`,
        fieldLabel: 'What happened?',
        placeholder: 'I was in the back row, GPS put me in the courtyard.',
        rule,
      }
    : {
        title: `Challenge ${subjectName}'s ${dayLabel}`,
        fieldLabel: 'What happened?',
        placeholder: 'They left the building before 9.',
        rule,
      };
}

export const REASON_MIN_LENGTH = 3;
export const REASON_ERROR = 'Say briefly what happened.';
