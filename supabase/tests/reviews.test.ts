import { beforeEach, describe, expect, it } from 'vitest';
import {
  asAnon,
  asService,
  asUser,
  createDb,
  createGroupFixture,
  createUser,
  expectError,
  rows,
  scalar,
  type DB,
  type GroupFixture,
} from './helpers/db';

// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles; Monday 2030-01-07 is 16:00Z-17:00Z (PST).
const GEN_NOW = '2030-01-06T12:00:00Z';
const MON = '2030-01-07';
const MON_OPEN = '2030-01-07T16:00:00.000Z';
const MON_DEADLINE = '2030-01-07T17:00:00.000Z';
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();

type Outcome = 'success' | 'failed' | 'unverified';

let db: DB;
beforeEach(async () => {
  db = await createDb();
  await db.exec(`
    create table public._spy (n serial, fn text, instance_id uuid);
    create or replace function public.post_instance_payout(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
      as $$ begin insert into public._spy (fn, instance_id) values ('payout', p_instance); end $$;
    create or replace function public.apply_instance_correction(p_instance uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp
      as $$ begin insert into public._spy (fn, instance_id) values ('correction', p_instance); end $$;
  `);
});
const corrections = (inst: string) =>
  scalar<number>(db, `select count(*)::int from public._spy where fn = 'correction' and instance_id = $1`, [inst]);

/** Group whose pact has one Monday instance, closed with the given outcomes per participant (in order). */
async function closedInstance(outcomes: Outcome[], extraMembers = 0): Promise<{ fx: GroupFixture & { pactId: string }; inst: string; u: string[] }> {
  const fx = (await createGroupFixture(db, { members: outcomes.length + extraMembers, participants: outcomes.length })) as GroupFixture & { pactId: string };
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  await db.query(`select public.generate_instances(1, $1::timestamptz)`, [GEN_NOW]);
  const inst = await scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [fx.pactId, MON]);
  await db.query(`select public.tick_instances($1::timestamptz)`, [MON_OPEN]);
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed') continue;
    await db.query(`select public.check_in_at($1, $2, $3, -122.3035, $4, $5::timestamptz, false, null, $5::timestamptz)`, [
      fx.participantIds[i], inst, 47.6553 + i * 0.01, o === 'success' ? 10 : 250, at(MON_OPEN, 10 + i),
    ]);
  }
  await db.query(`select public.tick_instances($1::timestamptz)`, [MON_DEADLINE]);
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('closed');
  return { fx, inst, u: fx.participantIds };
}

const open = (user: string, inst: string, subject: string, kind: 'appeal' | 'challenge', reason = 'because') =>
  asUser(db, user, (d) => scalar<string>(d, `select public.open_review($1, $2, $3::review_kind, $4, null)`, [inst, subject, kind, reason]));
const vote = (user: string, review: string, supports: boolean | null) =>
  asUser(db, user, (d) => d.query(`select public.cast_vote($1, $2)`, [review, supports]));
const resultOf = async (inst: string, user: string) => {
  const r = await rows<{ status: string; first_success_at: Date | null }>(
    db, `select status::text, first_success_at from public.results where instance_id = $1 and user_id = $2`, [inst, user]);
  return { status: r[0].status, first: r[0].first_success_at?.toISOString() ?? null };
};
const reviewStatus = (id: string) => scalar<string>(db, `select status::text from public.reviews where id = $1`, [id]);
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

