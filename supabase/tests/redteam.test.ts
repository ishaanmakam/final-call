// Red-team suite (night-1): ways a member could avoid paying, take money they did not earn, or be
// charged unfairly. Every test asserts the attack is BLOCKED or the honest user is safe. Tests marked
// "already safe" passed before 20261108000400_redteam_fixes.sql and are kept as regressions; the
// others failed against the previous migrations and are the proof for each fix (docs/REDTEAM.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { asService, asUser, createDb, createGroupFixture, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles. January 2030 is PST (UTC-8): a local date D
// has window D 16:00Z and deadline D 17:00Z.
const GEN_NOW = '2030-01-06T12:00:00Z'; // Sunday: generates Mon 7 .. Fri 11
const openOf = (d: string) => `${d}T16:00:00.000Z`;
const deadlineOf = (d: string) => `${d}T17:00:00.000Z`;
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const UNTIL = '2031-01-01T00:00:00Z';

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
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

async function setup(members = 3, participants?: number): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members, participants })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx;
}

function checkInAt(user: string, inst: string, fix: { lat: number | null; lng: number | null; acc: number | null }, now: string, captured = now) {
  return db.query(
    `select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $7::timestamptz)`,
    [user, inst, fix.lat, fix.lng, fix.acc, captured, now],
  );
}

/** Opens and closes the pact's instance for `date` with the given outcome per participant (fixture order). */
async function closeDay(fx: Fx, date: string, outcomes: Outcome[]): Promise<string> {
  const inst = await instanceOf(fx.pactId, date);
  await tick(openOf(date));
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed') continue;
    await checkInAt(fx.participantIds[i]!, inst, { ...placeOf(i), acc: o === 'success' ? 10 : 250 }, at(openOf(date), 10 + i));
  }
  await tick(deadlineOf(date));
  return inst;
}

const statusOf = (inst: string) => scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [inst]);
const resultOf = (inst: string, user: string) =>
  scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, user]);
const balance = (u: string) =>
  scalar<number>(db, `select coalesce(sum(balance_cents), 0)::int from public.member_balances where user_id = $1`, [u]);
const carryBalance = (pactId: string) =>
  scalar<number>(db, `select coalesce(sum(balance_cents), 0)::int from public.account_balances where kind = 'carry' and pact_id = $1`, [pactId]);
const reviewStatus = (id: string) => scalar<string>(db, `select status::text from public.reviews where id = $1`, [id]);
const openReview = (u: string, inst: string, subject: string, kind: 'appeal' | 'challenge') =>
  asUser(db, u, (d) => scalar<string>(d, `select public.open_review($1, $2, $3::review_kind, 'r', null)`, [inst, subject, kind]));
const vote = (u: string, review: string, s: boolean) => asUser(db, u, (d) => d.query(`select public.cast_vote($1, $2)`, [review, s]));
const defaultReviews = (groupId: string, until = UNTIL) =>
  asService(db, (d) => d.query(`select public.default_open_reviews($1, $2::timestamptz)`, [groupId, until]));
const systemReviews = (inst: string, subject: string) =>
  rows<{ id: string; status: string }>(db, `select id, status::text from public.reviews where instance_id = $1 and subject_user_id = $2 and system_opened order by opened_at`, [inst, subject]);

async function expectLedgerZeroSum() {
  expect(
    await scalar<number>(db, `select count(*)::int from (select entry_id from public.ledger_lines group by entry_id having sum(amount_cents) <> 0) x`),
  ).toBe(0);
}

