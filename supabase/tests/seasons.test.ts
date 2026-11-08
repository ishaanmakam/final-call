import { beforeEach, describe, expect, it } from 'vitest';
import { asAnon, asService, asUser, createDb, createGroupFixture, createUser, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

// 20261108000700_seasons.sql (night-1, Q2): optional seasons on a pact, per-pact streaks and the
// group's settle-up completion rate.
//
// Fixture pact: Mon-Fri 08:00-09:00 America/Los_Angeles, 3 members, 500 cents. Days are opened and
// closed with the real cron functions at the instance's own window_open_at / deadline_at, so the
// helpers below are DST-proof (January is PST, mid-March onwards PDT).
type Outcome = 'success' | 'failed' | 'unverified' | 'frozen';
type Fx = GroupFixture & { pactId: string };

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

const tick = (now: string) => asService(db, (d) => d.query(`select public.tick_instances($1::timestamptz)`, [now]));
const gen = (now: string) => asService(db, (d) => d.query(`select public.generate_instances(7, $1::timestamptz)`, [now]));
const settle = (now: string) => asService(db, (d) => scalar<number>(d, `select public.settle_due_groups($1::timestamptz)`, [now]));
const at = (iso: string, deltaMin = 0) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const placeOf = (i: number) => ({ lat: 47.6553 + i * 0.01, lng: -122.3035 });

interface Inst {
  id: string;
  window_open_at: string;
  deadline_at: string;
}
const instanceOf = async (pactId: string, date: string): Promise<Inst> => {
  const r = await rows<Inst>(db, `select id, window_open_at::text, deadline_at::text from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
  if (!r[0]) throw new Error(`no instance for ${date}`);
  return r[0];
};

async function setup(members = 3): Promise<Fx> {
  const fx = (await createGroupFixture(db, { members })) as Fx;
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [fx.pactId]);
  return fx;
}

const checkInAt = (user: string, inst: string, fix: { lat: number; lng: number; acc: number }, now: string) =>
  db.query(`select public.check_in_at($1, $2, $3, $4, $5, $6::timestamptz, false, null, $6::timestamptz)`, [user, inst, fix.lat, fix.lng, fix.acc, now]);

/** Opens and closes the pact's day for `date` with one outcome per participant (fixture order). Returns the instance id. */
async function closeDay(fx: Fx, date: string, outcomes: Outcome[]): Promise<string> {
  const inst = await instanceOf(fx.pactId, date);
  for (const [i, o] of outcomes.entries()) {
    if (o === 'frozen') {
      await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [fx.participantIds[i]!, inst.id, at(inst.window_open_at, -60)]);
    }
  }
  await tick(inst.window_open_at);
  for (const [i, o] of outcomes.entries()) {
    if (o === 'failed' || o === 'frozen') continue;
    await checkInAt(fx.participantIds[i]!, inst.id, { ...placeOf(i), acc: o === 'success' ? 10 : 250 }, at(inst.window_open_at, 10 + i));
  }
  await tick(inst.deadline_at);
  return inst.id;
}

const setSeason = (uid: string, pactId: string, start: string | null, weeks: number | null) =>
  asUser(db, uid, (d) => d.query(`select public.set_pact_season($1, $2::date, $3::smallint)`, [pactId, start, weeks]));

const seasonOf = (pactId: string) =>
  rows<{ season_start: string | null; season_weeks: number | null }>(db, `select season_start::text, season_weeks from public.pacts where id = $1`, [pactId]).then((r) => r[0]!);

interface Recap {
  user_id: string;
  season_start: string;
  season_end: string;
  days: number;
  showed_up: number;
  missed: number;
  unverified: number;
  frozen: number;
  net_cents: number;
}
const recapsAs = (uid: string, pactId: string) =>
  asUser(db, uid, (d) =>
    rows<Recap>(
      d,
      `select user_id::text, season_start::text, season_end::text, days, showed_up, missed, unverified, frozen, net_cents::int as net_cents
         from public.pact_season_recaps where pact_id = $1 order by user_id`,
      [pactId],
    ),
  );

interface Streak {
  user_id: string;
  current_streak: number;
  best_streak: number;
}
const streaksAs = (uid: string, pactId: string) =>
  asUser(db, uid, (d) => rows<Streak>(d, `select user_id::text, current_streak, best_streak from public.pact_streaks where pact_id = $1 order by user_id`, [pactId]));

interface Stats {
  group_id: string;
  obligations_created: number;
  obligations_confirmed: number;
  completion_rate: string | null;
  weeks_settled: number;
  last_settled_week: string | null;
}
const statsAs = (uid: string, groupId: string) =>
  asUser(db, uid, (d) =>
    rows<Stats>(
      d,
      `select group_id::text, obligations_created, obligations_confirmed, completion_rate::text, weeks_settled, last_settled_week::text from public.group_settlement_stats where group_id = $1`,
      [groupId],
    ),
  );

const byUser = <T extends { user_id: string }>(xs: T[], uid: string): T => {
  const r = xs.find((x) => x.user_id === uid);
  if (!r) throw new Error(`no row for ${uid}`);
  return r;
};

// =============================================================================================
describe('set_pact_season', () => {
  it('owner or pact creator sets and clears a season; others are refused', async () => {
    const fx = await setup();
    const [owner, member, other] = fx.userIds as [string, string, string];
    expect(await seasonOf(fx.pactId)).toEqual({ season_start: null, season_weeks: null });

    await setSeason(owner, fx.pactId, '2030-01-07', 4);
    expect(await seasonOf(fx.pactId)).toEqual({ season_start: '2030-01-07', season_weeks: 4 });

    // a plain member who did not create the pact
    expect((await expectError(setSeason(member, fx.pactId, '2030-01-14', 2))).code).toBe('42501');
    expect(await seasonOf(fx.pactId)).toEqual({ season_start: '2030-01-07', season_weeks: 4 });

    // the creator of another pact can set its season; a third member cannot
    const theirs = await asUser(db, member, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'Gym', '{1,3,5}'::smallint[], '17:00'::time, '18:00'::time, 300, 'America/Los_Angeles')`, [fx.groupId]),
    );
    await setSeason(member, theirs, '2030-02-04', 6);
    expect(await seasonOf(theirs)).toEqual({ season_start: '2030-02-04', season_weeks: 6 });
    expect((await expectError(setSeason(other, theirs, '2030-02-04', 6))).code).toBe('42501');

    // outsiders and anon
    const outsider = await createUser(db);
    expect((await expectError(setSeason(outsider, fx.pactId, '2030-01-07', 4))).code).toBe('42501');
    await expectError(asAnon(db, (d) => d.query(`select public.set_pact_season($1, '2030-01-07'::date, 4::smallint)`, [fx.pactId])), /permission denied/);

    // clearing: both null; half a season is an argument error
    await setSeason(owner, fx.pactId, null, null);
    expect(await seasonOf(fx.pactId)).toEqual({ season_start: null, season_weeks: null });
    expect((await expectError(setSeason(owner, fx.pactId, '2030-01-07', null))).code).toBe('22023');
    expect((await expectError(setSeason(owner, fx.pactId, null, 4))).code).toBe('22023');
    // 1..12 weeks
    expect((await expectError(setSeason(owner, fx.pactId, '2030-01-07', 0))).code).toBe('23514');
    expect((await expectError(setSeason(owner, fx.pactId, '2030-01-07', 13))).code).toBe('23514');
    await setSeason(owner, fx.pactId, '2030-01-07', 1);
    await setSeason(owner, fx.pactId, '2030-01-07', 12);
    expect(await seasonOf(fx.pactId)).toEqual({ season_start: '2030-01-07', season_weeks: 12 });
  });

  it('the pacts columns cannot be written by a client directly', async () => {
    const fx = await setup();
    await expectError(asUser(db, fx.ownerId, (d) => d.query(`update public.pacts set season_weeks = 4, season_start = '2030-01-07' where id = $1`, [fx.pactId])), /permission denied/);
  });
});

