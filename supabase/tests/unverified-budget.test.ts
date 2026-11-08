import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, asService, asUser, createDb, createGroupFixture, createUser, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

// 20261108000200_unverified_budget.sql: the third unverified result for one person in one pact in one
// calendar month (pact local_date) opens an automatic challenge on that result.
//
// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles. January/February 2030 are PST (UTC-8), so a
// local date D has window D 16:00Z and deadline D 17:00Z.
const GEN_NOW = '2030-01-06T12:00:00Z'; // Sunday: generates Mon 7 .. Fri 11 (+ Sun 13 skipped)
const LATE_GEN_NOW = '2030-01-27T12:00:00Z'; // Sunday: generates Mon 28 .. Fri Feb 1
const openOf = (d: string) => `${d}T16:00:00.000Z`;
const deadlineOf = (d: string) => `${d}T17:00:00.000Z`;
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();

type Outcome = 'success' | 'failed' | 'unverified';
type Fx = GroupFixture & { pactId: string };

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

const tick = (now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const gen = (now: string) => db.query(`select public.generate_instances(7, $1::timestamptz)`, [now]);
const instanceOf = (pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });

async function setup(members = 3): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx;
}

function checkInAt(user: string, inst: string, fix: { lat: number; lng: number; acc: number }, now: string, captured = now) {
  return db.query(
    `select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $7::timestamptz)`,
    [user, inst, fix.lat, fix.lng, fix.acc, captured, now],
  );
}

/** Opens and closes the pact's instance for `date` with the given outcome per participant (in fixture order). */
async function closeDay(fx: Fx, date: string, outcomes: Outcome[], pactId = fx.pactId): Promise<string> {
  const inst = await instanceOf(pactId, date);
  await tick(openOf(date));
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed') continue;
    await checkInAt(fx.participantIds[i]!, inst, { ...placeOf(i), acc: o === 'success' ? 10 : 250 }, at(openOf(date), 10 + i));
  }
  await tick(deadlineOf(date));
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('closed');
  return inst;
}

interface ReviewRow {
  id: string;
  instance_id: string;
  subject_user_id: string;
  opened_by: string;
  kind: string;
  status: string;
  reason: string | null;
  system_opened: boolean;
}
const reviewsOf = (subject: string) =>
  rows<ReviewRow>(db, `select id, instance_id, subject_user_id, opened_by, kind, status::text, reason, system_opened from public.reviews where subject_user_id = $1 order by opened_at`, [subject]);
const resultOf = (inst: string, user: string) =>
  scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, user]);
const monthCount = (pactId: string, user: string, month: string) =>
  scalar<number | null>(db, `select count from public.unverified_month_counts where pact_id = $1 and user_id = $2 and month = $3::date`, [pactId, user, month]);

async function expectLedgerZeroSum() {
  expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBeGreaterThan(0);
  expect(
    await scalar<number>(db, `select count(*)::int from (select entry_id from public.ledger_lines group by entry_id having sum(amount_cents) <> 0) x`),
  ).toBe(0);
}

/** Three unverified Mondays-to-Wednesdays for the subject (participant 0); the others miss. */
async function threeUnverified(fx: Fx): Promise<{ subject: string; insts: string[] }> {
  const subject = fx.participantIds[0]!;
  await gen(GEN_NOW);
  const insts: string[] = [];
  for (const d of ['2030-01-07', '2030-01-08', '2030-01-09']) insts.push(await closeDay(fx, d, ['unverified', 'failed', 'failed']));
  return { subject, insts };
}