// =============================================================================================
describe('RT-1: the opener of a challenge is not one of its voters', () => {
  it('two-person pact: challenging the other person and voting for it yourself does not turn their success into a miss', async () => {
    const fx = await setup(2);
    const [a, b] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'success']);
    expect(await statusOf(inst)).toBe('closed');
    const r = await openReview(a, inst, b, 'challenge');
    // the opener profits from acceptance: their vote must not count
    expect(await code(vote(a, r, true))).toBe('42501');
    expect(await reviewStatus(r)).toBe('open');
    expect(await resultOf(inst, b)).toBe('success');
    // nobody else can vote in a 2-person pact: at settlement the recorded result stands
    await defaultReviews(fx.groupId);
    expect(await reviewStatus(r)).toBe('defaulted');
    expect(await resultOf(inst, b)).toBe('success');
    expect(await balance(a)).toBe(0);
    expect(await balance(b)).toBe(0);
  });

  it('a lone challenger whose group stays silent does not win by default: the result stands and no money moves', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'success', 'failed']);
    const r = await openReview(a, inst, b, 'challenge');
    await vote(a, r, true).catch(() => undefined); // refused (42501) once fixed; counted before
    expect(await scalar<number>(db, `select count(*)::int from public.review_votes where review_id = $1 and voter_id = $2`, [r, a])).toBe(0);
    // c is the only eligible voter and says nothing
    await defaultReviews(fx.groupId);
    expect(await reviewStatus(r)).not.toBe('accepted');
    expect(await resultOf(inst, b)).toBe('success');
    expect(await balance(b)).toBe(250);
    expect(await balance(a)).toBe(250);
    expect(await balance(c)).toBe(-500);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction'`)).toBe(0);
  });

  it('the other members still decide: one non-opener yes in a 3-person pact accepts the challenge', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'success', 'failed']);
    const r = await openReview(a, inst, b, 'challenge');
    const voters = await rows<{ v: string }>(db, `select v::text from public._review_voters($1) v order by 1`, [r]);
    expect(voters.map((x) => x.v)).toEqual([c]);
    await vote(c, r, true);
    expect(await reviewStatus(r)).toBe('accepted');
    expect(await resultOf(inst, b)).toBe('failed');
    expect(await balance(a)).toBe(1000);
    expect(await balance(b)).toBe(-500);
    await expectLedgerZeroSum();
  });
});

