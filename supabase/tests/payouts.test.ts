import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  asAnon,
  asService,
  asUser,
  createDb,
  createGroupFixture,
  expectError,
  rows,
  scalar,
  type DB,
  type GroupFixture,
} from './helpers/db';

// Scenarios insert pact_instances/results directly (as postgres) with status 'closed'
// and call the payout layer as service_role, like tick_instances / settle_due_groups do.

type Status = 'success' | 'failed' | 'unverified' | 'frozen' | 'void' | 'excluded' | 'pending';
type R = [userId: string, status: Status, firstSuccessAt?: string | null];

let dayOffset = 0;
function nextDate(): string {
  const d = new Date(Date.UTC(2026, 8, 1) + dayOffset++ * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function closedInstance(db: DB, pactId: string, results: R[], status = 'closed'): Promise<string> {
  const id = await scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
     select $1, d, t - interval '1 hour', t, $3::public.instance_status, t
       from (select $2::date d, ($2::date + time '09:00') at time zone 'America/Los_Angeles' t) x
     returning id`,
    [pactId, nextDate(), status],
  );
  for (const [uid, st, fsa] of results) {
    await db.query(`insert into public.results (instance_id, user_id, status, first_success_at) values ($1, $2, $3, $4)`, [
      id,
      uid,
      st,
      fsa ?? null,
    ]);
  }
  return id;
}

async function setResult(db: DB, instanceId: string, userId: string, status: Status, fsa: string | null = null) {
  await db.query(
    `insert into public.results (instance_id, user_id, status, first_success_at) values ($1, $2, $3, $4)
     on conflict (instance_id, user_id) do update set status = excluded.status, first_success_at = excluded.first_success_at`,
    [
    instanceId,
    userId,
    status,
    fsa,
  ]);
}

const payout = (db: DB, id: string) => asService(db, (d) => d.query(`select public.post_instance_payout($1)`, [id]));
const correct = (db: DB, id: string) => asService(db, (d) => d.query(`select public.apply_instance_correction($1)`, [id]));

/** Net ledger effect of an instance per member user id, plus 'carry'; pot excluded (must net to 0). */
async function effect(db: DB, instanceId: string): Promise<Record<string, number>> {
  const r = await rows<{ k: string; amt: number }>(
    db,
    `select coalesce(a.user_id::text, a.kind::text) k, sum(l.amount_cents)::bigint amt
       from public.ledger_entries e
       join public.ledger_lines l on l.entry_id = e.id
       join public.ledger_accounts a on a.id = l.account_id
      where e.instance_id = $1 and a.kind <> 'pot'
      group by 1 having sum(l.amount_cents) <> 0`,
    [instanceId],
  );
  return Object.fromEntries(r.map((x) => [x.k, Number(x.amt)]));
}

const potBalance = (db: DB, instanceId: string) =>
  scalar<number>(
    db,
    `select coalesce(sum(balance_cents), 0)::bigint from public.account_balances where kind = 'pot' and instance_id = $1`,
    [instanceId],
  ).then(Number);
const carryBalance = (db: DB, pactId: string) =>
  scalar<number>(
    db,
    `select coalesce(sum(balance_cents), 0)::bigint from public.account_balances where kind = 'carry' and pact_id = $1`,
    [pactId],
  ).then(Number);
const memberSum = (db: DB, groupId: string) =>
  scalar<number>(db, `select coalesce(sum(balance_cents), 0)::bigint from public.member_balances where group_id = $1`, [
    groupId,
  ]).then(Number);
const entries = (db: DB, instanceId: string) =>
  rows<{ kind: string; idempotency_key: string; n: number }>(
    db,
    `select e.kind::text, e.idempotency_key, (select count(*)::int from public.ledger_lines l where l.entry_id = e.id) n
       from public.ledger_entries e where e.instance_id = $1
      order by (select min(l.id) from public.ledger_lines l where l.entry_id = e.id)`,
    [instanceId],
  );
const carryIn = (db: DB, id: string) =>
  scalar<number | null>(db, `select carry_in_cents from public.pact_instances where id = $1`, [id]).then((v) =>
    v === null ? null : Number(v),
  );

const T = (hm: string) => `2026-09-01T${hm}:00Z`;

// Sort user ids so tests can reason about user_id tie-breaks.
function sorted(ids: string[]) {
  return [...ids].sort();
}

let db: DB;
let fx: GroupFixture;
let pact: string;
let u: string[];

async function freshGroup(members = 4, stakeCents = 500) {
  db = await createDb();
  fx = await createGroupFixture(db, { members, pact: { stakeCents } });
  pact = fx.pactId!;
  u = sorted(fx.userIds);
}

describe('post_instance_payout', () => {
  beforeEach(async () => freshGroup(4, 500));

  it('k>=1: failed stakes go to the pot, the pot is split among winners, and it ends at 0', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'success', T('15:20')],
      [u[2], 'failed'],
      [u[3], 'failed'],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: 500, [u[2]]: -500, [u[3]]: -500 });
    expect(await potBalance(db, i)).toBe(0);
    const e = await entries(db, i);
    expect(e.map((x) => [x.kind, x.idempotency_key])).toEqual([
      ['stake', `stake:${i}`],
      ['payout', `payout:${i}`],
    ]);
    expect(await carryIn(db, i)).toBe(0);
    expect(await carryBalance(db, pact)).toBe(0);
  });

  it('leftover cents go to the earliest first_success_at, regardless of user_id', async () => {
    await db.query(`update public.pacts set stake_cents = 100 where id = $1`, [pact]);
    // pot = 100, 3 winners -> 33 each + 1 leftover; u[2] (largest id of the winners) checked in first
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:30')],
      [u[1], 'success', T('15:20')],
      [u[2], 'success', T('15:05')],
      [u[3], 'failed'],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 33, [u[1]]: 33, [u[2]]: 34, [u[3]]: -100 });
  });

  it('leftover-cent ties on first_success_at break by user_id ascending; several leftover cents go one each', async () => {
    await db.query(`update public.pacts set stake_cents = 101 where id = $1`, [pact]);
    // pot = 101, 3 winners -> 33 each + 2 leftover. u[3] and u[1] tie at 15:05 -> u[1] first, then u[3].
    const i = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'success', T('15:05')],
      [u[2], 'success', T('15:01')],
      [u[3], 'success', T('15:05')],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: -101, [u[2]]: 34, [u[1]]: 34, [u[3]]: 33 });

    const j = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'success', T('15:05')],
      [u[2], 'success', T('15:09')],
      [u[3], 'success', T('15:05')],
    ]);
    await payout(db, j);
    expect(await effect(db, j)).toEqual({ [u[0]]: -101, [u[1]]: 34, [u[3]]: 34, [u[2]]: 33 });
  });

  it('k=0: stakes go member -> pot -> carry (stake then rollover); carry grows', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
      [u[2], 'failed'],
      [u[3], 'unverified'],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: -500, [u[1]]: -500, [u[2]]: -500, carry: 1500 });
    expect((await entries(db, i)).map((x) => [x.kind, x.idempotency_key])).toEqual([
      ['stake', `stake:${i}`],
      ['rollover', `rollover:${i}`],
    ]);
    expect(await potBalance(db, i)).toBe(0);
    expect(await carryBalance(db, pact)).toBe(1500);
    expect(await memberSum(db, fx.groupId)).toBe(-1500);
  });

  it('carry pays into the next pot with a winner; carry_in_cents is recorded and the carry empties', async () => {
    const a = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
    ]);
    await payout(db, a);
    const b = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
    ]);
    await payout(db, b);
    expect(await carryBalance(db, pact)).toBe(2000);
    expect(await carryIn(db, b)).toBe(1000);

    // 2 winners, 1 loser, 1 unverified: pot = 500 + 2000 = 2500 -> 1250 each
    const c = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'unverified'],
      [u[2], 'failed'],
      [u[3], 'success', T('15:11')],
    ]);
    await payout(db, c);
    expect(await carryIn(db, c)).toBe(2000);
    expect(await effect(db, c)).toEqual({ [u[0]]: 1250, [u[3]]: 1250, [u[2]]: -500, carry: -2000 });
    expect(await carryBalance(db, pact)).toBe(0);
    expect(await potBalance(db, c)).toBe(0);
    expect(await memberSum(db, fx.groupId)).toBe(0);
  });

  it('a winner with no losers still collects the carry', async () => {
    const a = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, a);
    const b = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'success', T('15:09')],
    ]);
    await payout(db, b);
    // pot 1500 / 2 = 750 each
    expect(await effect(db, b)).toEqual({ [u[0]]: 750, [u[1]]: 750, carry: -1500 });
  });

  it('all succeed with no carry: nothing moves, carry_in_cents = 0', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'success', T('15:11')],
    ]);
    await payout(db, i);
    expect(await entries(db, i)).toEqual([]);
    expect(await carryIn(db, i)).toBe(0);
  });

  it('fewer than 2 active, or a voided instance: no money moves and the carry is untouched', async () => {
    const seed = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
    ]);
    await payout(db, seed);
    const one = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'unverified'],
      [u[2], 'frozen'],
      [u[3], 'excluded'],
    ]);
    await payout(db, one);
    expect(await entries(db, one)).toEqual([]);
    const lonelyLoser = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'unverified'],
      [u[2], 'void'],
    ]);
    await payout(db, lonelyLoser);
    expect(await entries(db, lonelyLoser)).toEqual([]);
    const voided = await closedInstance(
      db,
      pact,
      [
        [u[0], 'void'],
        [u[1], 'void'],
        [u[2], 'frozen'],
      ],
      'voided',
    );
    await payout(db, voided);
    expect(await entries(db, voided)).toEqual([]);
    expect(await carryBalance(db, pact)).toBe(1000);
  });

  it('unverified, frozen, excluded and void participants never move money', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'unverified'],
      [u[3], 'excluded'],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: -500 });
  });

  it('is idempotent: calling twice posts nothing new', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    const before = await rows(db, `select id, idempotency_key from public.ledger_entries order by id`);
    const lines = await scalar<number>(db, `select count(*)::int from public.ledger_lines`);
    await payout(db, i);
    expect(await rows(db, `select id, idempotency_key from public.ledger_entries order by id`)).toEqual(before);
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(lines);
    expect(await carryIn(db, i)).toBe(0);
  });

  it('carry_in_cents is fixed at the first posting', async () => {
    const seed = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
    ]);
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await payout(db, i);
    await payout(db, seed); // carry now 1000, but i already posted with carry_in 0
    await payout(db, i);
    expect(await carryIn(db, i)).toBe(0);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: -500 });
    expect(await carryBalance(db, pact)).toBe(1000);
  });

  it('rejects instances that are not closed, and unknown instances', async () => {
    const i = await closedInstance(db, pact, [[u[0], 'pending']], 'open');
    const e = await expectError(payout(db, i), /not closed/);
    expect(e.code).toBe('23514');
    expect((await expectError(payout(db, '00000000-0000-0000-0000-000000000000'))).code).toBe('P0002');
  });

  it('client roles cannot call server functions', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    for (const fn of [`post_instance_payout($1)`, `apply_instance_correction($1)`]) {
      expect((await expectError(asUser(db, u[0], (d) => d.query(`select public.${fn}`, [i])))).code).toBe('42501');
      expect((await expectError(asAnon(db, (d) => d.query(`select public.${fn}`, [i])))).code).toBe('42501');
    }
    expect((await expectError(asUser(db, u[0], (d) => d.query(`select public.settle_due_groups()`)))).code).toBe('42501');
    expect(await entries(db, i)).toEqual([]);
  });
});

describe('apply_instance_correction', () => {
  beforeEach(async () => freshGroup(4, 500));

  async function correctionKeys(id: string) {
    return (await entries(db, id)).filter((e) => e.kind === 'correction').map((e) => e.idempotency_key);
  }

  it('failed -> success (accepted appeal): posts one correction entry with the difference', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
    await setResult(db, i, u[1], 'success', T('16:00'));
    await correct(db, i);
    // pot 500 / 2: u[0] +250, u[1] +250, u[2] -500
    expect(await effect(db, i)).toEqual({ [u[0]]: 250, [u[1]]: 250, [u[2]]: -500 });
    expect(await correctionKeys(i)).toEqual([`correction:${i}:1`]);
    expect(await potBalance(db, i)).toBe(0);
    const notes = await rows<{ user_id: string; payload: any }>(
      db,
      `select user_id, payload from public.notification_outbox where kind = 'result' order by user_id`,
    );
    expect(notes.map((n) => n.user_id).sort()).toEqual([u[0], u[1]].sort());
    const n1 = notes.find((n) => n.user_id === u[1])!;
    expect(n1.payload).toMatchObject({ instance_id: i, delta_cents: 750, net_cents: 250, correction: 1 });
  });

  it('success -> failed (accepted challenge)', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'success', T('15:12')],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    await setResult(db, i, u[1], 'failed');
    await correct(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
  });

  it('unverified -> failed makes a member active; failed -> unverified refunds', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'unverified'],
    ]);
    await payout(db, i);
    await setResult(db, i, u[2], 'failed');
    await correct(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
    await setResult(db, i, u[1], 'unverified');
    await correct(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[2]]: -500 });
    expect(await correctionKeys(i)).toEqual([`correction:${i}:1`, `correction:${i}:2`]);
  });

  it('a correction that drops below 2 active reverses everything', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await payout(db, i);
    await setResult(db, i, u[1], 'excluded');
    await correct(db, i);
    expect(await effect(db, i)).toEqual({});
  });

  it('no difference -> no entry; numbering continues 1, 2, 3', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    await correct(db, i);
    expect(await correctionKeys(i)).toEqual([]);
    await setResult(db, i, u[1], 'excluded');
    await correct(db, i);
    await correct(db, i);
    await setResult(db, i, u[2], 'excluded');
    await correct(db, i);
    await setResult(db, i, u[2], 'failed');
    await correct(db, i);
    expect(await correctionKeys(i)).toEqual([`correction:${i}:1`, `correction:${i}:2`, `correction:${i}:3`]);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[2]]: -500 });
  });

  it('uses the stored carry_in_cents, not the current carry', async () => {
    const seed = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, seed); // carry 1500
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await payout(db, i); // u0 +2000, carry 0
    const seed2 = await closedInstance(db, pact, [
      [u[2], 'failed'],
      [u[3], 'failed'],
    ]);
    await payout(db, seed2); // carry 1000
    await setResult(db, i, u[2], 'failed');
    await correct(db, i);
    // pot = 2*500 + 1500 (stored) = 2500
    expect(await effect(db, i)).toEqual({ [u[0]]: 2500, [u[1]]: -500, [u[2]]: -500, carry: -1500 });
    expect(await carryBalance(db, pact)).toBe(1000);
  });

  it('winner -> all fail: the carry it drew goes back to the carry plus the new stakes', async () => {
    const seed = await closedInstance(db, pact, [
      [u[0], 'failed'],
      [u[1], 'failed'],
    ]);
    await payout(db, seed);
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await payout(db, i); // u0 +1500
    await setResult(db, i, u[0], 'failed');
    await correct(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: -500, [u[1]]: -500, carry: 1000 });
    expect(await carryBalance(db, pact)).toBe(2000);
    expect(await memberSum(db, fx.groupId)).toBe(-2000);
  });

  it('a never-posted closed instance is posted normally (no correction entry)', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await correct(db, i);
    expect((await entries(db, i)).map((e) => e.idempotency_key)).toEqual([`stake:${i}`, `payout:${i}`]);
    expect(await carryIn(db, i)).toBe(0);
  });

  it('post_instance_payout on an already-posted instance with changed results applies a correction', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
      [u[2], 'failed'],
    ]);
    await payout(db, i);
    await setResult(db, i, u[2], 'unverified');
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: -500 });
    expect(await correctionKeys(i)).toEqual([`correction:${i}:1`]);
  });

  it('settled instances reject corrections', async () => {
    const i = await closedInstance(db, pact, [
      [u[0], 'success', T('15:10')],
      [u[1], 'failed'],
    ]);
    await payout(db, i);
    await db.query(`update public.pact_instances set status = 'settled' where id = $1`, [i]);
    await setResult(db, i, u[1], 'success', T('16:00'));
    const e = await expectError(correct(db, i), /settled/);
    expect(e.code).toBe('23514');
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: -500 });
    // post_instance_payout on a settled, posted instance is a no-op (not a correction)
    await payout(db, i);
    expect(await effect(db, i)).toEqual({ [u[0]]: 500, [u[1]]: -500 });
  });

  describe('carry safety: corrections never let the carry go negative', () => {
    // A all-fail (+1500 carry) -> B draws the 1500 -> A is corrected so it adds nothing to the carry.
    it('takes the shortfall back from the first later draw on the carry (oldest first), not from earlier draws', async () => {
      // Z: all-fail +1000 -> B0 draws 1000 (before A) -> A all-fail +1500 -> B draws 1500
      //   -> C all-fail +1000 -> D draws 1000 -> correct A (appeal accepted for u0)
      const z = await closedInstance(db, pact, [
        [u[2], 'failed'],
        [u[3], 'failed'],
      ]);
      await payout(db, z);
      const b0 = await closedInstance(db, pact, [
        [u[2], 'success', T('15:00')],
        [u[3], 'failed'],
      ]);
      await payout(db, b0);
      const a = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
        [u[2], 'failed'],
      ]);
      await payout(db, a);
      const b = await closedInstance(db, pact, [
        [u[3], 'success', T('15:00')],
        [u[2], 'failed'],
      ]);
      await payout(db, b);
      expect(await effect(db, b)).toEqual({ [u[3]]: 2000, [u[2]]: -500, carry: -1500 });
      const c = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
      ]);
      await payout(db, c);
      const dd = await closedInstance(db, pact, [
        [u[1], 'success', T('15:00')],
        [u[0], 'failed'],
      ]);
      await payout(db, dd);
      expect(await carryBalance(db, pact)).toBe(0);
      const snapshot = async () => ({
        z: await effect(db, z),
        b0: await effect(db, b0),
        c: await effect(db, c),
        dd: await effect(db, dd),
      });
      const before = await snapshot();

      await setResult(db, a, u[0], 'success', T('17:00'));
      await correct(db, a);

      // A now: u0 wins 1000 (u1, u2 stakes), carry contribution 0 (A had carry_in 0).
      expect(await effect(db, a)).toEqual({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
      // B's draw is cut from 1500 to 0: u3 only wins u2's stake.
      expect(await carryIn(db, b)).toBe(0);
      expect(await effect(db, b)).toEqual({ [u[3]]: 500, [u[2]]: -500 });
      expect((await entries(db, b)).map((e) => e.idempotency_key)).toContain(`correction:${b}:1`);
      // Nothing else moved.
      expect(await snapshot()).toEqual(before);
      expect(await carryBalance(db, pact)).toBe(0);
      expect(await memberSum(db, fx.groupId)).toBe(0);
      // B's members were notified of their correction too.
      expect(
        await scalar<number>(
          db,
          `select count(*)::int from public.notification_outbox where kind = 'result' and payload->>'instance_id' = $1`,
          [b],
        ),
      ).toBe(1);
    });

    it('reduces a later draw only by what A no longer contributes', async () => {
      // A all-fail +1500 -> B draws 1500 -> correct A to "u0 excluded": A now adds 1000 (needs 500 back).
      const a = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
        [u[2], 'failed'],
      ]);
      await payout(db, a);
      const b = await closedInstance(db, pact, [
        [u[3], 'success', T('15:00')],
        [u[2], 'failed'],
      ]);
      await payout(db, b); // u3 +2000
      await setResult(db, a, u[0], 'excluded');
      await correct(db, a);
      expect(await effect(db, a)).toEqual({ [u[1]]: -500, [u[2]]: -500, carry: 1000 });
      expect(await carryIn(db, b)).toBe(1000);
      expect(await effect(db, b)).toEqual({ [u[3]]: 1500, [u[2]]: -500, carry: -1000 });
      expect(await carryBalance(db, pact)).toBe(0);
      expect(await memberSum(db, fx.groupId)).toBe(0);
    });

    it('recovers from the draw that took the money even when newer carry could cover it', async () => {
      // A all-fail +1500 -> B draws 1500 -> C all-fail +1000 (carry 1000) -> correct A (u0 succeeded).
      // B's winner got A's 1500, so B gives it back; C's 1000 stays in the carry for the next winner.
      const a = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
        [u[2], 'failed'],
      ]);
      await payout(db, a);
      const b = await closedInstance(db, pact, [
        [u[3], 'success', T('15:00')],
        [u[2], 'failed'],
      ]);
      await payout(db, b);
      const c = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[3], 'failed'],
      ]);
      await payout(db, c);
      expect(await carryBalance(db, pact)).toBe(1000);
      await setResult(db, a, u[0], 'success', T('17:00'));
      await correct(db, a);
      expect(await effect(db, a)).toEqual({ [u[0]]: 1000, [u[1]]: -500, [u[2]]: -500 });
      expect(await carryIn(db, b)).toBe(0);
      expect(await effect(db, b)).toEqual({ [u[3]]: 500, [u[2]]: -500 });
      expect(await effect(db, c)).toEqual({ [u[0]]: -500, [u[3]]: -500, carry: 1000 });
      expect(await carryBalance(db, pact)).toBe(1000);
      expect(await memberSum(db, fx.groupId)).toBe(-1000);
    });

    it('an instance that newly draws its stored carry_in takes it back from the later draw', async () => {
      // Z all-fail +1000 -> A has 1 active (carry_in 1000, no draw) -> B all-fail +1000 -> C draws 2000
      // -> A's unverified becomes failed: A now draws its 1000, so C's draw drops to 1000.
      // D0, an earlier draw (before A was posted), is not touched.
      const z0 = await closedInstance(db, pact, [
        [u[2], 'failed'],
        [u[3], 'failed'],
      ]);
      await payout(db, z0);
      const d0 = await closedInstance(db, pact, [
        [u[3], 'success', T('15:00')],
        [u[2], 'failed'],
      ]);
      await payout(db, d0);
      const z = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
      ]);
      await payout(db, z);
      const a = await closedInstance(db, pact, [
        [u[0], 'success', T('15:00')],
        [u[1], 'unverified'],
      ]);
      await payout(db, a);
      expect(await carryIn(db, a)).toBe(1000);
      expect(await effect(db, a)).toEqual({});
      const b = await closedInstance(db, pact, [
        [u[2], 'failed'],
        [u[3], 'failed'],
      ]);
      await payout(db, b);
      const c = await closedInstance(db, pact, [
        [u[2], 'success', T('15:00')],
        [u[3], 'failed'],
      ]);
      await payout(db, c);
      expect(await effect(db, c)).toEqual({ [u[2]]: 2500, [u[3]]: -500, carry: -2000 });
      await setResult(db, a, u[1], 'failed');
      await correct(db, a);
      expect(await effect(db, a)).toEqual({ [u[0]]: 1500, [u[1]]: -500, carry: -1000 });
      expect(await carryIn(db, c)).toBe(1000);
      expect(await effect(db, c)).toEqual({ [u[2]]: 1500, [u[3]]: -500, carry: -1000 });
      expect(await carryIn(db, d0)).toBe(1000);
      expect(await effect(db, d0)).toEqual({ [u[3]]: 1500, [u[2]]: -500, carry: -1000 });
      expect(await carryBalance(db, pact)).toBe(0);
      expect(await memberSum(db, fx.groupId)).toBe(0);
    });

    it('fallback when the later draw is already settled: the corrected instance absorbs the shortfall', async () => {
      const a = await closedInstance(db, pact, [
        [u[0], 'failed'],
        [u[1], 'failed'],
        [u[2], 'failed'],
      ]);
      await payout(db, a);
      const b = await closedInstance(db, pact, [
        [u[3], 'success', T('15:00')],
        [u[2], 'failed'],
      ]);
      await payout(db, b);
      await db.query(`update public.pact_instances set status = 'settled' where id = $1`, [b]);
      await setResult(db, a, u[0], 'success', T('17:00'));
      await correct(db, a);
      // Target was u0 +1000 (diff +1500), carry diff -1500; the carry holds 0, so u0's diff is cut by 1500.
      expect(await effect(db, a)).toEqual({ [u[0]]: -500, [u[1]]: -500, [u[2]]: -500, carry: 1500 });
      expect(await carryBalance(db, pact)).toBe(0);
      expect(await effect(db, b)).toEqual({ [u[3]]: 2000, [u[2]]: -500, carry: -1500 });
      expect(await memberSum(db, fx.groupId)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// pgTAP mirror: run pgtap/payouts_test.sql against the same shim the foundation dry run uses.
// ---------------------------------------------------------------------------------------------
const SHIM = `
create schema extensions;
grant usage on schema extensions to public;
create table extensions.tap_log (n serial, ok boolean, descr text);
grant all on extensions.tap_log to public;
grant all on sequence extensions.tap_log_n_seq to public;
create function extensions.plan(int) returns text language sql as $$ select 'plan ' || $1 $$;
create function extensions._r(ok boolean, d text) returns text language plpgsql as $$
begin insert into extensions.tap_log (ok, descr) values (ok, d); return d; end $$;
create function extensions.is(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is not distinct from $2, $3 || ' [got ' || coalesce($1::text, 'null') || ']') $$;
create function extensions.isnt(anyelement, anyelement, text) returns text language sql as
  $$ select extensions._r($1 is distinct from $2, $3) $$;
create function extensions.throws_ok(text, text, text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(false, $4 || ' [no error]');
exception when others then return extensions._r(sqlstate = $2, $4 || ' [' || sqlstate || ' ' || sqlerrm || ']'); end $$;
create function extensions.lives_ok(text, text) returns text language plpgsql as $$
begin execute $1; return extensions._r(true, $2);
exception when others then return extensions._r(false, $2 || ' [' || sqlerrm || ']'); end $$;
create function extensions.finish() returns setof text language sql as $$ select 'done' $$;
`;

it('pgtap/payouts_test.sql passes against a pgTAP shim', async () => {
  const d = await createDb();
  await d.exec(SHIM);
  const src = readFileSync(new URL('./pgtap/payouts_test.sql', import.meta.url), 'utf8');
  const planned = Number(/select plan\((\d+)\)/.exec(src)?.[1]);
  const body = src.replace(/create extension if not exists pgtap[^;]*;/, '').replace(/^rollback;\s*$/m, '');
  await d.exec(body);
  const log = (await d.query<{ ok: boolean; descr: string }>(`select ok, descr from extensions.tap_log order by n`)).rows;
  await d.exec('rollback');
  expect(log.filter((l) => !l.ok).map((l) => l.descr)).toEqual([]);
  expect(log.length).toBe(planned);
});