describe('open_review', () => {
  it('appeals: only the subject, only on their own failed result; notifies the other participants', async () => {
    const { fx, inst, u } = await closedInstance(['success', 'success', 'failed', 'unverified']);
    const [a, b, c, d] = u;
    expect(await code(open(a, inst, c, 'appeal'))).toBe('42501');
    expect(await code(open(a, inst, a, 'appeal'))).toBe('23514');
    expect(await code(open(d, inst, d, 'appeal'))).toBe('23514');
    const id = await open(c, inst, c, 'appeal', 'GPS died in the basement');
    expect(await rows(db, `select instance_id, subject_user_id, opened_by, kind::text, reason, status::text from public.reviews`)).toEqual([
      { instance_id: inst, subject_user_id: c, opened_by: c, kind: 'appeal', reason: 'GPS died in the basement', status: 'open' },
    ]);
    const out = await rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = 'review_opened'`);
    expect(out.map((o) => o.user_id).sort()).toEqual([a, b, d].sort());
    expect(out[0].payload).toMatchObject({
      review_kind: 'appeal', subject_user_id: c, subject_name: 'Member 3', opener_name: 'Member 3', pact_title: '9am class',
      review_id: id, instance_id: inst, pact_id: fx.pactId, group_id: fx.groupId,
    });
    expect(await code(open(c, inst, c, 'appeal'))).toBe('23514'); // one open review per subject
  });

  it('at most one appeal and one challenge per subject per instance, whatever their outcome', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'failed', 'unverified']);
    const [a, b, c, d] = u;
    const ap = await open(c, inst, c, 'appeal');
    await vote(a, ap, false);
    await vote(b, ap, false);
    expect(await reviewStatus(ap)).toBe('rejected');
    expect(await code(open(c, inst, c, 'appeal'))).toBe('23514');
    const ch = await open(a, inst, d, 'challenge');
    await vote(b, ch, false);
    await vote(c, ch, false);
    expect(await reviewStatus(ch)).toBe('rejected');
    expect(await code(open(b, inst, d, 'challenge'))).toBe('23514');
    await open(c, inst, a, 'challenge'); // another subject is fine
    expect(await scalar(db, `select count(*)::int from public.reviews`)).toBe(3);
  });

  it('challenges: any other participant, only on success or unverified; one open review per subject', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'failed', 'unverified']);
    const [a, b, c, d] = u;
    expect(await code(open(a, inst, a, 'challenge'))).toBe('42501');
    expect(await code(open(b, inst, c, 'challenge'))).toBe('23514');
    const r1 = await open(b, inst, a, 'challenge');
    expect(await code(open(d, inst, a, 'challenge'))).toBe('23514');
    await open(a, inst, d, 'challenge');
    expect(await scalar(db, `select count(*)::int from public.reviews where status = 'open'`)).toBe(2);
    const out = await rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = 'review_opened' and payload->>'review_id' = $1`, [r1]);
    expect(out.map((o) => o.user_id).sort()).toEqual([a, c, d].sort()); // everyone but the opener, subject included
    expect(out[0].payload).toMatchObject({ review_kind: 'challenge', subject_name: 'Member 1', opener_name: 'Member 2' });
  });

  it('rejects non-participants, outsiders, anon, and instances that are not closed', async () => {
    const { fx, inst, u } = await closedInstance(['success', 'failed', 'failed'], 1);
    const notInPact = fx.userIds[3];
    const outsider = await createUser(db);
    expect(await code(open(notInPact, inst, u[0], 'challenge'))).toBe('42501');
    expect(await code(open(outsider, inst, u[0], 'challenge'))).toBe('42501');
    expect(await code(open(u[1], gen_uuid(), u[1], 'appeal'))).toBe('P0002');
    await asAnon(db, (d) => expectError(d.query(`select public.open_review($1, $2, 'appeal', null, null)`, [inst, u[1]]), /permission denied/));
    for (const s of ['open', 'settled', 'voided']) {
      await db.query(`update public.pact_instances set status = $2::instance_status where id = $1`, [inst, s]);
      expect(await code(open(u[1], inst, u[1], 'appeal')), s).toBe('23514');
    }
    await asUser(db, u[0], (d) =>
      expectError(d.query(`insert into public.reviews (instance_id, subject_user_id, opened_by, kind) values ($1, $2, $2, 'appeal')`, [inst, u[0]]), /permission denied/),
    );
  });
});

const gen_uuid = () => '00000000-0000-4000-8000-0000000000ff';

