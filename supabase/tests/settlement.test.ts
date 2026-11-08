import { beforeEach, describe, expect, it } from 'vitest';
import { simplifyDebts } from '../../packages/rules/src/index';
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

type Status = 'success' | 'failed' | 'unverified' | 'frozen' | 'void' | 'excluded';
type R = [userId: string, status: Status, firstSuccessAt?: string | null];

async function closedInstance(
  db: DB,
  pactId: string,
  localDate: string,
  results: R[],
  status = 'closed',
): Promise<string> {
  const id = await scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
     select $1, d, t - interval '1 hour', t, $3::public.instance_status, t
       from (select $2::date d, ($2::date + time '09:00') at time zone p.tz t from public.pacts p where p.id = $1) x
     returning id`,
    [pactId, localDate, status],
  );
  for (const [uid, st, fsa] of results) {
    await db.query(`insert into public.results (instance_id, user_id, status, first_success_at) values ($1, $2, $3, $4)`, [
      id,
      uid,
      st,
      st === 'success' ? (fsa ?? `${localDate}T15:30:00Z`) : null,
    ]);
  }
  return id;
}

const settle = (db: DB, now: string) =>
  asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
const payout = (db: DB, id: string) => asService(db, (d) => d.query(`select public.post_instance_payout($1)`, [id]));
const correct = (db: DB, id: string) => asService(db, (d) => d.query(`select public.apply_instance_correction($1)`, [id]));

const settlements = (db: DB, groupId: string) =>
  rows<{ id: string; week_start: string }>(
    db,
    `select id, week_start::text from public.settlements where group_id = $1 order by week_start`,
    [groupId],
  );
const obligations = (db: DB, groupId: string, status?: string) =>
  rows<{ id: string; from_user: string; to_user: string; amount_cents: number; status: string; week_start: string }>(
    db,
    `select o.id, o.from_user::text, o.to_user::text, o.amount_cents::bigint amount_cents, o.status::text, s.week_start::text
       from public.obligations o join public.settlements s on s.id = o.settlement_id
      where o.group_id = $1 and ($2::text is null or o.status::text = $2)
      order by s.week_start, o.from_user, o.to_user`,
    [groupId, status ?? null],
  );
const balances = async (db: DB, groupId: string): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await rows<{ user_id: string; b: number }>(
        db,
        `select user_id::text, balance_cents::bigint b from public.member_balances where group_id = $1`,
        [groupId],
      )
    ).map((r) => [r.user_id, Number(r.b)]),
  );
const instStatus = (db: DB, id: string) =>
  scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [id]);

let db: DB;
let fx: GroupFixture;
let pact: string;
let u: string[];

async function freshGroup(createdAt: string, members = 3, tz = 'America/Los_Angeles') {
  db = await createDb();
  fx = await createGroupFixture(db, { members, tz });
  pact = fx.pactId!;
  u = [...fx.userIds].sort();
  await db.query(`update public.groups set created_at = $2 where id = $1`, [fx.groupId, createdAt]);
}

describe('settle_due_groups timing', () => {
  it('settles at Monday 12:00 local, not 11:59 (America/Los_Angeles, week ending on the DST fall-back Sunday)', async () => {
    await freshGroup('2026-10-28T19:00:00Z');
    const i = await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    // Week Mon 2026-10-26 .. Sun 2026-11-01 (DST ends 11-01). Mon 11-02 12:00 PST = 20:00Z.
    expect(await settle(db, '2026-11-02T19:00:00Z')).toBe(0); // 12:00 PDT would be wrong: 11:00 PST
    expect(await settle(db, '2026-11-02T19:59:59Z')).toBe(0);
    expect(await settlements(db, fx.groupId)).toEqual([]);
    expect(await instStatus(db, i)).toBe('closed');
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    expect((await settlements(db, fx.groupId)).map((s) => s.week_start)).toEqual(['2026-10-26']);
    expect(await instStatus(db, i)).toBe('settled');
    // the unposted closed instance was posted at settlement
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 500, [u[1]]: -500 });
    expect((await obligations(db, fx.groupId)).map((o) => [o.from_user, o.to_user, Number(o.amount_cents), o.status])).toEqual([
      [u[1], u[0], 500, 'pending'],
    ]);
  });

  it('spring-forward week: Mon 2027-03-15 12:00 PDT = 19:00Z', async () => {
    await freshGroup('2027-03-10T20:00:00Z');
    expect(await settle(db, '2027-03-15T18:59:00Z')).toBe(0);
    expect(await settle(db, '2027-03-15T19:00:00Z')).toBe(1);
    expect((await settlements(db, fx.groupId)).map((s) => s.week_start)).toEqual(['2027-03-08']);
  });

  it('uses the group settlement_tz', async () => {
    await freshGroup('2026-10-28T03:00:00Z', 2, 'Asia/Tokyo'); // Wed 12:00 JST
    // Week 2026-10-26 in Tokyo; Mon 11-02 12:00 JST = 03:00Z
    expect(await settle(db, '2026-11-02T02:59:00Z')).toBe(0);
    expect(await settle(db, '2026-11-02T03:00:00Z')).toBe(1);
  });

  it('is idempotent: re-running settles nothing new', async () => {
    await freshGroup('2026-10-28T19:00:00Z');
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    const obs = await obligations(db, fx.groupId);
    const entries = await scalar<number>(db, `select count(*)::int from public.ledger_entries`);
    const notes = await scalar<number>(db, `select count(*)::int from public.notification_outbox`);
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(0);
    expect(await settle(db, '2026-11-03T20:00:00Z')).toBe(0);
    expect(await obligations(db, fx.groupId)).toEqual(obs);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(entries);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox`)).toBe(notes);
    expect(await settlements(db, fx.groupId)).toHaveLength(1);
  });

  it('catches up two missed weeks in order; earlier obligations are superseded; next-week instances stay closed', async () => {
    await freshGroup('2026-10-14T19:00:00Z');
    const w1 = await closedInstance(db, pact, '2026-10-14', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    const w2 = await closedInstance(db, pact, '2026-10-21', [
      [u[0], 'success'],
      [u[2], 'failed'],
    ]);
    const nextMonday = await closedInstance(db, pact, '2026-10-26', [
      [u[1], 'success'],
      [u[2], 'failed'],
    ]);
    const voided = await closedInstance(db, pact, '2026-10-15', [[u[0], 'void']], 'voided');
    // Tue 2026-10-27 13:00 PDT: weeks of 10-12 and 10-19 are due, week of 10-26 is not.
    expect(await settle(db, '2026-10-27T20:00:00Z')).toBe(2);
    expect((await settlements(db, fx.groupId)).map((s) => s.week_start)).toEqual(['2026-10-12', '2026-10-19']);
    expect(await instStatus(db, w1)).toBe('settled');
    expect(await instStatus(db, w2)).toBe('settled');
    expect(await instStatus(db, nextMonday)).toBe('closed');
    expect(await instStatus(db, voided)).toBe('voided');
    expect(
      (await obligations(db, fx.groupId)).map((o) => [o.week_start, o.from_user, o.to_user, Number(o.amount_cents), o.status]),
    ).toEqual([
      ['2026-10-12', u[1], u[0], 500, 'superseded'],
      ['2026-10-19', u[1], u[0], 500, 'pending'],
      ['2026-10-19', u[2], u[0], 500, 'pending'],
    ]);
    // the Monday instance belongs to the next week (and was not posted by settlement)
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where instance_id = $1`, [nextMonday])).toBe(0);
    // Notifications only for the latest settlement of the run (the earlier one was superseded at once).
    const notes = await rows<{ payload: any }>(db, `select payload from public.notification_outbox where kind = 'settlement'`);
    expect(new Set(notes.map((n) => n.payload.week_start))).toEqual(new Set(['2026-10-19']));
  });
});

describe('settlement contents', () => {
  beforeEach(async () => freshGroup('2026-10-28T19:00:00Z', 5));

  it('obligations match simplifyDebts, cover every positive balance, and leave carry money unowed', async () => {
    // carry of 1000 from an all-fail, then mixed outcomes
    await closedInstance(db, pact, '2026-10-26', [
      [u[3], 'failed'],
      [u[4], 'failed'],
    ]);
    await closedInstance(db, pact, '2026-10-27', [
      [u[0], 'success', '2026-10-27T15:01:00Z'],
      [u[1], 'success', '2026-10-27T15:02:00Z'],
      [u[2], 'failed'],
      [u[3], 'failed'],
      [u[4], 'unverified'],
    ]);
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'failed'],
      [u[1], 'failed'],
      [u[2], 'failed'],
      [u[3], 'failed'],
    ]);
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    const bal = await balances(db, fx.groupId);
    const carry = Number(
      await scalar(db, `select balance_cents::bigint from public.account_balances where kind = 'carry' and pact_id = $1`, [pact]),
    );
    expect(carry).toBe(2000);
    expect(bal).toEqual({ [u[0]]: 500, [u[1]]: 500, [u[2]]: -1000, [u[3]]: -1500, [u[4]]: -500 });
    expect(Object.values(bal).reduce((a, b) => a + b, 0)).toBe(-carry);
    const obs = await obligations(db, fx.groupId, 'pending');
    const expected = simplifyDebts(bal).obligations.map((o) => [o.from, o.to, o.amountCents]);
    const got = obs.map((o) => [o.from_user, o.to_user, Number(o.amount_cents)]);
    const key = (x: any[]) => x.join('|');
    expect(got.map(key).sort()).toEqual(expected.map(key).sort());
    expect(got).toHaveLength(2);
    const positive = Object.values(bal).filter((b) => b > 0).reduce((a, b) => a + b, 0);
    expect(obs.reduce((a, o) => a + Number(o.amount_cents), 0)).toBe(positive);
  });

  it('applies pending corrections, then marks the week settled; later corrections post and are billed next settlement', async () => {
    const i = await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    // a result changed (e.g. a review resolved) but no correction was applied yet
    await db.query(`update public.results set status = 'excluded' where instance_id = $1 and user_id = $2`, [i, u[2]]);
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 500, [u[1]]: -500, [u[2]]: 0 });
    expect(await instStatus(db, i)).toBe('settled');
    // a late offline check-in after settlement turns u1's failure into unverified: the correction posts now
    await db.query(`update public.results set status = 'unverified' where instance_id = $1 and user_id = $2`, [i, u[1]]);
    await correct(db, i);
    expect(await instStatus(db, i)).toBe('settled');
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 0, [u[1]]: 0 });
    // ...and the next settlement bills it: last week's IOU is superseded and nothing is owed
    expect(await settle(db, '2026-11-09T20:00:00Z')).toBe(1);
    expect(await obligations(db, fx.groupId, 'pending')).toEqual([]);
  });

  it('obligations bill only settled instances (plus payments); closed next-week instances wait for their own settlement', async () => {
    const i = await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    // Monday 2026-11-02 08:00-09:00 PST closes and posts before Monday-noon settlement of the previous week.
    const mon = await closedInstance(db, pact, '2026-11-02', [
      [u[2], 'success'],
      [u[3], 'failed'],
    ]);
    await payout(db, mon);
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    expect(await instStatus(db, i)).toBe('settled');
    expect(await instStatus(db, mon)).toBe('closed');
    expect((await obligations(db, fx.groupId, 'pending')).map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[1], u[0], 500],
    ]);
    const billable = async () =>
      Object.fromEntries(
        (
          await rows<{ user_id: string; b: number }>(
            db,
            `select user_id::text, balance_cents::bigint b from public.billable_member_balances where group_id = $1`,
            [fx.groupId],
          )
        ).map((r) => [r.user_id, Number(r.b)]),
      );
    expect(await billable()).toMatchObject({ [u[0]]: 500, [u[1]]: -500, [u[2]]: 0, [u[3]]: 0 });
    // the live view still shows everything
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[2]]: 500, [u[3]]: -500 });
    // a confirmed payment is billable at once
    const [o] = await obligations(db, fx.groupId, 'pending');
    await asUser(db, u[0], (d) => d.query(`select public.confirm_obligation($1)`, [o.id]));
    expect(await billable()).toMatchObject({ [u[0]]: 0, [u[1]]: 0 });
    // members can read their group's billable balances; outsiders see nothing
    expect(await asUser(db, u[3], (d) => rows(d, `select * from public.billable_member_balances`))).toHaveLength(4); // u0..u3 have accounts
    const outsider = await createUser(db);
    expect(await asUser(db, outsider, (d) => rows(d, `select * from public.billable_member_balances`))).toEqual([]);
    expect(await settle(db, '2026-11-09T20:00:00Z')).toBe(1);
    expect(await instStatus(db, mon)).toBe('settled');
    expect((await obligations(db, fx.groupId, 'pending')).map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[3], u[2], 500],
    ]);
  });

  it('an appeal nobody votes on changes nothing: same obligations as without the appeal, no correction entry (N3-1)', async () => {
    const i = await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    const posted = await rows(db, `select kind::text, idempotency_key from public.ledger_entries where instance_id = $1 order by id`, [i]);
    const appeal = await asUser(db, u[1], (d) =>
      scalar<string>(d, `select public.open_review($1, $2, 'appeal'::public.review_kind, 'late Sunday night', null)`, [i, u[1]]),
    );
    expect(await settle(db, '2026-11-02T20:00:00Z')).toBe(1);
    expect(await scalar(db, `select status::text from public.reviews where id = $1`, [appeal])).toBe('defaulted');
    expect(await scalar(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [i, u[1]])).toBe('failed');
    expect(await instStatus(db, i)).toBe('settled');
    // ledger: exactly what the payout posted, nothing corrected
    expect(await rows(db, `select kind::text, idempotency_key from public.ledger_entries where instance_id = $1 order by id`, [i])).toEqual(posted);
    expect(await scalar(db, `select count(*)::int from public.ledger_entries where instance_id = $1 and kind = 'correction'`, [i])).toBe(0);
    // obligations are the ones a plain loss produces
    const bal = await balances(db, fx.groupId);
    expect(bal).toMatchObject({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
    const obs = await obligations(db, fx.groupId, 'pending');
    expect(obs.map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[1], u[0], 500],
      [u[2], u[0], 500],
    ]);
    expect(obs.map((o) => [o.from_user, o.to_user, Number(o.amount_cents)].join('|')).sort()).toEqual(
      simplifyDebts(bal).obligations.map((o) => [o.from, o.to, o.amountCents].join('|')).sort(),
    );
  });

  it('calls default_open_reviews(group, end of week) before settling the week', async () => {
    await db.exec(`
      create table public._spy (group_id uuid, p_until timestamptz, settled_at_call int);
      create or replace function public.default_open_reviews(p_group uuid, p_until timestamptz) returns int
      language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
      begin
        insert into public._spy values (p_group, p_until,
          (select count(*) from public.pact_instances where status = 'settled'));
        return 0;
      end $$;
      revoke all on function public.default_open_reviews(uuid, timestamptz) from public, anon, authenticated;
    `);
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    await settle(db, '2026-11-02T20:30:00Z');
    const spy = await rows<{ group_id: string; p_until: Date; settled_at_call: number }>(db, `select * from public._spy`);
    expect(spy).toHaveLength(1);
    expect(spy[0].group_id).toBe(fx.groupId);
    expect(spy[0].settled_at_call).toBe(0);
    // p_until = end of the settled week (Mon 00:00 PST), so reviews of Monday-morning instances
    // (next week) are not defaulted early.
    expect(spy[0].p_until.toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('enqueues a settlement notification per member with net_cents and group_name', async () => {
    await db.query(`update public.groups set name = 'Kane Hall crew' where id = $1`, [fx.groupId]);
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    await settle(db, '2026-11-02T20:00:00Z');
    const notes = await rows<{ user_id: string; payload: any }>(
      db,
      `select user_id::text, payload from public.notification_outbox where kind = 'settlement' order by user_id`,
    );
    expect(notes.map((n) => n.user_id)).toEqual(u);
    const byUser = Object.fromEntries(notes.map((n) => [n.user_id, n.payload]));
    expect(byUser[u[0]]).toMatchObject({ group_id: fx.groupId, group_name: 'Kane Hall crew', net_cents: 500, week_start: '2026-10-26' });
    expect(byUser[u[1]]).toMatchObject({ net_cents: -500 });
    expect(byUser[u[2]]).toMatchObject({ net_cents: 0 });
  });

  it('supersedes pending obligations at the next settlement; marked_paid ones stay and count as provisionally paid', async () => {
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await settle(db, '2026-11-02T20:00:00Z');
    const [o1, o2] = await obligations(db, fx.groupId, 'pending');
    expect([o1.from_user, o2.from_user]).toEqual([u[1], u[2]]);
    await asUser(db, u[1], (d) => d.query(`select public.mark_obligation_paid($1)`, [o1.id]));
    // u2 pays and u0 confirms before the next settlement
    await asUser(db, u[0], (d) => d.query(`select public.confirm_obligation($1)`, [o2.id]));
    // u3 fails on Wednesday; u4 wins
    await closedInstance(db, pact, '2026-11-04', [
      [u[4], 'success'],
      [u[3], 'failed'],
    ]);
    await settle(db, '2026-11-09T20:00:00Z');
    const all = await obligations(db, fx.groupId);
    expect(all.find((o) => o.id === o1.id)!.status).toBe('marked_paid');
    expect(all.find((o) => o.id === o2.id)!.status).toBe('confirmed');
    // u1's marked payment counts as paid: nobody owes u0; u3 owes u4
    expect((await obligations(db, fx.groupId, 'pending')).map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[3], u[4], 500],
    ]);
    // it can still be confirmed later, and that changes nothing owed
    await asUser(db, u[0], (d) => d.query(`select public.confirm_obligation($1)`, [o1.id]));
    await settle(db, '2026-11-16T20:00:00Z');
    expect((await obligations(db, fx.groupId, 'pending')).map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[3], u[4], 500],
    ]);
  });

  it('a disputed marked_paid obligation goes back to pending, is superseded next settlement, and the debt is re-billed', async () => {
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    await settle(db, '2026-11-02T20:00:00Z');
    const [o1] = await obligations(db, fx.groupId, 'pending');
    await asUser(db, u[1], (d) => d.query(`select public.mark_obligation_paid($1)`, [o1.id]));
    await asUser(db, u[0], (d) => d.query(`select public.dispute_obligation($1)`, [o1.id]));
    expect(await scalar(db, `select status::text from public.obligations where id = $1`, [o1.id])).toBe('pending');
    expect(await scalar(db, `select marked_paid_at from public.obligations where id = $1`, [o1.id])).toBeNull();
    await settle(db, '2026-11-09T20:00:00Z');
    expect(await scalar(db, `select status::text from public.obligations where id = $1`, [o1.id])).toBe('superseded');
    expect((await obligations(db, fx.groupId, 'pending')).map((o) => [o.from_user, o.to_user, Number(o.amount_cents)])).toEqual([
      [u[1], u[0], 500],
    ]);
  });
});

describe('settle-up RPCs', () => {
  let ob: { id: string; from_user: string; to_user: string; amount_cents: number };
  beforeEach(async () => {
    await freshGroup('2026-10-28T19:00:00Z', 3);
    await closedInstance(db, pact, '2026-10-28', [
      [u[0], 'success'],
      [u[1], 'failed'],
    ]);
    await settle(db, '2026-11-02T20:00:00Z');
    [ob] = await obligations(db, fx.groupId, 'pending');
    expect([ob.from_user, ob.to_user]).toEqual([u[1], u[0]]);
  });

  const mark = (uid: string, id: string) => asUser(db, uid, (d) => d.query(`select public.mark_obligation_paid($1)`, [id]));
  const confirm = (uid: string, id: string) => asUser(db, uid, (d) => d.query(`select public.confirm_obligation($1)`, [id]));
  const status = (id: string) => scalar<string>(db, `select status::text from public.obligations where id = $1`, [id]);

  it('payer marks paid, payee confirms; confirmation posts the settlement_payment entry', async () => {
    expect((await expectError(mark(u[0], ob.id))).code).toBe('42501'); // payee can't mark
    expect((await expectError(mark(u[2], ob.id))).code).toBe('42501'); // other member can't
    await mark(u[1], ob.id);
    expect(await status(ob.id)).toBe('marked_paid');
    expect(await scalar(db, `select marked_paid_at is not null from public.obligations where id = $1`, [ob.id])).toBe(true);
    await mark(u[1], ob.id); // idempotent
    expect((await expectError(confirm(u[1], ob.id))).code).toBe('42501'); // payer can't confirm
    expect((await expectError(confirm(u[2], ob.id))).code).toBe('42501');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(0);
    await confirm(u[0], ob.id);
    expect(await status(ob.id)).toBe('confirmed');
    const lines = await rows<{ key: string; user_id: string; amt: number }>(
      db,
      `select e.idempotency_key key, a.user_id::text, l.amount_cents::bigint amt
         from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id
         join public.ledger_accounts a on a.id = l.account_id
        where e.kind = 'settlement_payment' order by amt`,
    );
    expect(lines.map((l) => [l.key, l.user_id, Number(l.amt)])).toEqual([
      [`payment:${ob.id}`, u[0], -500],
      [`payment:${ob.id}`, u[1], 500],
    ]);
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 0, [u[1]]: 0 });
    await confirm(u[0], ob.id); // idempotent
    await mark(u[1], ob.id); // no-op once confirmed
    expect(await status(ob.id)).toBe('confirmed');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(1);
    // next settlement: nothing owed
    await settle(db, '2026-11-09T20:00:00Z');
    expect(await obligations(db, fx.groupId, 'pending')).toEqual([]);
  });

  it('payee may confirm straight from pending', async () => {
    await confirm(u[0], ob.id);
    expect(await status(ob.id)).toBe('confirmed');
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 0, [u[1]]: 0 });
  });

  it('superseded obligations cannot be paid, confirmed or disputed', async () => {
    await settle(db, '2026-11-09T20:00:00Z');
    expect(await status(ob.id)).toBe('superseded');
    expect((await expectError(mark(u[1], ob.id), /superseded/)).code).toBe('23514');
    expect((await expectError(confirm(u[0], ob.id), /superseded/)).code).toBe('23514');
    expect(
      (await expectError(asUser(db, u[0], (d) => d.query(`select public.dispute_obligation($1)`, [ob.id])), /superseded/)).code,
    ).toBe('23514');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(0);
  });

  it('dispute_obligation: payee only; marked_paid -> pending; pending is a no-op; confirmed/superseded are final', async () => {
    const dispute = (uid: string, id: string) => asUser(db, uid, (d) => d.query(`select public.dispute_obligation($1)`, [id]));
    await mark(u[1], ob.id);
    expect((await expectError(dispute(u[1], ob.id))).code).toBe('42501'); // payer can't
    expect((await expectError(dispute(u[2], ob.id))).code).toBe('42501'); // nor another member
    expect((await expectError(asAnon(db, (d) => d.query(`select public.dispute_obligation($1)`, [ob.id])))).code).toBe('42501');
    expect((await expectError(dispute(u[0], '00000000-0000-0000-0000-000000000000'))).code).toBe('P0002');
    await dispute(u[0], ob.id);
    expect(await status(ob.id)).toBe('pending');
    await dispute(u[0], ob.id); // no-op
    expect(await status(ob.id)).toBe('pending');
    await mark(u[1], ob.id);
    await confirm(u[0], ob.id);
    expect((await expectError(dispute(u[0], ob.id), /confirmed/)).code).toBe('23514');
    expect(await status(ob.id)).toBe('confirmed');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'settlement_payment'`)).toBe(1);
  });

  it('marked_paid obligations survive the next settlement and can still be confirmed', async () => {
    await mark(u[1], ob.id);
    await settle(db, '2026-11-09T20:00:00Z');
    expect(await status(ob.id)).toBe('marked_paid');
    expect(await obligations(db, fx.groupId, 'pending')).toEqual([]);
    await confirm(u[0], ob.id);
    expect(await status(ob.id)).toBe('confirmed');
    expect(await balances(db, fx.groupId)).toMatchObject({ [u[0]]: 0, [u[1]]: 0 });
  });

  it('rejects anon, unknown obligations, and outsiders', async () => {
    expect((await expectError(asAnon(db, (d) => d.query(`select public.mark_obligation_paid($1)`, [ob.id])))).code).toBe('42501');
    expect((await expectError(asAnon(db, (d) => d.query(`select public.confirm_obligation($1)`, [ob.id])))).code).toBe('42501');
    expect((await expectError(mark(u[1], '00000000-0000-0000-0000-000000000000'))).code).toBe('P0002');
    const outsider = await createUser(db);
    expect((await expectError(confirm(outsider, ob.id))).code).toBe('42501');
    // authenticated role without a user id
    expect(
      (await expectError(asService(db, async (d) => {
        await d.exec(`set role authenticated`);
        return d.query(`select public.confirm_obligation($1)`, [ob.id]);
      }))).code,
    ).toBe('28000');
  });

  it('RLS: non-members cannot read obligations or settlements; members can', async () => {
    const outsider = await createUser(db);
    expect(await asUser(db, outsider, (d) => rows(d, `select * from public.obligations`))).toEqual([]);
    expect(await asUser(db, outsider, (d) => rows(d, `select * from public.settlements`))).toEqual([]);
    expect(await asUser(db, u[2], (d) => rows(d, `select id from public.obligations`))).toEqual([{ id: ob.id }]);
    // clients cannot write obligations directly
    expect(
      (await expectError(asUser(db, u[0], (d) => d.query(`update public.obligations set status = 'confirmed' where id = $1`, [ob.id])))).code,
    ).toBe('42501');
  });
});