// =============================================================================================
describe('RT-2: unverified results on voided days are not erased (two-person pacts could farm them)', () => {
  it('two-person pact: three unjudgeable days are counted, the third goes to a vote, and the vote revives the day with a payout', async () => {
    const fx = await setup(2);
    const [a, b] = fx.participantIds;
    await gen(GEN_NOW);
    const insts: string[] = [];
    for (const d of ['2030-01-07', '2030-01-08', '2030-01-09']) {
      const inst = await closeDay(fx, d, ['success', 'unverified']);
      insts.push(inst);
      expect(await statusOf(inst)).toBe('voided'); // one active: no money
      expect(await resultOf(inst, b)).toBe('unverified'); // the attempt that could not be judged stays on record
      expect(await resultOf(inst, a)).toBe('void');
    }
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
    expect(
      await scalar<number>(db, `select count from public.unverified_month_counts where pact_id = $1 and user_id = $2 and month = '2030-01-01'`, [fx.pactId, b]),
    ).toBe(3);
    const sys = await systemReviews(insts[2]!, b);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.status).toBe('open');
    expect(await systemReviews(insts[0]!, b)).toEqual([]);
    // the automatic challenge has no human opener: a decides it alone
    await vote(a, sys[0]!.id, true);
    expect(await reviewStatus(sys[0]!.id)).toBe('accepted');
    expect(await resultOf(insts[2]!, b)).toBe('failed');
    expect(await resultOf(insts[2]!, a)).toBe('success');
    expect(await statusOf(insts[2]!)).toBe('closed');
    expect(await balance(b)).toBe(-500);
    expect(await balance(a)).toBe(500);
    expect(await carryBalance(fx.pactId)).toBe(0);
    await expectLedgerZeroSum();
    // days 1 and 2 are untouched
    expect(await statusOf(insts[0]!)).toBe('voided');
    expect(await statusOf(insts[1]!)).toBe('voided');
    // the revived day is settled like any closed day
    await asService(db, (d) => d.query(`select public.settle_due_groups($1::timestamptz)`, ['2030-01-14T21:00:00Z']));
    expect(await statusOf(insts[2]!)).toBe('settled');
    expect(await rows(db, `select from_user, to_user, amount_cents::int from public.obligations where group_id = $1`, [fx.groupId])).toEqual([
      { from_user: b, to_user: a, amount_cents: 500 },
    ]);
  });

  it('a human challenge of an unverified result on a voided day is allowed; accepting it revives the day', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [c, inst, at(openOf('2030-01-07'), -60)]);
    await tick(openOf('2030-01-07'));
    await checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(openOf('2030-01-07'), 5));
    await checkInAt(b, inst, { lat: null, lng: null, acc: null }, at(openOf('2030-01-07'), 6));
    await tick(deadlineOf('2030-01-07'));
    expect(await statusOf(inst)).toBe('voided');
    expect(await resultOf(inst, b)).toBe('unverified');
    expect(await resultOf(inst, c)).toBe('frozen');
    const r = await openReview(a, inst, b, 'challenge');
    await vote(c, r, true); // the frozen member is on the roster and is the only eligible voter
    expect(await reviewStatus(r)).toBe('accepted');
    expect(await statusOf(inst)).toBe('closed');
    expect(await resultOf(inst, b)).toBe('failed');
    expect(await resultOf(inst, a)).toBe('success');
    expect(await resultOf(inst, c)).toBe('frozen');
    expect(await balance(a)).toBe(500);
    expect(await balance(b)).toBe(-500);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'result' and payload ->> 'instance_id' = $1`, [inst])).toBe(6);
    await expectLedgerZeroSum();
  });

  it('a late offline tap on a voided day is recorded as unverified and moves no money', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [c, inst, at(openOf('2030-01-07'), -60)]);
    await closeDay(fx, '2030-01-07', ['unverified', 'failed']); // one active (b): voided, b's miss is void
    expect(await statusOf(inst)).toBe('voided');
    expect(await resultOf(inst, b)).toBe('void');
    expect(await resultOf(inst, a)).toBe('unverified');
    await checkInAt(b, inst, { ...placeOf(1), acc: 10 }, at(deadlineOf('2030-01-07'), 30), at(deadlineOf('2030-01-07'), -5));
    expect(await resultOf(inst, b)).toBe('unverified'); // on record, counts toward b's budget
    expect(await resultOf(inst, a)).toBe('unverified');
    expect(await resultOf(inst, c)).toBe('frozen');
    expect(await statusOf(inst)).toBe('voided');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(0);
    expect(
      await scalar<number>(db, `select count from public.unverified_month_counts where pact_id = $1 and user_id = $2 and month = '2030-01-01'`, [fx.pactId, b]),
    ).toBe(1);
  });
});

// =============================================================================================
describe('RT-3: a payment marked paid or disputed is announced to the other party', () => {
  async function obligation() {
    const fx = await setup(3);
    const [a, b] = fx.userIds;
    const s = await scalar<string>(db, `insert into public.settlements (group_id, week_start) values ($1, '2030-01-07') returning id`, [fx.groupId]);
    const o = await scalar<string>(
      db,
      `insert into public.obligations (settlement_id, group_id, from_user, to_user, amount_cents) values ($1, $2, $3, $4, 725) returning id`,
      [s, fx.groupId, b, a],
    );
    return { fx, a, b, o, s };
  }
  const outbox = (kind: string) => rows<{ user_id: string; payload: any }>(db, `select user_id, payload from public.notification_outbox where kind = $1`, [kind]);

  it('mark paid queues obligation_marked_paid for the payee, with the amount, who, and the settle-up link', async () => {
    const { fx, a, b, o, s } = await obligation();
    await asUser(db, b, (d) => d.query(`select public.mark_obligation_paid($1)`, [o]));
    const rows1 = await outbox('obligation_marked_paid');
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.user_id).toBe(a);
    expect(rows1[0]!.payload).toMatchObject({
      obligation_id: o, settlement_id: s, group_id: fx.groupId, from_user: b, to_user: a, amount_cents: 725,
      from_name: 'Member 2', url: `/groups/${fx.groupId}/ledger`,
    });
    await asUser(db, b, (d) => d.query(`select public.mark_obligation_paid($1)`, [o])); // repeat: no-op, no second push
    expect(await outbox('obligation_marked_paid')).toHaveLength(1);
  });

  it('dispute queues obligation_disputed for the payer; confirm queues nothing new for the payer to act on', async () => {
    const { fx, a, b, o } = await obligation();
    await asUser(db, b, (d) => d.query(`select public.mark_obligation_paid($1)`, [o]));
    await asUser(db, a, (d) => d.query(`select public.dispute_obligation($1)`, [o]));
    const d1 = await outbox('obligation_disputed');
    expect(d1).toHaveLength(1);
    expect(d1[0]!.user_id).toBe(b);
    expect(d1[0]!.payload).toMatchObject({ obligation_id: o, group_id: fx.groupId, amount_cents: 725, to_name: 'Member 1', url: `/groups/${fx.groupId}/ledger` });
    await asUser(db, a, (d) => d.query(`select public.dispute_obligation($1)`, [o])); // pending already: no-op
    expect(await outbox('obligation_disputed')).toHaveLength(1);
    await asUser(db, a, (d) => d.query(`select public.confirm_obligation($1)`, [o]));
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind like 'obligation_%'`)).toBe(2);
  });
});