describe('cast_vote', () => {
  it('accepted appeal resolves early on a majority of eligible voters: failed -> success at the deadline', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'failed', 'failed']);
    const [a, b, c, d] = u;
    const id = await open(c, inst, c, 'appeal');
    expect(await code(vote(c, id, true))).toBe('42501'); // subject never votes
    expect(await code(vote(await createUser(db), id, true))).toBe('42501');
    expect(await code(vote(a, id, null))).toBe('22023');
    await vote(a, id, true);
    expect(await reviewStatus(id)).toBe('open'); // 1 of 3 is not a majority
    expect(await corrections(inst)).toBe(0);
    await vote(b, id, true);
    expect(await reviewStatus(id)).toBe('accepted');
    expect(await scalar(db, `select resolved_at is not null from public.reviews where id = $1`, [id])).toBe(true);
    expect(await resultOf(inst, c)).toEqual({ status: 'success', first: MON_DEADLINE });
    expect(await corrections(inst)).toBe(1);
    expect(await code(vote(d, id, false))).toBe('23514'); // already resolved
  });

  it('accepted challenge turns success into failed; the opener may vote', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'failed']);
    const [a, b, c] = u;
    const id = await open(a, inst, b, 'challenge');
    await vote(a, id, true);
    expect(await reviewStatus(id)).toBe('open'); // 1 of 2 eligible (a, c)
    await vote(c, id, true);
    expect(await reviewStatus(id)).toBe('accepted');
    expect(await resultOf(inst, b)).toEqual({ status: 'failed', first: null });
    expect(await corrections(inst)).toBe(1);
  });

  it('majority against rejects early and leaves the result unchanged; votes can be changed while open', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'failed', 'failed', 'failed']);
    const [a, b, c, d, e] = u;
    const id = await open(c, inst, c, 'appeal');
    await vote(a, id, true);
    await vote(a, id, false); // changed mind
    expect(await rows(db, `select voter_id, supports from public.review_votes`)).toEqual([{ voter_id: a, supports: false }]);
    await vote(b, id, false);
    expect(await reviewStatus(id)).toBe('open'); // 2 of 4 is not more than half
    await vote(d, id, false);
    expect(await reviewStatus(id)).toBe('rejected');
    expect(await resultOf(inst, c)).toEqual({ status: 'failed', first: null });
    expect(await code(vote(e, id, true))).toBe('23514');
  });

  it('voters are the instance roster: later joiners cannot vote; a participant who left after the window still can', async () => {
    const { fx, inst, u } = await closedInstance(['success', 'success', 'failed', 'success'], 1);
    const [a, b, c, d] = u;
    const late = fx.userIds[4];
    await asUser(db, late, (x) => x.query(`select public.join_pact($1, 47.7, -122.4, 100, 'late')`, [fx.pactId]));
    // superuser fixture: d left the pact after the window opened (leave_group refuses mid-window)
    await db.query(`update public.pact_participants set left_at = $3 where pact_id = $1 and user_id = $2`, [fx.pactId, d, at(MON_OPEN, 30)]);
    expect(await code(open(late, inst, a, 'challenge'))).toBe('42501'); // not on the roster: cannot open either
    const id = await open(c, inst, c, 'appeal'); // eligible: a, b, d
    const notified = await rows<{ user_id: string }>(db, `select user_id from public.notification_outbox where kind = 'review_opened'`);
    expect(notified.map((n) => n.user_id).sort()).toEqual([a, b, d].sort());
    expect(await code(vote(late, id, true))).toBe('42501');
    await vote(a, id, true);
    expect(await reviewStatus(id)).toBe('open'); // 1 of 3
    await vote(d, id, true);
    expect(await reviewStatus(id)).toBe('accepted');
  });

  it('an accepted challenge on an unverified result survives a later offline check-in', async () => {
    const { inst, u } = await closedInstance(['success', 'success', 'unverified']);
    const [a, b, c] = u;
    const id = await open(a, inst, c, 'challenge');
    await vote(a, id, true);
    await vote(b, id, true);
    expect(await resultOf(inst, c)).toEqual({ status: 'failed', first: null });
    await db.query(`select public.check_in_at($1, $2, 47.6753, -122.3035, 10, $3::timestamptz, false, null, $4::timestamptz)`, [
      c, inst, at(MON_DEADLINE, -5), at(MON_DEADLINE, 30),
    ]);
    expect(await resultOf(inst, c)).toEqual({ status: 'failed', first: null });
  });
});

