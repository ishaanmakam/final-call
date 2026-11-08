import { describe, expect, it } from 'vitest';
import {
  canVoteOn,
  defaultFootnote,
  myVoteText,
  openerLine,
  reviewOutcomeText,
  reviewSheetCopy,
  tally,
  tallyText,
  voteLabels,
} from './reviewCopy';

describe('openerLine', () => {
  it('names the opener, or the unverified budget when the server opened the review', () => {
    expect(openerLine('appeal', 'Priya')).toBe('Priya appealed');
    expect(openerLine('challenge', 'Maya')).toBe('Maya challenged');
    expect(openerLine('challenge', 'Priya', true)).toBe('Automatic review: 3rd unverified day this month');
  });
});

describe('vote words', () => {
  it('name the outcome, never agree / disagree', () => {
    expect(voteLabels('appeal')).toEqual({ yes: 'They showed up', no: "They didn't" });
    expect(voteLabels('challenge')).toEqual({ yes: "They didn't show up", no: 'Result stands' });
  });

  it('tally reads as a sentence with the right verb agreement', () => {
    expect(tallyText('appeal', 1, 0)).toBe("1 says they showed up, 0 say they didn't");
    expect(tallyText('appeal', 2, 1)).toBe("2 say they showed up, 1 says they didn't");
    expect(tallyText('challenge', 0, 2)).toBe("0 say they didn't show up, 2 say the result stands");
  });

  it('echoes your vote in the button words', () => {
    expect(myVoteText('appeal', true)).toBe('You said they showed up');
    expect(myVoteText('challenge', false)).toBe('You said result stands');
  });

  it('counts votes', () => {
    expect(
      tally([
        { review_id: 'r', voter_id: 'a', supports: true, cast_at: '' },
        { review_id: 'r', voter_id: 'b', supports: false, cast_at: '' },
        { review_id: 'r', voter_id: 'c', supports: true, cast_at: '' },
      ]),
    ).toEqual({ yes: 2, no: 1 });
  });
});

describe('outcomes', () => {
  it('spells out the silent default per kind: the result stands either way (N3-1), never "excluded"', () => {
    expect(defaultFootnote('appeal')).toMatch(/miss stands/);
    expect(defaultFootnote('appeal')).toMatch(/forfeit/);
    expect(defaultFootnote('appeal')).not.toMatch(/exclud/i);
    expect(defaultFootnote('challenge')).toMatch(/result stands/);
    expect(reviewOutcomeText({ kind: 'appeal', status: 'defaulted' })).toBe('No votes, so the miss stands');
    expect(reviewOutcomeText({ kind: 'challenge', status: 'defaulted' })).toBe('No votes, so the result stands');
  });

  it('uses the shared status words otherwise', () => {
    expect(reviewOutcomeText({ kind: 'appeal', status: 'open' })).toBe('Voting open');
    expect(reviewOutcomeText({ kind: 'appeal', status: 'accepted' })).toBe('Upheld');
    expect(reviewOutcomeText({ kind: 'challenge', status: 'rejected' })).toBe('Turned down');
  });
});

describe('canVoteOn', () => {
  const roster = ['me', 'priya', 'maya'];
  const appeal = { status: 'open', subject_user_id: 'priya', kind: 'appeal', opened_by: 'priya' } as const;
  it('lets other participants vote while open, and change their vote', () => {
    expect(canVoteOn({ review: appeal, userId: 'me', roster })).toBe(true);
  });
  it('refuses the subject, outsiders and closed reviews', () => {
    expect(canVoteOn({ review: { ...appeal, subject_user_id: 'me', opened_by: 'me' }, userId: 'me', roster })).toBe(false);
    expect(canVoteOn({ review: appeal, userId: 'diego', roster })).toBe(false);
    expect(canVoteOn({ review: { ...appeal, status: 'accepted' }, userId: 'me', roster })).toBe(false);
  });
  it('refuses the opener of a challenge but not other voters, nor the subject of an automatic one voting elsewhere (RT-1)', () => {
    const challenge = { status: 'open', subject_user_id: 'priya', kind: 'challenge', opened_by: 'me' } as const;
    expect(canVoteOn({ review: challenge, userId: 'me', roster })).toBe(false);
    expect(canVoteOn({ review: challenge, userId: 'maya', roster })).toBe(true);
    // the automatic (unverified-budget) challenge is opened in the subject's name: the others vote
    expect(canVoteOn({ review: { ...challenge, opened_by: 'priya' }, userId: 'me', roster })).toBe(true);
  });
});

describe('reviewSheetCopy', () => {
  it('titles the sheet with the day and names the rule', () => {
    const appeal = reviewSheetCopy('appeal', 'Mon, Nov 10', 'you');
    expect(appeal.title).toBe('Appeal Mon, Nov 10');
    expect(appeal.rule).toMatch(/Monday noon/);
    expect(appeal.rule).toMatch(/One appeal per person per day/);
    const challenge = reviewSheetCopy('challenge', 'Mon, Nov 10', 'Priya');
    expect(challenge.title).toBe("Challenge Priya's Mon, Nov 10");
    expect(challenge.rule).toMatch(/result stands/);
  });
});
