// Final red-team pass (night-1, phase 5): interactions between the rules that landed concurrently
// tonight (places, unverified budget, appeal default, RT fixes, heartbeat, account deletion, seasons,
// instance nets). Each test asserts that an attack is blocked or that an honest user is safe. Tests
// marked "proven" failed before 20261108000900_final_fixes.sql; the rest are regressions
// (docs/REDTEAM.md "Final pass (night-1)").
import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, asService, asUser, createDb, createGroupFixture, createUser, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles. January 2030 is PST (UTC-8): a local date D
// has window D 16:00Z and deadline D 17:00Z. Mondays: 2030-01-07, -14, -21.
const GEN_NOW = '2030-01-06T12:00:00Z';
const openOf = (d: string) => `${d}T16:00:00.000Z`;
const deadlineOf = (d: string) => `${d}T17:00:00.000Z`;
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const SETTLE_1 = '2030-01-14T21:00:00Z'; // Monday noon PST, week of Jan 7
const SETTLE_2 = '2030-01-21T21:00:00Z';

type Outcome = 'success' | 'failed' | 'unverified' | 'frozen';
type Fx = GroupFixture & { pactId: string };

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

const tick = (now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const gen = (now: string) => db.query(`select public.generate_instances(7, $1::timestamptz)`, [now]);
const settle = (now: string) => asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
const instanceOf = (pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

async function setup(members = 3, participants?: number): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members, participants })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  // the group's first settleable week is the one of 2030-01-07 (keeps settle_due_groups to a few loops)
  await db.query(`update public.groups set created_at = '2030-01-02T12:00:00Z' where id = $1`, [fx.groupId]);
  return fx;
}

function checkInAt(user: string, inst: string, fix: { lat: number | null; lng: number | null; acc: number | null }, now: string, captured = now) {
  return db.query(`select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $7::timestamptz)`, [
    user,
    inst,
    fix.lat,
    fix.lng,
    fix.acc,
    captured,
    now,
  ]);
}

/** Opens and closes the pact's instance for `date` with one outcome per participant (fixture order). */
async function closeDay(fx: Fx, date: string, outcomes: Outcome[]): Promise<string> {
  const inst = await instanceOf(fx.pactId, date);
  for (const [i, o] of outcomes.entries()) {
    if (o === 'frozen') await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [fx.participantIds[i]!, inst, at(openOf(date), -60)]);
  }
  await tick(openOf(date));
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed' || o === 'frozen') continue;
    await checkInAt(fx.participantIds[i]!, inst, { ...placeOf(i), acc: o === 'success' ? 10 : 250 }, at(openOf(date), 10 + i));
  }
  await tick(deadlineOf(date));
  return inst;
}

const statusOf = (inst: string) => scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [inst]);
const resultOf = (inst: string, user: string) =>
  scalar<string>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, user]);
const balance = (u: string) => scalar<number>(db, `select coalesce(sum(balance_cents), 0)::int from public.member_balances where user_id = $1`, [u]);
const carryBalance = (pactId: string) =>
  scalar<number>(db, `select coalesce(sum(balance_cents), 0)::int from public.account_balances where kind = 'carry' and pact_id = $1`, [pactId]);
const carryIn = (inst: string) => scalar<number | null>(db, `select carry_in_cents::int from public.pact_instances where id = $1`, [inst]);
const reviewStatus = (id: string) => scalar<string>(db, `select status::text from public.reviews where id = $1`, [id]);
const openReview = (u: string, inst: string, subject: string, kind: 'appeal' | 'challenge') =>
  asUser(db, u, (d) => scalar<string>(d, `select public.open_review($1, $2, $3::review_kind, 'r', null)`, [inst, subject, kind]));
const vote = (u: string, review: string, s: boolean) => asUser(db, u, (d) => d.query(`select public.cast_vote($1, $2)`, [review, s]));
const systemReviews = (inst: string, subject: string) =>
  rows<{ id: string; status: string }>(db, `select id, status::text from public.reviews where instance_id = $1 and subject_user_id = $2 and system_opened order by opened_at`, [
    inst,
    subject,
  ]);