// =============================================================================================
describe('pact_season_recaps', () => {
  it('counts the days of the window and nets the ledger per member; members sum to zero with the carry', async () => {
    const fx = await setup();
    const [a, b, c] = fx.participantIds as [string, string, string];
    await setSeason(fx.ownerId, fx.pactId, '2030-01-07', 1); // Mon 7 .. Sun 13 January 2030
    await gen('2030-01-06T12:00:00Z');
    await closeDay(fx, '2030-01-07', ['success', 'failed', 'failed']); // A +1000, B -500, C -500
    await closeDay(fx, '2030-01-08', ['failed', 'failed', 'failed']); // all into the carry: -500 each
    await closeDay(fx, '2030-01-09', ['success', 'success', 'failed']); // pool 500 + carry 1500: A +1000, B +1000, C -500
    await closeDay(fx, '2030-01-10', ['frozen', 'success', 'failed']); // B +500, C -500
    await closeDay(fx, '2030-01-11', ['success', 'success', 'success']); // nothing moves
    await gen('2030-01-13T12:00:00Z');
    await closeDay(fx, '2030-01-14', ['failed', 'success', 'success']); // outside the season

    const recaps = await recapsAs(a, fx.pactId);
    expect(recaps).toHaveLength(3);
    for (const r of recaps) expect(r).toMatchObject({ season_start: '2030-01-07', season_end: '2030-01-13', days: 5 });
    expect(byUser(recaps, a)).toMatchObject({ showed_up: 3, missed: 1, unverified: 0, frozen: 1, net_cents: 1500 });
    expect(byUser(recaps, b)).toMatchObject({ showed_up: 3, missed: 2, unverified: 0, frozen: 0, net_cents: 500 });
    expect(byUser(recaps, c)).toMatchObject({ showed_up: 1, missed: 4, unverified: 0, frozen: 0, net_cents: -2000 });

    // the view agrees with the ledger: member nets of the window's instances, and members + carry = 0
    const ledger = await rows<{ user_id: string; net: number }>(
      db,
      `select a.user_id::text, sum(l.amount_cents)::int as net
         from public.ledger_entries e
         join public.pact_instances i on i.id = e.instance_id
         join public.ledger_lines l on l.entry_id = e.id
         join public.ledger_accounts a on a.id = l.account_id
        where i.pact_id = $1 and i.local_date between '2030-01-07' and '2030-01-13' and a.kind = 'member'
        group by a.user_id`,
      [fx.pactId],
    );
    for (const l of ledger) expect(byUser(recaps, l.user_id).net_cents).toBe(l.net);
    const carry = await scalar<number>(
      db,
      `select coalesce(sum(l.amount_cents), 0)::int
         from public.ledger_entries e
         join public.pact_instances i on i.id = e.instance_id
         join public.ledger_lines l on l.entry_id = e.id
         join public.ledger_accounts a on a.id = l.account_id
        where i.pact_id = $1 and i.local_date between '2030-01-07' and '2030-01-13' and a.kind = 'carry'`,
      [fx.pactId],
    );
    expect(recaps.reduce((s, r) => s + r.net_cents, 0) + carry).toBe(0);

    // every member sees the same rows; nobody else sees any; anon is denied
    expect(await recapsAs(c, fx.pactId)).toEqual(recaps);
    const outsider = await createUser(db);
    expect(await recapsAs(outsider, fx.pactId)).toEqual([]);
    await expectError(asAnon(db, (d) => d.query(`select * from public.pact_season_recaps`)), /permission denied/);

    // clearing the season removes the recap
    await setSeason(fx.ownerId, fx.pactId, null, null);
    expect(await recapsAs(a, fx.pactId)).toEqual([]);
  });

  it('the window is counted in local dates, so a season across the DST change keeps every scheduled day', async () => {
    const fx = await setup();
    const [a] = fx.participantIds as [string, string, string];
    await setSeason(fx.ownerId, fx.pactId, '2030-03-04', 2); // Mon 4 .. Sun 17 March 2030; DST starts Sun 10
    await gen('2030-03-03T12:00:00Z');
    const before = await instanceOf(fx.pactId, '2030-03-04');
    expect(before.window_open_at.startsWith('2030-03-04 16:00')).toBe(true); // PST
    for (const d of ['2030-03-04', '2030-03-05', '2030-03-06', '2030-03-07', '2030-03-08']) await closeDay(fx, d, ['success', 'failed', 'failed']);
    await gen('2030-03-10T12:00:00Z');
    const after = await instanceOf(fx.pactId, '2030-03-11');
    expect(after.window_open_at.startsWith('2030-03-11 15:00')).toBe(true); // PDT: an hour earlier in UTC than PST
    for (const d of ['2030-03-11', '2030-03-12', '2030-03-13', '2030-03-14']) await closeDay(fx, d, ['success', 'failed', 'failed']);
    await closeDay(fx, '2030-03-15', ['failed', 'success', 'failed']);
    await gen('2030-03-17T12:00:00Z');
    await closeDay(fx, '2030-03-18', ['success', 'success', 'failed']); // the Monday after the finish line

    const recaps = await recapsAs(a, fx.pactId);
    for (const r of recaps) expect(r).toMatchObject({ season_start: '2030-03-04', season_end: '2030-03-17', days: 10 });
    expect(byUser(recaps, a)).toMatchObject({ showed_up: 9, missed: 1, net_cents: 9 * 1000 - 500 });
  });

  it('days not yet closed, and voided days, are not part of the recap', async () => {
    const fx = await setup();
    const [a] = fx.participantIds as [string, string, string];
    await setSeason(fx.ownerId, fx.pactId, '2030-01-07', 1);
    await gen('2030-01-06T12:00:00Z');
    expect(await recapsAs(a, fx.pactId)).toEqual([]); // scheduled only
    await closeDay(fx, '2030-01-07', ['success', 'unverified', 'unverified']); // one active: voided
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1 and local_date = '2030-01-07'`, [fx.pactId])).toBe('voided');
    expect(await recapsAs(a, fx.pactId)).toEqual([]);
    await closeDay(fx, '2030-01-08', ['success', 'failed', 'unverified']);
    const recaps = await recapsAs(a, fx.pactId);
    expect(recaps).toHaveLength(3);
    expect(byUser(recaps, a)).toMatchObject({ days: 1, showed_up: 1, net_cents: 500 });
    expect(byUser(recaps, fx.participantIds[2]!)).toMatchObject({ days: 1, unverified: 1, net_cents: 0 });
  });
});

// =============================================================================================
describe('pact_streaks', () => {
  it('success extends, frozen is neutral, missed and unverified break, voided days are ignored', async () => {
    const fx = await setup();
    const [a, b, c] = fx.participantIds as [string, string, string];
    await gen('2030-01-06T12:00:00Z');
    await gen('2030-01-13T12:00:00Z');
    const days = ['2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11', '2030-01-14', '2030-01-15', '2030-01-16', '2030-01-17', '2030-01-18'];
    const plan: Record<string, Outcome[]> = {
      [a]: ['success', 'success', 'failed', 'success', 'success', 'success', 'frozen', 'success', 'unverified', 'success'],
      [b]: ['success', 'success', 'success', 'success', 'frozen', 'success', 'success', 'success', 'success', 'frozen'],
      [c]: ['failed', 'failed', 'success', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed'],
    };
    for (const [i, d] of days.entries()) await closeDay(fx, d, [plan[a]![i]!, plan[b]![i]!, plan[c]![i]!]);

    let streaks = await streaksAs(a, fx.pactId);
    expect(byUser(streaks, a)).toMatchObject({ current_streak: 1, best_streak: 4 });
    expect(byUser(streaks, b)).toMatchObject({ current_streak: 8, best_streak: 8 });
    expect(byUser(streaks, c)).toMatchObject({ current_streak: 0, best_streak: 1 });

    // a voided day (one active) changes nothing, not even B's unverified on it
    await gen('2030-01-20T12:00:00Z');
    await closeDay(fx, '2030-01-21', ['success', 'unverified', 'unverified']);
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1 and local_date = '2030-01-21'`, [fx.pactId])).toBe('voided');
    streaks = await streaksAs(b, fx.pactId);
    expect(byUser(streaks, a)).toMatchObject({ current_streak: 1, best_streak: 4 });
    expect(byUser(streaks, b)).toMatchObject({ current_streak: 8, best_streak: 8 });

    // a scheduled (not yet closed) day is not counted; a success on the next closed day extends
    await closeDay(fx, '2030-01-22', ['success', 'success', 'failed']);
    streaks = await streaksAs(c, fx.pactId);
    expect(byUser(streaks, a)).toMatchObject({ current_streak: 2, best_streak: 4 });
    expect(byUser(streaks, b)).toMatchObject({ current_streak: 9, best_streak: 9 });

    const outsider = await createUser(db);
    expect(await streaksAs(outsider, fx.pactId)).toEqual([]);
    await expectError(asAnon(db, (d) => d.query(`select * from public.pact_streaks`)), /permission denied/);
  });
});

