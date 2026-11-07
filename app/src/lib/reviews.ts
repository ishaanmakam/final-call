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

/**
 * Storage path for appeal evidence. The review-photos bucket policy requires
 * `<group_id>/<uploader user_id>/<file>`: folder 1 must be a group the uploader belongs to.
 */
export function reviewPhotoPath(p: { groupId: string; userId: string; nowMs: number; mimeType: string | null | undefined }): string {
  const subtype = p.mimeType?.split('/')[1]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  const ext = subtype === '' || subtype === 'jpeg' ? 'jpg' : subtype;
  return `${p.groupId}/${p.userId}/${p.nowMs}.${ext}`;
}