const deleteAccount = (uid: string) => asUser(db, uid, (d) => d.query('select public.delete_my_account()'));
const entryCount = (kind?: string) =>
  scalar<number>(db, kind ? `select count(*)::int from public.ledger_entries where kind = $1` : `select count(*)::int from public.ledger_entries`, kind ? [kind] : []);

interface Net {
  user_id: string;
  net_cents: number;
  pot_cents: number;
}
const netsOf = (inst: string) =>
  rows<Net>(db, `select user_id::text, net_cents::int, pot_cents::int from public.instance_member_nets where instance_id = $1 order by user_id`, [inst]);

async function expectLedgerInvariants(pactId: string) {
  expect(await scalar<number>(db, `select count(*)::int from (select entry_id from public.ledger_lines group by entry_id having sum(amount_cents) <> 0) x`)).toBe(0);
  expect(await carryBalance(pactId)).toBeGreaterThanOrEqual(0);
  // every instance: member nets + carry lines sum to zero
  const bad = await scalar<number>(
    db,
    `select count(*)::int from (
       select e.instance_id, sum(l.amount_cents) s
         from public.ledger_entries e join public.ledger_lines l on l.entry_id = e.id join public.ledger_accounts a on a.id = l.account_id
        where e.instance_id is not null and a.kind <> 'pot' group by e.instance_id having sum(l.amount_cents) <> 0) x`,
  );
  expect(bad).toBe(0);
}