describe('unverified budget: the third unverified day in a pact-month opens an automatic challenge', () => {
  it('opens exactly one challenge on the third result, marked system_opened, with the subject as opened_by', async () => {
    const fx = await setup();
    const subject = fx.participantIds[0]!;
    await gen(GEN_NOW);

    const d1 = await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    expect(await resultOf(d1, subject)).toBe('unverified');
    expect(await reviewsOf(subject)).toEqual([]);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(1);

    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    expect(await reviewsOf(subject)).toEqual([]);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(2);

    const d3 = await closeDay(fx, '2030-01-09', ['unverified', 'failed', 'failed']);
    const reviews = await reviewsOf(subject);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      instance_id: d3,
      subject_user_id: subject,
      opened_by: subject,
      kind: 'challenge',
      status: 'open',
      system_opened: true,
    });
    expect(reviews[0]!.reason).toMatch(/more than 2 unverified/i);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(3);

    // voters are the other two roster members (the subject is excluded, as for any challenge)
    const voters = await rows<{ v: string }>(db, `select v::text from public._review_voters($1) v order by 1`, [reviews[0]!.id]);
    expect(voters.map((r) => r.v).sort()).toEqual([fx.participantIds[1], fx.participantIds[2]].sort());

    // review_opened lands with everyone on the roster (the two voters and the subject)
    const outbox = await rows<{ user_id: string; payload: any }>(
      db,
      `select user_id, payload from public.notification_outbox where kind = 'review_opened' order by user_id`,
    );
    expect(outbox.map((o) => o.user_id).sort()).toEqual([...fx.participantIds].sort());
    for (const o of outbox) {
      expect(o.payload.review_id).toBe(reviews[0]!.id);
      expect(o.payload.review_kind).toBe('challenge');
      expect(o.payload.subject_user_id).toBe(subject);
      expect(o.payload.system_opened).toBe(true);
      expect(o.payload.instance_id).toBe(d3);
    }

    // the result itself is untouched until the group votes; the ledger stays balanced
    expect(await resultOf(d3, subject)).toBe('unverified');
    await expectLedgerZeroSum();
  });

  it('a third unverified day in a different calendar month does not count', async () => {
    const fx = await setup();
    const subject = fx.participantIds[0]!;
    await gen(LATE_GEN_NOW);
    await closeDay(fx, '2030-01-30', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-31', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-02-01', ['unverified', 'failed', 'failed']);
    expect(await reviewsOf(subject)).toEqual([]);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(2);
    expect(await monthCount(fx.pactId, subject, '2030-02-01')).toBe(1);
  });

  it('a third unverified day in a different pact of the same group does not count', async () => {
    const fx = await setup();
    const subject = fx.participantIds[0]!;
    // second pact, same days and times, everyone joins at their fixture place
    const pactB = await asUser(db, fx.ownerId, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'Pact B', '{1,2,3,4,5}', '08:00', '09:00', 500, 'America/Los_Angeles')`, [fx.groupId]),
    );
    for (const [i, uid] of fx.participantIds.entries()) {
      await asUser(db, uid, (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'place')`, [pactB, placeOf(i).lat, placeOf(i).lng]));
    }
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pactB]);
    await gen(GEN_NOW);

    await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-07', ['failed', 'success', 'failed'], pactB);
    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-08', ['failed', 'success', 'failed'], pactB);
    // third unverified day, but in pact B: no challenge anywhere
    await closeDay(fx, '2030-01-09', ['failed', 'success', 'failed']);
    await closeDay(fx, '2030-01-09', ['unverified', 'success', 'failed'], pactB);
    expect(await reviewsOf(subject)).toEqual([]);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(2);
    expect(await monthCount(pactB, subject, '2030-01-01')).toBe(1);

    // the third in pact A does
    const d4 = await closeDay(fx, '2030-01-10', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-10', ['failed', 'success', 'failed'], pactB);
    const reviews = await reviewsOf(subject);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ instance_id: d4, system_opened: true, kind: 'challenge' });
    await expectLedgerZeroSum();
  });

  it('recomputing results never opens a second automatic challenge', async () => {
    const fx = await setup();
    const { subject, insts } = await threeUnverified(fx);
    const d3 = insts[2]!;
    expect(await reviewsOf(subject)).toHaveLength(1);

    // a direct recompute, a re-run of the tick, and a late in-fence tap all leave it at one
    expect(await scalar<boolean>(db, `select public._refresh_result($1, $2, $3::timestamptz)`, [d3, subject, at(deadlineOf('2030-01-09'), 1)])).toBe(false);
    await tick(at(deadlineOf('2030-01-09'), 2));
    await checkInAt(subject, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 5), at(deadlineOf('2030-01-09'), -5));
    expect(await resultOf(d3, subject)).toBe('unverified');
    expect(await reviewsOf(subject)).toHaveLength(1);

    // once the group has rejected it, a further recompute does not reopen it (one challenge per result, ever)
    const review = (await reviewsOf(subject))[0]!;
    await db.query(`select public.cast_vote_at($1, $2, false, $3::timestamptz)`, [fx.participantIds[1], review.id, at(deadlineOf('2030-01-09'), 10)]);
    await db.query(`select public.cast_vote_at($1, $2, false, $3::timestamptz)`, [fx.participantIds[2], review.id, at(deadlineOf('2030-01-09'), 11)]);
    expect((await reviewsOf(subject))[0]!.status).toBe('rejected');
    expect(await scalar<boolean>(db, `select public._refresh_result($1, $2, $3::timestamptz)`, [d3, subject, at(deadlineOf('2030-01-09'), 12)])).toBe(false);
    await tick(at(deadlineOf('2030-01-09'), 13));
    expect(await reviewsOf(subject)).toHaveLength(1);
    expect(await resultOf(d3, subject)).toBe('unverified');
    await expectLedgerZeroSum();
  });

  it('a late offline tap that turns a miss into the third unverified day opens it too', async () => {
    const fx = await setup();
    const subject = fx.participantIds[0]!;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    const d3 = await closeDay(fx, '2030-01-09', ['failed', 'failed', 'failed']);
    expect(await resultOf(d3, subject)).toBe('failed');
    expect(await reviewsOf(subject)).toEqual([]);
    const entriesBefore = await scalar<number>(db, `select count(*)::int from public.ledger_entries`);

    await checkInAt(subject, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 10), at(deadlineOf('2030-01-09'), -5));
    expect(await resultOf(d3, subject)).toBe('unverified');
    const reviews = await reviewsOf(subject);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ instance_id: d3, kind: 'challenge', status: 'open', system_opened: true });
    // the result change posted a correction; the ledger is still balanced
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction' and instance_id = $1`, [d3])).toBe(1);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBeGreaterThan(entriesBefore);
    await expectLedgerZeroSum();
  });

  it('an existing human review of the same result suppresses the automatic challenge', async () => {
    const fx = await setup();
    const subject = fx.participantIds[0]!;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    const d3 = await closeDay(fx, '2030-01-09', ['failed', 'failed', 'failed']);

    // the subject appeals the miss; the appeal is still open when a late tap turns the day unverified
    const appeal = await asUser(db, subject, (d) =>
      scalar<string>(d, `select public.open_review($1, $2, 'appeal', 'I was there', null)`, [d3, subject]),
    );
    await checkInAt(subject, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 10), at(deadlineOf('2030-01-09'), -5));
    expect(await resultOf(d3, subject)).toBe('unverified');
    expect((await reviewsOf(subject)).map((r) => [r.id, r.kind, r.system_opened])).toEqual([[appeal, 'appeal', false]]);

    // a human challenge that already exists on the result (even resolved) also suppresses it
    const d4 = await closeDay(fx, '2030-01-10', ['failed', 'failed', 'failed']);
    const human = fx.participantIds[1]!;
    await db.query(
      `insert into public.reviews (instance_id, subject_user_id, opened_by, kind, reason, status, opened_at, resolved_at)
       values ($1, $2, $3, 'challenge', 'human', 'rejected', $4::timestamptz, $4::timestamptz)`,
      [d4, subject, human, at(deadlineOf('2030-01-10'), 1)],
    );
    await checkInAt(subject, d4, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-10'), 10), at(deadlineOf('2030-01-10'), -5));
    expect(await resultOf(d4, subject)).toBe('unverified');
    const onD4 = (await reviewsOf(subject)).filter((r) => r.instance_id === d4);
    expect(onD4).toHaveLength(1);
    expect(onD4[0]).toMatchObject({ opened_by: human, system_opened: false });
    await expectLedgerZeroSum();
  });

  it('nobody votes: settlement defaults the automatic challenge and the unverified result stands', async () => {
    const fx = await setup();
    const { subject, insts } = await threeUnverified(fx);
    const review = (await reviewsOf(subject))[0]!;
    const n = await asService(db, (d) => scalar<number>(d, `select public.default_open_reviews($1, $2::timestamptz)`, [fx.groupId, '2030-01-14T20:00:00Z']));
    expect(n).toBe(1);
    expect((await reviewsOf(subject))[0]!.id).toBe(review.id);
    expect((await reviewsOf(subject))[0]!.status).toBe('defaulted');
    expect(await resultOf(insts[2]!, subject)).toBe('unverified');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction'`)).toBe(0);
    await expectLedgerZeroSum();
  });

  it('the group agrees: the day becomes missed and the ledger is corrected, balanced', async () => {
    const fx = await setup();
    const { subject, insts } = await threeUnverified(fx);
    const review = (await reviewsOf(subject))[0]!;
    const d3 = insts[2]!;
    await asUser(db, fx.participantIds[1]!, (d) => d.query(`select public.cast_vote($1, true)`, [review.id]));
    expect((await reviewsOf(subject))[0]!.status).toBe('open');
    await asUser(db, fx.participantIds[2]!, (d) => d.query(`select public.cast_vote($1, true)`, [review.id]));
    expect((await reviewsOf(subject))[0]!.status).toBe('accepted');
    expect(await resultOf(d3, subject)).toBe('failed');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction' and instance_id = $1`, [d3])).toBe(1);
    // the subject now holds a stake line for that day: -500 net on the instance
    expect(
      await scalar<number>(
        db,
        `select coalesce(sum(l.amount_cents), 0)::int from public.ledger_lines l
           join public.ledger_entries e on e.id = l.entry_id
           join public.ledger_accounts a on a.id = l.account_id
          where e.instance_id = $1 and a.kind = 'member' and a.user_id = $2`,
        [d3, subject],
      ),
    ).toBe(-500);
    expect(await monthCount(fx.pactId, subject, '2030-01-01')).toBe(2);
    await expectLedgerZeroSum();
  });

  it('unverified_month_counts is visible to group members only', async () => {
    const fx = await setup();
    const { subject } = await threeUnverified(fx);
    const member = fx.participantIds[1]!;
    const seen = await asUser(db, member, (d) =>
      rows<{ pact_id: string; user_id: string; month: string; count: number }>(d, `select pact_id, user_id, month::text, count from public.unverified_month_counts`),
    );
    expect(seen).toEqual([{ pact_id: fx.pactId, user_id: subject, month: '2030-01-01', count: 3 }]);

    const outsider = await createUser(db);
    expect(await asUser(db, outsider, (d) => rows(d, `select * from public.unverified_month_counts`))).toEqual([]);
    await expectError(asAnon(db, (d) => rows(d, `select * from public.unverified_month_counts`)), /permission denied/i);
  });

  it('a voided instance (fewer than two active) never opens one', async () => {
    const fx = await setup(2);
    const subject = fx.participantIds[0]!;
    await gen(GEN_NOW);
    for (const d of ['2030-01-07', '2030-01-08', '2030-01-09']) {
      const inst = await instanceOf(fx.pactId, d);
      await tick(openOf(d));
      await checkInAt(subject, inst, { ...placeOf(0), acc: 250 }, at(openOf(d), 10));
      await tick(deadlineOf(d));
      expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('voided');
    }
    expect(await reviewsOf(subject)).toEqual([]);
    expect((await monthCount(fx.pactId, subject, '2030-01-01')) ?? null).toBeNull();
  });
});