// =============================================================================================
describe('group_settlement_stats', () => {
  it('confirmed over created (superseded excluded); null rate before any settle-up', async () => {
    const fx = await setup();
    const [a, b, c] = fx.participantIds as [string, string, string];
    // settlement catches up every week since the group was created: pretend it was created in the week we use
    await db.query(`update public.groups set created_at = '2030-01-07T20:00:00Z' where id = $1`, [fx.groupId]);
    expect(await statsAs(a, fx.groupId)).toEqual([
      { group_id: fx.groupId, obligations_created: 0, obligations_confirmed: 0, completion_rate: null, weeks_settled: 0, last_settled_week: null },
    ]);

    await gen('2030-01-06T12:00:00Z');
    await closeDay(fx, '2030-01-07', ['success', 'failed', 'failed']); // B -> A 500, C -> A 500
    // the rest of the week: everyone shows up, nothing moves (a later tick would otherwise close them as all-missed)
    for (const d of ['2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11']) await closeDay(fx, d, ['success', 'success', 'success']);
    expect(await settle('2030-01-14T20:00:00Z')).toBe(1); // Monday noon PST
    const week1 = await rows<{ id: string; from_user: string; to_user: string; amount_cents: number }>(
      db,
      `select id, from_user::text, to_user::text, amount_cents::int from public.obligations where group_id = $1 order by from_user`,
      [fx.groupId],
    );
    expect(week1).toHaveLength(2);
    expect(await statsAs(a, fx.groupId)).toEqual([
      { group_id: fx.groupId, obligations_created: 2, obligations_confirmed: 0, completion_rate: '0.0000', weeks_settled: 1, last_settled_week: '2030-01-07' },
    ]);

    const fromB = week1.find((o) => o.from_user === b)!;
    await asUser(db, b, (d) => d.query(`select public.mark_obligation_paid($1)`, [fromB.id]));
    expect((await statsAs(a, fx.groupId))[0]).toMatchObject({ obligations_confirmed: 0 }); // marked paid is not confirmed
    await asUser(db, a, (d) => d.query(`select public.confirm_obligation($1)`, [fromB.id]));
    expect(await statsAs(c, fx.groupId)).toEqual([
      { group_id: fx.groupId, obligations_created: 2, obligations_confirmed: 1, completion_rate: '0.5000', weeks_settled: 1, last_settled_week: '2030-01-07' },
    ]);

    // week 2: C's pending 500 is superseded and re-simplified (C -> B 250); created stays 2
    await gen('2030-01-13T12:00:00Z');
    await closeDay(fx, '2030-01-14', ['failed', 'success', 'success']);
    expect(await settle('2030-01-21T20:00:00Z')).toBe(1);
    const all = await rows<{ status: string; from_user: string; to_user: string; amount_cents: number }>(
      db,
      `select status::text, from_user::text, to_user::text, amount_cents::int from public.obligations where group_id = $1 order by status, amount_cents`,
      [fx.groupId],
    );
    expect(all.map((o) => o.status).sort()).toEqual(['confirmed', 'pending', 'superseded']);
    expect(all.find((o) => o.status === 'pending')).toMatchObject({ from_user: c, to_user: b, amount_cents: 250 });
    expect(await statsAs(b, fx.groupId)).toEqual([
      { group_id: fx.groupId, obligations_created: 2, obligations_confirmed: 1, completion_rate: '0.5000', weeks_settled: 2, last_settled_week: '2030-01-14' },
    ]);

    // visibility: a non-member sees no row; anon is denied; service sees it
    const outsider = await createUser(db);
    expect(await statsAs(outsider, fx.groupId)).toEqual([]);
    await expectError(asAnon(db, (d) => d.query(`select * from public.group_settlement_stats`)), /permission denied/);
    expect(await asService(db, (d) => scalar<number>(d, `select count(*)::int from public.group_settlement_stats where group_id = $1`, [fx.groupId]))).toBe(1);
  });
});
