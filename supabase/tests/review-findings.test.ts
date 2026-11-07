import { beforeEach, describe, expect, it } from 'vitest';
import {
  asService,
  asUser,
  createDb,
  createGroupFixture,
  rows,
  scalar,
  type DB,
  type GroupFixture,
  type PactSpec,
} from './helpers/db';

// Independent review findings. Every test here asserts the CORRECT behaviour (per DESIGN.md /
// CONTRACT.md / DECISIONS.md) and is expected to FAIL against the current migrations.

const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });

interface Fix {
  lat?: number | null;
  lng?: number | null;
  acc?: number | null;
  captured?: string;
  sim?: boolean;
}
const inFence = (i: number): Fix => ({ ...placeOf(i), acc: 10 });

async function checkInAt(db: DB, user: string, instance: string, fix: Fix, now: string) {
  const r = await db.query<any>(
    `select * from public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::timestamptz)`,
    [user, instance, fix.lat ?? null, fix.lng ?? null, fix.acc ?? null, fix.captured ?? now, fix.sim ?? false, null, now],
  );
  return r.rows[0];
}
const gen = (db: DB, now: string, days = 7) =>
  scalar<number>(db, `select public.generate_instances($1, $2::timestamptz)`, [days, now]);
const tick = (db: DB, now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const settle = (db: DB, now: string) =>
  asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
const instanceId = (db: DB, pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const resultOf = (db: DB, inst: string, user: string) =>
  scalar<string | undefined>(db, `select status::text from public.results where instance_id = $1 and user_id = $2`, [inst, user]);
const balanceOf = async (db: DB, group: string, user: string) =>
  Number(
    (await scalar<number>(
      db,
      `select coalesce(sum(balance_cents), 0)::bigint from public.member_balances where group_id = $1 and user_id = $2`,
      [group, user],
    )) ?? 0,
  );
const carryBalance = (db: DB, pactId: string) =>
  scalar<number>(
    db,
    `select coalesce(sum(balance_cents), 0)::bigint from public.account_balances where kind = 'carry' and pact_id = $1`,
    [pactId],
  ).then(Number);
const obligations = (db: DB, groupId: string, status?: string) =>
  rows<{ id: string; from_user: string; to_user: string; amount_cents: string; status: string }>(
    db,
    `select id, from_user::text, to_user::text, amount_cents, status::text from public.obligations
      where group_id = $1 and ($2::text is null or status::text = $2) order by from_user, to_user`,
    [groupId, status ?? null],
  );

async function setup(db: DB, opts: { members?: number; pact?: PactSpec; createdAt?: string } = {}) {
  const fx = await createGroupFixture(db, { members: opts.members ?? 3, pact: opts.pact });
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  if (opts.createdAt) await db.query(`update public.groups set created_at = $2 where id = $1`, [fx.groupId, opts.createdAt]);
  return fx as GroupFixture & { pactId: string };
}

// Direct-insert helpers (payouts.test.ts style)
type R = [userId: string, status: string, fsa?: string | null];
let dayOffset = 0;
async function closedInstance(db: DB, pactId: string, results: R[], localDate?: string): Promise<string> {
  const d = localDate ?? new Date(Date.UTC(2026, 8, 1) + dayOffset++ * 86_400_000).toISOString().slice(0, 10);
  const id = await scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status, closed_at)
     select $1, d, t - interval '1 hour', t, 'closed', t
       from (select $2::date d, ($2::date + time '09:00') at time zone 'America/Los_Angeles' t) x
     returning id`,
    [pactId, d],
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
async function setResult(db: DB, inst: string, user: string, status: string, fsa: string | null = null) {
  await db.query(`update public.results set status = $3, first_success_at = $4 where instance_id = $1 and user_id = $2`, [
    inst,
    user,
    status,
    fsa,
  ]);
}
const payout = (db: DB, id: string) => asService(db, (d) => d.query(`select public.post_instance_payout($1)`, [id]));
const correct = (db: DB, id: string) => asService(db, (d) => d.query(`select public.apply_instance_correction($1)`, [id]));
const entryCount = (db: DB, inst: string) =>
  scalar<number>(db, `select count(*)::int from public.ledger_entries where instance_id = $1`, [inst]);

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

// Jan 2030 is PST. Default pact Mon-Fri 08:00-09:00 LA. Mon 2030-01-07: open 16:00Z, deadline 17:00Z.
const GEN_NOW = '2030-01-06T12:00:00Z';
const MON = '2030-01-07';
const MON_OPEN = '2030-01-07T16:00:00.000Z';
const MON_DEADLINE = '2030-01-07T17:00:00.000Z';

describe('review findings', () => {
  it('BUG carry_fallback_leaves_stale_carry_in: a re-run correction steals a later rollover from the carry', async () => {
    const fx = await createGroupFixture(db, { members: 2, pact: { stakeCents: 500 } });
    const pact = fx.pactId!;
    const [x, y] = [...fx.userIds].sort();
    const T = (d: string) => `${d}T16:30:00Z`;
    const a = await closedInstance(db, pact, [[x, 'failed'], [y, 'failed']]); // carry +1000
    await payout(db, a);
    const b = await closedInstance(db, pact, [[x, 'failed'], [y, 'failed']]); // carry_in 1000, carry +1000
    await payout(db, b);
    const c = await closedInstance(db, pact, [[x, 'success', T('2026-09-03')], [y, 'failed']]); // draws 2000
    await payout(db, c);
    // x's appeals on A and B are accepted (in that order)
    await setResult(db, a, x, 'success', T('2026-09-01'));
    await correct(db, a);
    await setResult(db, b, x, 'success', T('2026-09-02'));
    await correct(db, b);
    // Correct end state had results been right from the start: x +1500, y -1500, carry 0.
    expect(await balanceOf(db, fx.groupId, x)).toBe(1500);
    expect(await carryBalance(db, pact)).toBe(0);
    // A later all-fail instance puts 1000 into the carry for the NEXT winner.
    const d = await closedInstance(db, pact, [[x, 'failed'], [y, 'failed']]);
    await payout(db, d);
    expect(await carryBalance(db, pact)).toBe(1000);
    // Re-running the correction for B with NO result change (settlement does exactly this for every
    // closed instance of the week) must be a no-op.
    const before = await entryCount(db, b);
    await correct(db, b);
    expect({
      carry: await carryBalance(db, pact),
      x: await balanceOf(db, fx.groupId, x),
      newEntries: (await entryCount(db, b)) - before,
    }).toEqual({ carry: 1000, x: 1500 - 500, newEntries: 0 });
  });

  it('BUG leave_group_mid_window_escapes_stake: a participant who will fail leaves before the deadline and pays nothing', async () => {
    const fx = await setup(db, { members: 3 });
    const [p0, p1, p2] = fx.participantIds;
    await gen(db, GEN_NOW);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, p0, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, p1, mon, inFence(1), at(MON_OPEN, 6));
    // p2 is nowhere near the place; at 08:58 they leave the group (they can rejoin after 09:00)
    // refusing the leave (23514) is a valid fix too
    await asUser(db, p2, (d) => d.query(`select public.leave_group($1)`, [fx.groupId])).catch((e) => expect(e.code).toBe('23514'));
    await tick(db, MON_DEADLINE);
    expect(await resultOf(db, mon, p2)).toBe('failed');
    expect(await balanceOf(db, fx.groupId, p2)).toBe(-500);
  });

  it('BUG marked_paid_superseded_payment_unrecordable: a Venmo payment marked paid is lost when the next settlement reroutes debts', async () => {
    const fx = await setup(db, { members: 3, createdAt: '2026-10-28T19:00:00Z' });
    const [u0, u1, u2] = [...fx.userIds].sort();
    const T = (d: string) => `${d}T16:30:00Z`;
    const w1 = await closedInstance(db, fx.pactId, [[u0, 'success', T('2026-10-28')], [u1, 'failed']], '2026-10-28');
    await payout(db, w1);
    await settle(db, '2026-11-02T20:00:00Z');
    const [o1] = await obligations(db, fx.groupId, 'pending');
    expect([o1.from_user, o1.to_user, Number(o1.amount_cents)]).toEqual([u1, u0, 500]);
    // u1 pays u0 $5 on Venmo and marks it paid; u0 hasn't opened the app yet.
    await asUser(db, u1, (d) => d.query(`select public.mark_obligation_paid($1)`, [o1.id]));
    // Week 2: u2 wins, u0 and u1 fail.
    const w2 = await closedInstance(
      db,
      fx.pactId,
      [[u2, 'success', T('2026-11-04')], [u0, 'failed'], [u1, 'failed']],
      '2026-11-04',
    );
    await payout(db, w2);
    await settle(db, '2026-11-09T20:00:00Z');
    // Real-world truth: u0 holds u1's $5. u1 should owe only 500 more, not 1000.
    const owedByU1 = (await obligations(db, fx.groupId, 'pending'))
      .filter((o) => o.from_user === u1)
      .reduce((s, o) => s + Number(o.amount_cents), 0);
    expect(owedByU1).toBe(500);
  });

  it('BUG marked_paid_superseded_cannot_confirm: the payee who did receive the money can no longer record it', async () => {
    const fx = await setup(db, { members: 3, createdAt: '2026-10-28T19:00:00Z' });
    const [u0, u1, u2] = [...fx.userIds].sort();
    const T = (d: string) => `${d}T16:30:00Z`;
    const w1 = await closedInstance(db, fx.pactId, [[u0, 'success', T('2026-10-28')], [u1, 'failed']], '2026-10-28');
    await payout(db, w1);
    await settle(db, '2026-11-02T20:00:00Z');
    const [o1] = await obligations(db, fx.groupId, 'pending');
    await asUser(db, u1, (d) => d.query(`select public.mark_obligation_paid($1)`, [o1.id]));
    const w2 = await closedInstance(
      db,
      fx.pactId,
      [[u2, 'success', T('2026-11-04')], [u0, 'failed'], [u1, 'failed']],
      '2026-11-04',
    );
    await payout(db, w2);
    await settle(db, '2026-11-09T20:00:00Z');
    // No obligation u1 -> u0 exists any more, so u0 has no way to record the $5 they hold.
    await asUser(db, u0, (d) => d.query(`select public.confirm_obligation($1)`, [o1.id]));
  });

  it('BUG late_offline_checkin_after_settlement_rejected: fail-open broken when the queued attempt arrives after Monday noon', async () => {
    // Sunday pact 22:00-23:00 LA. Sun 2030-01-13: open 2030-01-14T06:00Z, deadline 07:00Z.
    // Settlement for week 2030-01-07 runs Mon 2030-01-14 12:00 PST = 20:00Z (13 h later).
    const fx = await setup(db, {
      members: 3,
      pact: { days: [7], windowOpen: '22:00', deadline: '23:00' },
      createdAt: '2030-01-08T00:00:00Z',
    });
    const [p0, p1, p2] = fx.participantIds;
    await gen(db, '2030-01-12T12:00:00Z');
    const sun = await instanceId(db, fx.pactId, '2030-01-13');
    await tick(db, '2030-01-14T06:00:00Z');
    await checkInAt(db, p0, sun, inFence(0), '2030-01-14T06:10:00Z');
    await checkInAt(db, p1, sun, inFence(1), '2030-01-14T06:11:00Z');
    await tick(db, '2030-01-14T07:00:00Z');
    expect(await settle(db, '2030-01-14T20:00:00Z')).toBe(1);
    // p2 was at the place at 22:30 with no signal; the phone reconnects Monday 12:30.
    await checkInAt(db, p2, sun, { ...inFence(2), captured: '2030-01-14T06:30:00Z' }, '2030-01-14T20:30:00Z');
    expect(await resultOf(db, sun, p2)).toBe('unverified');
  });

  it('BUG client_clock_ahead_rejects_on_time_checkin: a fast phone clock turns an in-fence, on-time tap into an error (then failed)', async () => {
    const fx = await setup(db, { members: 3 });
    const [p0] = fx.participantIds;
    await gen(db, GEN_NOW);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    const now = at(MON_OPEN, 30);
    const row = await checkInAt(db, p0, mon, { ...inFence(0), captured: at(now, 3) }, now);
    expect(row.verdict).toBe('in_fence');
  });

  it('BUG settlement_bills_next_week_instance: Monday-morning results (still reviewable) are folded into last week\'s obligations', async () => {
    const fx = await setup(db, { members: 3, createdAt: '2030-01-08T00:00:00Z' });
    const [u0, u1] = [...fx.userIds].sort();
    // Mon 2030-01-14 09:00 PST = 17:00Z, closes and posts before Monday-noon settlement (20:00Z).
    const mon = await closedInstance(db, fx.pactId, [[u0, 'success', '2030-01-14T16:30:00Z'], [u1, 'failed']], '2030-01-14');
    await payout(db, mon);
    expect(await settle(db, '2030-01-14T20:00:00Z')).toBe(1); // settles week 2030-01-07 only
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [mon])).toBe('closed');
    expect(await obligations(db, fx.groupId, 'pending')).toEqual([]);
  });

  it('SPEC late_simulated_checkin_becomes_unverified: D4 says rejected_simulated counts as failed', async () => {
    const fx = await setup(db, { members: 3 });
    const [p0, p1, p2] = fx.participantIds;
    await gen(db, GEN_NOW);
    const mon = await instanceId(db, fx.pactId, MON);
    await tick(db, MON_OPEN);
    await checkInAt(db, p0, mon, inFence(0), at(MON_OPEN, 5));
    await checkInAt(db, p1, mon, inFence(1), at(MON_OPEN, 5));
    await checkInAt(db, p2, mon, { ...inFence(2), sim: true, captured: at(MON_DEADLINE, -5) }, at(MON_DEADLINE, 0.5));
    await tick(db, at(MON_DEADLINE, 1));
    expect(await resultOf(db, mon, p2)).toBe('failed');
  });
});
