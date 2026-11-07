import type { ResultStatus, ReviewKind, ReviewStatus } from '../api/types';

export interface ReviewActionInput {
  /** the result belongs to the current user */
  isMine: boolean;
  /** the current user is a participant of the pact */
  isParticipant: boolean;
  resultStatus: ResultStatus;
  settled: boolean;
  /** reviews for this subject + instance, any status */
  reviews: readonly { kind: ReviewKind; status: ReviewStatus }[];
}

/** Each person can be appealed at most once and challenged at most once per instance. */
export function reviewActions(i: ReviewActionInput): { canAppeal: boolean; canChallenge: boolean } {
  const anyOpen = i.reviews.some((r) => r.status === 'open');
  const has = (kind: ReviewKind) => i.reviews.some((r) => r.kind === kind);
  const available = !i.settled && !anyOpen;
  return {
    canAppeal: available && i.isMine && i.resultStatus === 'failed' && !has('appeal'),
    canChallenge:
      available &&
      !i.isMine &&
      i.isParticipant &&
      (i.resultStatus === 'success' || i.resultStatus === 'unverified') &&
      !has('challenge'),
  };
}