describe('default_open_reviews', () => {
  it('resolves by majority of votes cast (tie rejected, none defaulted) and applies outcomes', async () => {
    const { fx, inst, u } = await closedInstance(['success', 'success', 'failed', 'failed', 'failed']);
    const [a, b, c, d, e] = u;
    const other = await closedInstance(['success', 'failed']);
    const otherReview = await open(other.u[1], other.inst, other.u[1], 'appeal');

    const appealNoVotes = await open(c, inst, c, 'appeal');
    const challengeTie = await open(b, inst, a, 'challenge');
    await vote(d, challengeTie, true);
    await vote(e, challengeTie, false);
    const appealOneVote = await open(d, inst, d, 'appeal');
    await vote(a, appealOneVote, true);
    const challengeNoVotes = await open(e, inst, b, 'challenge');

    const run = (until: string) => asService(db, (x) => scalar<number>(x, `select public.default_open_reviews($1, $2::timestamptz)`, [fx.groupId, until]));
    expect(await run(MON_DEADLINE)).toBe(0); // only instances whose deadline is before p_until
    expect(await scalar(db, `select count(*)::int from public.reviews where status = 'open'`)).toBe(5);
    expect(await run(at(MON_DEADLINE, 60 * 24))).toBe(4);

    expect(await reviewStatus(appealNoVotes)).toBe('defaulted');
    expect(await reviewStatus(challengeTie)).toBe('rejected');
    expect(await reviewStatus(appealOneVote)).toBe('accepted');
    expect(await reviewStatus(challengeNoVotes)).toBe('defaulted');
    expect(await reviewStatus(otherReview)).toBe('open');
    // stamped with the job's time, not the wall clock
    expect(await scalar(db, `select resolved_at from public.reviews where id = $1`, [appealNoVotes])).toEqual(new Date(at(MON_DEADLINE, 60 * 24)));

    expect(await resultOf(inst, a)).toEqual({ status: 'success', first: at(MON_OPEN, 10) });
    expect(await resultOf(inst, b)).toEqual({ status: 'success', first: at(MON_OPEN, 11) });
    expect(await resultOf(inst, c)).toEqual({ status: 'excluded', first: null });
    expect(await resultOf(inst, d)).toEqual({ status: 'success', first: MON_DEADLINE });
    expect(await resultOf(inst, e)).toEqual({ status: 'failed', first: null });
    expect(await corrections(inst)).toBeGreaterThanOrEqual(1);
    expect(await run(at(MON_DEADLINE, 60 * 24))).toBe(0);
  });
});

describe('RLS', () => {
  it('non-members see no reviews or votes; members see both', async () => {
    const { fx, inst, u } = await closedInstance(['success', 'failed', 'failed'], 1);
    const id = await open(u[1], inst, u[1], 'appeal');
    await vote(u[0], id, true);
    const outsider = await createUser(db);
    const count = (who: string, t: string) => asUser(db, who, (d) => scalar<number>(d, `select count(*)::int from public.${t}`));
    expect(await count(outsider, 'reviews')).toBe(0);
    expect(await count(outsider, 'review_votes')).toBe(0);
    expect(await count(fx.userIds[3], 'reviews')).toBe(1); // group member who is not in the pact can read
    expect(await count(fx.userIds[3], 'review_votes')).toBe(1);
    await asUser(db, u[0], (d) => expectError(d.query(`update public.reviews set status = 'accepted'`), /permission denied/));
    await asUser(db, u[0], (d) => expectError(d.query(`insert into public.review_votes (review_id, voter_id, supports) values ($1, $2, true)`, [id, u[2]]), /permission denied/));
  });
});