// =============================================================================================
describe('F-1: season, streak and settle-up stat views leak nothing across groups', () => {
  it('a non-member, a former member and anon see no recap, streak, stat, month-count or instance-net row of the group', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_season($1, '2030-01-07'::date, 2::smallint)`, [fx.pactId]));
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['success', 'failed', 'unverified']);
    await settle(SETTLE_1);
    const views = ['pact_season_recaps', 'pact_streaks', 'group_settlement_stats', 'unverified_month_counts', 'instance_member_nets'];
    const scope: Record<string, string> = {
      pact_season_recaps: `pact_id = '${fx.pactId}'`,
      pact_streaks: `pact_id = '${fx.pactId}'`,
      group_settlement_stats: `group_id = '${fx.groupId}'`,
      unverified_month_counts: `pact_id = '${fx.pactId}'`,
      instance_member_nets: `group_id = '${fx.groupId}'`,
    };
    const countAs = (uid: string, view: string) => asUser(db, uid, (d) => scalar<number>(d, `select count(*)::int from public.${view} where ${scope[view]}`));
    // members see rows
    expect(await countAs(a, 'pact_season_recaps')).toBe(3);
    expect(await countAs(a, 'pact_streaks')).toBe(3);
    expect(await countAs(a, 'group_settlement_stats')).toBe(1);
    expect(await countAs(a, 'instance_member_nets')).toBe(2);
    // an outsider in another group sees nothing of this one
    const outsider = await createGroupFixture(db, { members: 1, pact: false });
    for (const v of views) expect(await countAs(outsider.ownerId, v)).toBe(0);
    // a former member loses the read models with the group
    await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    for (const v of views) expect(await countAs(c, v)).toBe(0);
    // anon has no grant at all
    for (const v of views) await asAnon(db, (d) => expectError(d.query(`select count(*) from public.${v}`), /permission denied/));
    // b (still a member) sees everything, including the leaver's row
    expect(await countAs(b, 'pact_season_recaps')).toBe(3);
  });

  it('set_pact_season: a plain member, an outsider, a former creator and anon are refused; the pacts columns are not client-writable', async () => {
    const fx = await setup(3);
    const [, b] = fx.participantIds;
    const outsider = await createUser(db);
    const set = (uid: string) => asUser(db, uid, (d) => d.query(`select public.set_pact_season($1, '2030-01-07'::date, 4::smallint)`, [fx.pactId]));
    expect(await code(set(b))).toBe('42501');
    expect(await code(set(outsider))).toBe('42501');
    await asAnon(db, (d) => expectError(d.query(`select public.set_pact_season($1, '2030-01-07'::date, 4::smallint)`, [fx.pactId]), /permission denied/));
    // the owner leaves: they created the pact, but they are no longer a member
    await asUser(db, fx.ownerId, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    expect(await code(set(fx.ownerId))).toBe('42501');
    // ownership moved to b, who can now run the season
    await set(b);
    expect(await scalar<number>(db, `select season_weeks from public.pacts where id = $1`, [fx.pactId])).toBe(4);
    await asUser(db, b, (d) => expectError(d.query(`update public.pacts set season_weeks = 12 where id = $1`, [fx.pactId]), /permission denied/));
    expect(await scalar<number>(db, `select season_weeks from public.pacts where id = $1`, [fx.pactId])).toBe(4);
  });
});

// =============================================================================================
describe('F-2: account deletion against the roster, ownership and the next day', () => {
  it('the owner deletes: ownership passes on, the deleted member is off tomorrow, and the others still play for money', async () => {
    const fx = await setup(3);
    const [owner, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const d1 = await closeDay(fx, '2030-01-07', ['failed', 'success', 'success']); // owner misses, owes 500
    expect(await balance(owner)).toBe(-500);
    await deleteAccount(owner);
    expect(await scalar<string>(db, `select display_name from public.profiles where id = $1`, [owner])).toBe('Deleted member');
    expect(await scalar<string>(db, `select user_id from public.group_members where group_id = $1 and role = 'owner' and left_at is null`, [fx.groupId])).toBe(b);
    // the new owner has the owner's powers
    await asUser(db, b, (d) => d.query(`select public.set_pact_paused($1, false)`, [fx.pactId]));
    await asUser(db, b, (d) => d.query(`select public.set_pact_season($1, '2030-01-07'::date, 1::smallint)`, [fx.pactId]));
    // tomorrow: only b and c are on the roster, and the day still counts (2 active)
    const d2 = await instanceOf(fx.pactId, '2030-01-08');
    await tick(openOf('2030-01-08'));
    expect(await code(checkInAt(owner, d2, { ...placeOf(0), acc: 10 }, at(openOf('2030-01-08'), 5)))).toBe('42501');
    await checkInAt(b, d2, { ...placeOf(1), acc: 10 }, at(openOf('2030-01-08'), 5));
    await tick(deadlineOf('2030-01-08'));
    expect(await statusOf(d2)).toBe('closed');
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1`, [d2])).toBe(2);
    expect(await resultOf(d2, c)).toBe('failed');
    expect(await balance(b)).toBe(750);
    // the deleted member's debt from day 1 is still billed, to the people who earned it
    await settle(SETTLE_1);
    const obs = await rows<{ from_user: string; to_user: string; amount_cents: number }>(db, `select from_user, to_user, amount_cents::int from public.obligations where group_id = $1 order by amount_cents`, [
      fx.groupId,
    ]);
    // owner -500 (day 1); c +250 (day 1) -500 (day 2); b +750
    expect(obs).toEqual([
      { from_user: c, to_user: b, amount_cents: 250 },
      { from_user: owner, to_user: b, amount_cents: 500 },
    ]);
    // b still sees the deleted debtor's obligation and the season recap names them
    expect(await asUser(db, b, (d) => scalar<number>(d, `select count(*)::int from public.obligations where from_user = $1`, [owner]))).toBe(1);
    expect(await asUser(db, b, (d) => scalar<number>(d, `select net_cents::int from public.pact_season_recaps where pact_id = $1 and user_id = $2`, [fx.pactId, owner]))).toBe(-500);
    expect(await statusOf(d1)).toBe('settled');
    await expectLedgerInvariants(fx.pactId);
  });

  it('proven: the ops alert recipient is cleared when that account is deleted (alerts never queue for a dead account)', async () => {
    const fx = await setup(2);
    const [, b] = fx.participantIds;
    await asService(db, (d) => d.query(`update public.ops_settings set ops_user_id = $1`, [b]));
    await deleteAccount(b);
    expect(await scalar<string | null>(db, `select ops_user_id from public.ops_settings`)).toBeNull();
    // and an overdue job alerts nobody instead of a deleted profile
    await asService(db, (d) => d.query(`select public._heartbeat('tick_instances', true, null)`));
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health(now() + interval '1 day')`))).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where user_id = $1 and sent_at is null`, [b])).toBe(0);
  });

  it('deleting mid-vote: the leaver\'s vote on an open review goes, the remaining voters still decide, and a forfeit lands on the deleted member', async () => {
    const fx = await setup(4);
    const [a, b, c, d] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await closeDay(fx, '2030-01-07', ['success', 'unverified', 'success', 'success']);
    const r = await openReview(a, inst, b, 'challenge'); // voters: c, d (a opened it)
    await vote(c, r, true); // 1 of 2: not yet a majority
    expect(await reviewStatus(r)).toBe('open');
    // the subject deletes their account between the vote and the decision
    await deleteAccount(b);
    await vote(d, r, true);
    expect(await reviewStatus(r)).toBe('accepted');
    expect(await resultOf(inst, b)).toBe('failed');
    expect(await balance(b)).toBe(-500);
    expect((await balance(a)) + (await balance(c)) + (await balance(d))).toBe(500);
    await expectLedgerInvariants(fx.pactId);
  });
});

