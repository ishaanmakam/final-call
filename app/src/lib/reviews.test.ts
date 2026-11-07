import { describe, expect, it } from 'vitest';
import type { ReviewKind, ReviewStatus } from '../api/types';
import { reviewActions, type ReviewActionInput } from './reviews';

const r = (kind: ReviewKind, status: ReviewStatus) => ({ kind, status });

const base: ReviewActionInput = {
  isMine: true,
  isParticipant: true,
  resultStatus: 'failed',
  settled: false,
  reviews: [],
};

describe('reviewActions', () => {
  it('lets you appeal your own failed result once', () => {
    expect(reviewActions(base)).toEqual({ canAppeal: true, canChallenge: false });
  });

  it.each<ReviewStatus>(['open', 'accepted', 'rejected', 'defaulted'])(
    'hides Appeal once an appeal exists (status %s)',
    (status) => {
      expect(reviewActions({ ...base, reviews: [r('appeal', status)] }).canAppeal).toBe(false);
    },
  );

  it("lets another participant challenge a success or unverified result once", () => {
    for (const resultStatus of ['success', 'unverified'] as const) {
      expect(reviewActions({ ...base, isMine: false, resultStatus })).toEqual({ canAppeal: false, canChallenge: true });
    }
  });

  it.each<ReviewStatus>(['open', 'accepted', 'rejected', 'defaulted'])(
    'hides Challenge once a challenge exists (status %s)',
    (status) => {
      expect(
        reviewActions({ ...base, isMine: false, resultStatus: 'success', reviews: [r('challenge', status)] })
          .canChallenge,
      ).toBe(false);
    },
  );

  it('a resolved review of the other kind does not block', () => {
    expect(reviewActions({ ...base, reviews: [r('challenge', 'rejected')] }).canAppeal).toBe(true);
    expect(
      reviewActions({ ...base, isMine: false, resultStatus: 'success', reviews: [r('appeal', 'accepted')] })
        .canChallenge,
    ).toBe(true);
  });

  it('any open review blocks both actions', () => {
    expect(reviewActions({ ...base, reviews: [r('challenge', 'open')] }).canAppeal).toBe(false);
    expect(
      reviewActions({ ...base, isMine: false, resultStatus: 'success', reviews: [r('appeal', 'open')] }).canChallenge,
    ).toBe(false);
  });

  it('nothing is available once settled, or for non-participants challenging', () => {
    expect(reviewActions({ ...base, settled: true })).toEqual({ canAppeal: false, canChallenge: false });
    expect(reviewActions({ ...base, isMine: false, isParticipant: false, resultStatus: 'success' }).canChallenge).toBe(
      false,
    );
  });
});