// =============================================================================================
describe('RT-4: an open appeal cannot be used to slip a third unverified day past the budget', () => {
  it('a miss appealed first, then turned unverified by a late tap, is challenged automatically once the appeal defaults', async () => {
    const fx = await setup(3);
    const [b] = [fx.participantIds[0]!];
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    const d3 = await closeDay(fx, '2030-01-09', ['failed', 'failed', 'failed']);
    expect(await resultOf(d3, b)).toBe('failed');
    const appeal = await openReview(b, d3, b, 'appeal'); // opened before the "offline" tap lands
    await checkInAt(b, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 20), at(deadlineOf('2030-01-09'), -3));
    expect(await resultOf(d3, b)).toBe('unverified'); // third this month
    expect(await systemReviews(d3, b)).toEqual([]); // suppressed while the appeal is open (one open review per result)
    await defaultReviews(fx.groupId);
    expect(await reviewStatus(appeal)).toBe('defaulted');
    expect(await resultOf(d3, b)).toBe('unverified');
    const sys = await systemReviews(d3, b);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.status).toBe('open');
  });

  it('a rejected human challenge of the third day still blocks a second (automatic) challenge of it', async () => {
    const fx = await setup(3);
    const [b, a, c] = [fx.participantIds[0]!, fx.participantIds[1]!, fx.participantIds[2]!];
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'failed', 'failed']);
    await closeDay(fx, '2030-01-08', ['unverified', 'failed', 'failed']);
    const d3 = await closeDay(fx, '2030-01-09', ['unverified', 'failed', 'failed']);
    const sys = await systemReviews(d3, b);
    expect(sys).toHaveLength(1);
    await vote(a, sys[0]!.id, false);
    await vote(c, sys[0]!.id, false);
    expect(await reviewStatus(sys[0]!.id)).toBe('rejected');
    expect(await systemReviews(d3, b)).toHaveLength(1);
    expect(await scalar<number>(db, `select count(*)::int from public.reviews where instance_id = $1 and subject_user_id = $2`, [d3, b])).toBe(1);
  });
});