// =============================================================================================
describe('F-3: place objection and account deletion', () => {
  it('an objection survives the objector deleting their account; the owner of the blocked place is judged against the old one until they set another', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['success', 'success', 'success']);
    // b moves the fence 2 km away (gated); c objects; c deletes
    await asUser(db, b, (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'moved')`, [fx.pactId, placeOf(1).lat + 0.02, placeOf(1).lng]));
    const moved = await scalar<string>(db, `select id from public.pact_participant_places where pact_id = $1 and user_id = $2 and requires_ack order by created_at desc limit 1`, [
      fx.pactId,
      b,
    ]);
    await asUser(db, c, (d) => d.query(`select public.object_place($1, 'that is a parking lot')`, [moved]));
    await deleteAccount(c);
    // the objection stands, under the deleted member's name
    expect(await scalar<string>(db, `select objected_by from public.pact_participant_places where id = $1`, [moved])).toBe(c);
    expect(await scalar<number>(db, `select count(*)::int from public.place_events where place_id = $1 and kind = 'objected' and actor_id = $2`, [moved, c])).toBe(1);
    // b is still judged against the first place (a tap from the moved place is out of fence)
    const inst = await instanceOf(fx.pactId, '2030-01-08');
    await tick(openOf('2030-01-08'));
    await checkInAt(b, inst, { lat: placeOf(1).lat + 0.02, lng: placeOf(1).lng, acc: 10 }, at(openOf('2030-01-08'), 5));
    expect(await scalar<string>(db, `select verdict::text from public.checkins where instance_id = $1 and user_id = $2`, [inst, b])).toBe('out_of_fence');
    await checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(openOf('2030-01-08'), 6));
    await tick(deadlineOf('2030-01-08'));
    expect(await resultOf(inst, b)).toBe('failed');
    expect(await balance(b)).toBe(-500);
    // b can set another place; a (the only other member left) confirms it and it counts
    await asUser(db, b, (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'library')`, [fx.pactId, placeOf(1).lat + 0.005, placeOf(1).lng]));
    const next = await scalar<string>(db, `select id from public.pact_participant_places where pact_id = $1 and user_id = $2 and objected_at is null and requires_ack order by created_at desc limit 1`, [
      fx.pactId,
      b,
    ]);
    await asUser(db, a, (d) => d.query(`select public.acknowledge_place($1)`, [next]));
    expect(await scalar<string | null>(db, `select acknowledged_by from public.pact_participant_places where id = $1`, [next])).toBe(a);
    await expectLedgerInvariants(fx.pactId);
  });

  it('pending place changes of the deleted member go (an objected one too); the place in force and the place events stay', async () => {
    const fx = await setup(3);
    const [a, b] = fx.participantIds;
    await asUser(db, b, (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'first move')`, [fx.pactId, placeOf(1).lat + 0.02, placeOf(1).lng]));
    const first = await scalar<string>(db, `select id from public.pact_participant_places where pact_id = $1 and user_id = $2 and requires_ack order by created_at desc limit 1`, [fx.pactId, b]);
    await asUser(db, a, (d) => d.query(`select public.object_place($1, 'no')`, [first]));
    await asUser(db, b, (d) => d.query(`select public.join_pact($1, $2, $3, 100, 'second move')`, [fx.pactId, placeOf(1).lat + 0.03, placeOf(1).lng]));
    expect(await scalar<number>(db, `select count(*)::int from public.pact_participant_places where pact_id = $1 and user_id = $2`, [fx.pactId, b])).toBe(3);
    await deleteAccount(b);
    const left = await rows<{ label: string; objected: boolean }>(db, `select label, objected_at is not null as objected from public.pact_participant_places where pact_id = $1 and user_id = $2 order by created_at`, [
      fx.pactId,
      b,
    ]);
    expect(left.map((p) => p.label)).toEqual(['place 1']);
    expect(left[0]!.objected).toBe(false);
    // the feed history keeps the moves and the objection (place_id set null by the FK), under "Deleted member"
    expect(await scalar<number>(db, `select count(*)::int from public.place_events where user_id = $1 and place_id is null and kind in ('created', 'objected')`, [b])).toBe(3);
    expect(await scalar<number>(db, `select count(*)::int from public.place_events where user_id = $1`, [b])).toBe(4);
  });
});

// =============================================================================================
describe('F-4: the automatic challenge that settlement itself opens is decided afterwards and billed', () => {
  it('an appeal defaulted at settle-up uncovers the third unverified day; the group votes on the settled day and the forfeit is billed next week', async () => {
    const fx = await setup(3);
    const [b, a, c] = fx.participantIds;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'success', 'success']);
    await closeDay(fx, '2030-01-08', ['unverified', 'success', 'success']);
    const d3 = await closeDay(fx, '2030-01-09', ['failed', 'success', 'success']);
    expect(await balance(b)).toBe(-500);
    const appeal = await openReview(b, d3, b, 'appeal');
    // the "offline" tap lands: inside the fence, captured before the deadline, received after it
    await checkInAt(b, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 20), at(deadlineOf('2030-01-09'), -3));
    expect(await resultOf(d3, b)).toBe('unverified');
    expect(await balance(b)).toBe(0); // forfeit refunded by a correction
    expect(await systemReviews(d3, b)).toEqual([]);
    await settle(SETTLE_1);
    expect(await reviewStatus(appeal)).toBe('defaulted');
    expect(await statusOf(d3)).toBe('settled');
    const sys = await systemReviews(d3, b);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.status).toBe('open');
    // week 1 billed nothing for b (unverified never costs); a and c got nothing for day 3
    expect(await scalar<number>(db, `select count(*)::int from public.obligations where group_id = $1 and from_user = $2`, [fx.groupId, b])).toBe(0);
    // during the week the others vote on the settled day
    await vote(a, sys[0]!.id, true);
    await vote(c, sys[0]!.id, true);
    expect(await reviewStatus(sys[0]!.id)).toBe('accepted');
    expect(await resultOf(d3, b)).toBe('failed');
    expect(await balance(b)).toBe(-500);
    expect(await entryCount('correction')).toBe(2);
    // and the next settle-up bills it
    await settle(SETTLE_2);
    const obs = await rows<{ from_user: string; amount_cents: number; status: string }>(db, `select from_user, amount_cents::int, status::text from public.obligations where group_id = $1 and status <> 'superseded'`, [
      fx.groupId,
    ]);
    expect(obs.reduce((s, o) => s + (o.from_user === b ? o.amount_cents : 0), 0)).toBe(500);
    await expectLedgerInvariants(fx.pactId);
  });

  it('nobody voting on that late challenge leaves the day unverified: no money moves at the next settle-up either', async () => {
    const fx = await setup(3);
    const [b] = fx.participantIds;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['unverified', 'success', 'success']);
    await closeDay(fx, '2030-01-08', ['unverified', 'success', 'success']);
    const d3 = await closeDay(fx, '2030-01-09', ['failed', 'success', 'success']);
    await openReview(b, d3, b, 'appeal');
    await checkInAt(b, d3, { ...placeOf(0), acc: 10 }, at(deadlineOf('2030-01-09'), 20), at(deadlineOf('2030-01-09'), -3));
    await settle(SETTLE_1);
    const sys = await systemReviews(d3, b);
    expect(sys).toHaveLength(1);
    await settle(SETTLE_2);
    expect(await reviewStatus(sys[0]!.id)).toBe('defaulted');
    expect(await resultOf(d3, b)).toBe('unverified');
    expect(await balance(b)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.obligations where group_id = $1 and status <> 'superseded'`, [fx.groupId])).toBe(0);
  });
});

// =============================================================================================
describe('F-5: a job error never leaves a payout half posted', () => {
  it('an error after the payout inside the close rolls the whole instance back; the next tick closes it exactly once', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await tick(openOf('2030-01-07'));
    await checkInAt(a, inst, { ...placeOf(0), acc: 10 }, at(openOf('2030-01-07'), 5));
    // the result pushes are queued after the payout is posted; make that step fail
    await db.exec(`
      create function public._boom() returns trigger language plpgsql as $$
      begin
        if new.kind = 'result' then raise exception 'boom' using errcode = 'P0001'; end if;
        return new;
      end $$;
      create trigger boom before insert on public.notification_outbox for each row execute function public._boom();
    `);
    await tick(deadlineOf('2030-01-07'));
    expect(await statusOf(inst)).toBe('open');
    expect(await entryCount()).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.results where instance_id = $1`, [inst])).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.job_failures where job = 'tick_instances'`)).toBeGreaterThanOrEqual(1);
    // the heartbeat still beat (the body survived; the failure is per instance and visible in job_health)
    expect(await scalar<string | null>(db, `select last_ok_at::text from public.job_heartbeats where job = 'tick_instances'`)).not.toBeNull();
    // job_failures are stamped with the real clock, so health is read at now()
    expect(await asService(db, (d) => scalar<number>(d, `select recent_failures from public._job_health_at(now()) where job = 'tick_instances'`))).toBeGreaterThanOrEqual(1);
    await db.exec(`drop trigger boom on public.notification_outbox; drop function public._boom();`);
    await tick(at(deadlineOf('2030-01-07'), 1));
    expect(await statusOf(inst)).toBe('closed');
    expect(await entryCount('stake')).toBe(1);
    expect(await entryCount('payout')).toBe(1);
    expect(await balance(a)).toBe(1000);
    expect(await balance(b)).toBe(-500);
    expect(await balance(c)).toBe(-500);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'result'`)).toBe(3);
    await tick(at(deadlineOf('2030-01-07'), 2)); // re-running is a no-op
    expect(await entryCount()).toBe(2);
    await expectLedgerInvariants(fx.pactId);
  });
});

// =============================================================================================
describe('F-6: corrections after a revived day', () => {
  it('a revived day never draws carry, a later challenge on it corrects into a rollover, and the next winning day collects the carry', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    // Mon: everyone misses: 1500 rolls into the carry
    await closeDay(fx, '2030-01-07', ['failed', 'failed', 'failed']);
    expect(await carryBalance(fx.pactId)).toBe(1500);
    // Tue: a shows up, b's tap is unjudgeable, c is frozen: one active, voided; b's unverified stays on record
    const tue = await closeDay(fx, '2030-01-08', ['success', 'unverified', 'frozen']);
    expect(await statusOf(tue)).toBe('voided');
    expect(await carryBalance(fx.pactId)).toBe(1500);
    // a challenges b; c (the only voter) agrees: the day is revived with carry_in 0
    const r1 = await openReview(a, tue, b, 'challenge');
    await vote(c, r1, true);
    expect(await statusOf(tue)).toBe('closed');
    expect(await carryIn(tue)).toBe(0);
    expect(await balance(a)).toBe(500 - 500); // Mon -500, Tue +500
    expect(await balance(b)).toBe(-1000);
    expect(await carryBalance(fx.pactId)).toBe(1500); // untouched by the revival
    expect(await netsOf(tue)).toEqual([
      { user_id: a, net_cents: 500, pot_cents: 500 },
      { user_id: b, net_cents: -500, pot_cents: 500 },
    ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)));
    // b challenges a's success on the revived day; c agrees: both failed, the day becomes a rollover
    const r2 = await openReview(b, tue, a, 'challenge');
    await vote(c, r2, true);
    expect(await resultOf(tue, a)).toBe('failed');
    expect(await balance(a)).toBe(-1000);
    expect(await balance(b)).toBe(-1000);
    expect(await carryBalance(fx.pactId)).toBe(2500);
    expect(await carryIn(tue)).toBe(0);
    expect(await entryCount('correction')).toBe(1);
    // proven: the pool shown for the day is what was paid into it now (both pledges), not the first posting's figure
    expect(await netsOf(tue)).toEqual([
      { user_id: a, net_cents: -500, pot_cents: 1000 },
      { user_id: b, net_cents: -500, pot_cents: 1000 },
    ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)));
    // Wed: c alone shows up and collects both pledges plus the whole carry
    const wed = await closeDay(fx, '2030-01-09', ['failed', 'failed', 'success']);
    expect(await carryIn(wed)).toBe(2500);
    expect(await balance(c)).toBe(3500 - 500); // Mon -500, Tue frozen, Wed +3500
    expect(await carryBalance(fx.pactId)).toBe(0);
    expect((await netsOf(wed)).find((n) => n.user_id === c)).toEqual({ user_id: c, net_cents: 3500, pot_cents: 3500 });
    // the season recap agrees with the ledger: members' nets plus the carry are zero
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_season($1, '2030-01-07'::date, 1::smallint)`, [fx.pactId]));
    const recapSum = await asUser(db, a, (d) => scalar<number>(d, `select sum(net_cents)::int from public.pact_season_recaps where pact_id = $1`, [fx.pactId]));
    expect(recapSum + (await carryBalance(fx.pactId))).toBe(0);
    await expectLedgerInvariants(fx.pactId);
  });

  it('proven: after an accepted appeal the instance net view reports the pool that was actually split, carry included', async () => {
    const fx = await setup(3);
    const [a, b, c] = fx.participantIds;
    await gen(GEN_NOW);
    await closeDay(fx, '2030-01-07', ['failed', 'failed', 'failed']); // carry 1500
    const tue = await closeDay(fx, '2030-01-08', ['success', 'failed', 'failed']);
    expect(await balance(a)).toBe(-500 + 2500);
    expect((await netsOf(tue)).map((n) => n.pot_cents)).toEqual([2500, 2500, 2500]);
    // c appeals with a photo and the voters (a and b) agree: the pool is 500 + 1500, split two ways
    const appeal = await openReview(c, tue, c, 'appeal');
    await vote(a, appeal, true);
    await vote(b, appeal, true);
    expect(await resultOf(tue, c)).toBe('success');
    const nets = await netsOf(tue);
    expect(nets.find((n) => n.user_id === a)!.net_cents).toBe(1000);
    expect(nets.find((n) => n.user_id === c)!.net_cents).toBe(1000);
    expect(nets.find((n) => n.user_id === b)!.net_cents).toBe(-500);
    expect(nets.map((n) => n.pot_cents)).toEqual([2000, 2000, 2000]);
    await expectLedgerInvariants(fx.pactId);
  });

  it('a late in-fence tap by the person whose challenge was accepted does not undo the revival', async () => {
    const fx = await setup(2);
    const [a, b] = fx.participantIds;
    await gen(GEN_NOW);
    const mon = await closeDay(fx, '2030-01-07', ['success', 'unverified']);
    expect(await statusOf(mon)).toBe('voided');
    for (const d of ['2030-01-08', '2030-01-09']) await closeDay(fx, d, ['success', 'unverified']);
    const wed = await instanceOf(fx.pactId, '2030-01-09');
    const sys = await systemReviews(wed, b);
    expect(sys).toHaveLength(1);
    await vote(a, sys[0]!.id, true);
    expect(await statusOf(wed)).toBe('closed');
    expect(await balance(b)).toBe(-500);
    // b now "finds" an offline tap from inside the window
    await checkInAt(b, wed, { ...placeOf(1), acc: 5 }, at(deadlineOf('2030-01-09'), 30), at(deadlineOf('2030-01-09'), -1));
    expect(await resultOf(wed, b)).toBe('failed');
    expect(await balance(b)).toBe(-500);
    expect(await entryCount('correction')).toBe(0);
    await expectLedgerInvariants(fx.pactId);
  });
});