// =============================================================================================
describe('already safe (regression)', () => {
  it('freeze: ISO week spanning the year boundary counts as one week', async () => {
    const fx = await setup(3);
    const [a] = fx.participantIds;
    await gen('2030-12-29T12:00:00Z'); // Sunday: Mon 2030-12-30 .. Fri 2031-01-03 are all ISO 2031-W01
    const mon = await instanceOf(fx.pactId, '2030-12-30');
    const fri = await instanceOf(fx.pactId, '2031-01-03');
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [a, mon, '2030-12-30T10:00:00Z']);
    expect(await code(db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [a, fri, '2031-01-02T10:00:00Z']))).toBe('23514');
  });

  it('an objection after a window opened does not pull the person off that day (they are still judged and charged)', async () => {
    const fx = await setup(3);
    const [a, b] = fx.participantIds;
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, '2041-06-03', now() - interval '10 minutes', now() + interval '50 minutes', 'open') returning id`,
      [fx.pactId],
    );
    // b's first place was set an hour ago (before the window opened, inside the 24 h objection window)
    const place = await scalar<string>(
      db,
      `update public.pact_participant_places set created_at = now() - interval '1 hour', effective_from = now() - interval '1 hour'
        where pact_id = $1 and user_id = $2 returning id`,
      [fx.pactId, b],
    );
    await asUser(db, a, (d) => d.query(`select public.object_place($1, 'that is a dorm')`, [place]));
    expect(await scalar<boolean>(db, `select public._on_instance_roster($1, $2)`, [inst, b])).toBe(true);
    await checkInAt(a, inst, { ...placeOf(0), acc: 10 }, new Date().toISOString());
    await db.query(`select public.tick_instances(now() + interval '1 hour')`);
    expect(await statusOf(inst)).toBe('closed');
    expect(await resultOf(inst, b)).toBe('failed');
    expect(await balance(b)).toBe(-500);
  });

  it('pausing a pact mid-window does not cancel the open day: it closes and money moves', async () => {
    const fx = await setup(3);
    const [a, b] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await tick(openOf('2030-01-07'));
    await checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(openOf('2030-01-07'), 5));
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId]));
    await tick(at(openOf('2030-01-07'), 30));
    expect(await statusOf(inst)).toBe('open');
    await tick(deadlineOf('2030-01-07'));
    expect(await statusOf(inst)).toBe('closed');
    expect(await balance(b)).toBe(-500);
    // every later scheduled day is voided by the pause
    expect(await statusOf(await instanceOf(fx.pactId, '2030-01-08'))).toBe('voided');
  });

  it('a late tap on a day cancelled by a pause is refused', async () => {
    const fx = await setup(3);
    const [a] = fx.participantIds;
    await gen(GEN_NOW);
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId]));
    await tick(at(openOf('2030-01-07'), -60));
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    expect(await statusOf(inst)).toBe('voided');
    expect(await code(checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-07'), 10), at(deadlineOf('2030-01-07'), -10)))).toBe('23514');
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1`, [inst])).toBe(0);
  });

  it('the 20-tap cap also stops late taps, so recomputations cannot be forced forever', async () => {
    const fx = await setup(3);
    const [a] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await tick(openOf('2030-01-07'));
    for (let i = 0; i < 20; i++) await checkInAt(a, inst, { lat: 47.7, lng: -122.4, acc: 10 }, at(openOf('2030-01-07'), 1 + i));
    await tick(deadlineOf('2030-01-07'));
    expect(await resultOf(inst, a)).toBe('failed');
    expect(await code(checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-07'), 30), at(deadlineOf('2030-01-07'), -1)))).toBe('23514');
    expect(await resultOf(inst, a)).toBe('failed');
  });

  it('marking an obligation paid moves no money: balances and billable balances are unchanged until the payee confirms', async () => {
    const fx = await setup(3);
    const [a, b] = fx.participantIds;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['success', 'failed', 'success']);
    await asService(db, (d) => d.query(`select public.settle_due_groups($1::timestamptz)`, ['2030-01-14T21:00:00Z']));
    const o = await scalar<string>(db, `select id from public.obligations where from_user = $1 and to_user = $2`, [b, a]);
    const before = await rows(db, `select user_id, balance_cents::int from public.billable_member_balances where group_id = $1 order by user_id`, [fx.groupId]);
    await asUser(db, b, (d) => d.query(`select public.mark_obligation_paid($1)`, [o]));
    expect(await rows(db, `select user_id, balance_cents::int from public.billable_member_balances where group_id = $1 order by user_id`, [fx.groupId])).toEqual(before);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(0);
    // the payee disputes; the next settlement bills the debt again
    await asUser(db, a, (d) => d.query(`select public.dispute_obligation($1)`, [o]));
    await asService(db, (d) => d.query(`select public.settle_due_groups($1::timestamptz)`, ['2030-01-21T21:00:00Z']));
    // b owed 250 to each of the two winners; both old rows are superseded and both debts re-billed
    expect(await rows(db, `select status::text, amount_cents::int from public.obligations where from_user = $1 order by status`, [b])).toEqual([
      { status: 'pending', amount_cents: 250 },
      { status: 'pending', amount_cents: 250 },
      { status: 'superseded', amount_cents: 250 },
      { status: 'superseded', amount_cents: 250 },
    ]);
  });

  it('a success cannot be turned into unverified by the subject\'s own late tap, nor a frozen day into anything', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [c, inst, at(openOf('2030-01-07'), -60)]);
    await closeDay(fx, '2030-01-07', ['success', 'failed']);
    await checkInAt(a, inst, { lat: null, lng: null, acc: null }, at(deadlineOf('2030-01-07'), 30), at(deadlineOf('2030-01-07'), -5));
    await checkInAt(c, inst, { ...placeOf(2), acc: 10 }, at(deadlineOf('2030-01-07'), 30), at(deadlineOf('2030-01-07'), -5));
    expect(await resultOf(inst, a)).toBe('success');
    expect(await resultOf(inst, c)).toBe('frozen');
    expect(await balance(a)).toBe(500);
    expect(await balance(b)).toBe(-500);
  });
});
