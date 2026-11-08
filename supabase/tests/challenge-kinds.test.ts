// Challenge kinds (20261109000100_challenge_kinds.sql): distance / workouts / steps / custom pacts on the
// same pledge-forfeit-pool engine. Spec: docs/superpowers/specs/2026-11-08-challenge-kinds-design.md.
//
// Time anchors: America/Los_Angeles, January 2030 is PST (UTC-8). A weekly instance for the week of
// Monday 2030-01-07 opens 2030-01-07T08:00Z (Mon 00:00 local) and closes 2030-01-14T08:00Z (next Mon
// 00:00 local); Sunday 18:00 local is 2030-01-14T02:00Z.
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

const TZ = 'America/Los_Angeles';
const GEN_NOW = '2030-01-06T12:00:00Z'; // Sunday 04:00 local: generates the week of Mon 2030-01-07
const W1_OPEN = '2030-01-07T08:00:00.000Z';
const W1_DEADLINE = '2030-01-14T08:00:00.000Z';
const W1_SUNDAY_1759 = '2030-01-14T01:59:00Z';
const W1_SUNDAY_1800 = '2030-01-14T02:00:00Z';
const GOAL_M = 24140; // 15 miles
const at = (iso: string, deltaMin: number) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

type Act = {
  source: 'healthkit' | 'strava' | 'manual';
  external_id: string;
  activity_type: string;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number;
  steps: number | null;
  device: string | null;
  app_bundle: string | null;
  is_manual: boolean;
  raw_hash: string | null;
};
let seq = 0;
/** A 5 km run (30 min) starting at `start`, overridable; a longer distance gets a plausible duration (3 m/s) unless given. */
function run(start: string, o: Partial<Act> = {}): Act {
  const startedAt = new Date(start).toISOString();
  const dist = o.distance_m === undefined ? 5000 : o.distance_m;
  const dur = o.duration_s ?? (dist === null || dist <= 5000 ? 1800 : Math.ceil(dist / 3));
  return {
    source: 'healthkit',
    external_id: `hk-${++seq}`,
    activity_type: 'running',
    started_at: startedAt,
    ended_at: at(startedAt, 30),
    distance_m: 5000,
    duration_s: dur,
    steps: null,
    device: 'Apple Watch',
    app_bundle: 'com.apple.Fitness',
    is_manual: false,
    raw_hash: null,
    ...o,
  };
}

let db: DB;
beforeEach(async () => {
  db = await createDb();
});

const tick = (now: string) => db.query(`select public.tick_instances($1::timestamptz)`, [now]);
const gen = (now: string, days = 7) => scalar<number>(db, `select public.generate_instances($1, $2::timestamptz)`, [days, now]);
const instanceOf = (pactId: string, date: string) =>
  scalar<string>(db, `select id from public.pact_instances where pact_id = $1 and local_date = $2`, [pactId, date]);
const submitAt = (user: string, acts: Act[], now: string) =>
  scalar<number>(db, `select public.submit_activities_at($1, $2::jsonb, $3::timestamptz)`, [user, JSON.stringify(acts), now]);
const verdicts = (user: string) =>
  rows<{ external_id: string; verdict: string; reject_reason: string | null }>(
    db,
    `select external_id, verdict::text, reject_reason from public.activities where user_id = $1 order by submitted_at, external_id`,
    [user],
  );
const resultsOf = async (inst: string) =>
  Object.fromEntries(
    (
      await rows<{ user_id: string; status: string; first_success_at: Date | null }>(
        db,
        `select user_id, status::text, first_success_at from public.results where instance_id = $1`,
        [inst],
      )
    ).map((r) => [r.user_id, { status: r.status, first: r.first_success_at?.toISOString() ?? null }]),
  );
const netsOf = async (inst: string) =>
  Object.fromEntries(
    (
      await rows<{ user_id: string; net: number }>(
        db,
        `select a.user_id, sum(l.amount_cents)::int as net
           from public.ledger_lines l join public.ledger_entries e on e.id = l.entry_id
           join public.ledger_accounts a on a.id = l.account_id
          where e.instance_id = $1 and a.kind = 'member' group by a.user_id`,
        [inst],
      )
    ).map((r) => [r.user_id, r.net]),
  );
const progressOf = (inst: string) =>
  rows<{ user_id: string; value: string; goal: string; activity_count: number; reached_at: Date | null }>(
    db,
    `select user_id, value::text, goal::text, activity_count, reached_at from public.instance_progress where instance_id = $1 order by user_id`,
    [inst],
  );

type Fx = GroupFixture & { pactId: string };

interface GoalPact {
  title?: string;
  kind: 'distance' | 'workouts' | 'steps' | 'custom';
  period: 'daily' | 'weekly' | 'once';
  goal?: number | null;
  unit?: string | null;
  types?: string[] | null;
  days?: number[] | null;
  windowOpen?: string | null;
  deadline?: string | null;
  raceStart?: string | null;
  raceEnd?: string | null;
  stake?: number;
}

async function createGoalPact(fx: GroupFixture, p: GoalPact, creator = fx.ownerId): Promise<string> {
  return asUser(db, creator, (d) =>
    scalar<string>(
      d,
      `select public.create_pact($1, $2, $3::smallint[], $4::time, $5::time, $6, $7, $8::public.pact_kind, $9::public.pact_period,
                                 $10::numeric, $11, $12::text[], $13::date, $14::date)`,
      [
        fx.groupId,
        p.title ?? `${p.kind} ${p.period}`,
        p.days ?? null,
        p.windowOpen ?? null,
        p.deadline ?? null,
        p.stake ?? 500,
        TZ,
        p.kind,
        p.period,
        p.goal === undefined ? (p.kind === 'distance' ? GOAL_M : p.kind === 'workouts' ? 3 : p.kind === 'steps' ? 10000 : null) : p.goal,
        p.unit === undefined ? (p.kind === 'distance' ? 'm' : p.kind === 'workouts' ? 'count' : p.kind === 'steps' ? 'steps' : null) : p.unit,
        p.types === undefined ? (p.kind === 'distance' || p.kind === 'workouts' ? ['running'] : null) : p.types,
        p.raceStart ?? null,
        p.raceEnd ?? null,
      ],
    ),
  );
}

/** Group of `members` with one goal pact everyone joined (joins backdated so they are on every 2030 roster). */
async function goalFixture(p: GoalPact, members = 3): Promise<Fx> {
  const fx = await createGroupFixture(db, { members, pact: false, tz: TZ });
  const pactId = await createGoalPact(fx, p);
  for (const u of fx.userIds) {
    await asUser(db, u, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [pactId]));
  }
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pactId]);
  return { ...fx, pactId, participantIds: fx.userIds };
}

async function weeklyFixture(members = 3): Promise<Fx & { inst: string }> {
  const fx = await goalFixture({ kind: 'distance', period: 'weekly', title: '15 miles a week' }, members);
  expect(await gen(GEN_NOW)).toBe(1);
  const inst = await instanceOf(fx.pactId, '2030-01-07');
  await tick(W1_OPEN);
  expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [inst])).toBe('open');
  return { ...fx, inst };
}

// =============================================================================================
describe('pacts: kinds, periods and create_pact', () => {
  it('the 7-argument create_pact still works and makes a daily show_up pact', async () => {
    const fx = await createGroupFixture(db);
    const p = await rows(db, `select kind::text, period::text, goal_value, goal_unit, activity_types, race_start, race_end, days_of_week from public.pacts where id = $1`, [fx.pactId]);
    expect(p[0]).toEqual({ kind: 'show_up', period: 'daily', goal_value: null, goal_unit: null, activity_types: null, race_start: null, race_end: null, days_of_week: [1, 2, 3, 4, 5] });
  });

  it('a weekly distance pact stores its goal in metres with {running} by default and no days', async () => {
    const fx = await createGroupFixture(db, { pact: false });
    const id = await createGoalPact(fx, { kind: 'distance', period: 'weekly', types: undefined });
    const p = await rows(db, `select kind::text, period::text, goal_value::text, goal_unit, activity_types, days_of_week, race_start from public.pacts where id = $1`, [id]);
    expect(p[0]).toEqual({ kind: 'distance', period: 'weekly', goal_value: '24140', goal_unit: 'm', activity_types: ['running'], days_of_week: null, race_start: null });
    // explicit types and unit
    const walkRun = await createGoalPact(fx, { kind: 'distance', period: 'weekly', types: ['running', 'walking'], goal: 10000 });
    expect(await scalar(db, `select activity_types from public.pacts where id = $1`, [walkRun])).toEqual(['running', 'walking']);
    const workouts = await createGoalPact(fx, { kind: 'workouts', period: 'weekly', types: ['strength', 'yoga'], goal: 3 });
    expect(await rows(db, `select goal_value::text g, goal_unit u from public.pacts where id = $1`, [workouts])).toEqual([{ g: '3', u: 'count' }]);
    const steps = await createGoalPact(fx, { kind: 'steps', period: 'daily', days: [1, 2, 3, 4, 5, 6, 7] });
    expect(await rows(db, `select goal_unit u, window_open_local::text o, deadline_local::text d from public.pacts where id = $1`, [steps])).toEqual([{ u: 'steps', o: '00:00:00', d: '23:59:00' }]);
    const custom = await createGoalPact(fx, { kind: 'custom', period: 'daily', days: [1, 3], windowOpen: '06:00', deadline: '22:00' });
    expect(await rows(db, `select goal_value g, days_of_week dw from public.pacts where id = $1`, [custom])).toEqual([{ g: null, dw: [1, 3] }]);
  });

  it('refuses inconsistent kind / period / goal combinations with 22023', async () => {
    const fx = await createGroupFixture(db, { pact: false });
    const bad = (p: GoalPact) => code(createGoalPact(fx, p));
    expect(await bad({ kind: 'distance', period: 'weekly', goal: null })).toBe('22023'); // goal required
    expect(await bad({ kind: 'distance', period: 'weekly', goal: 0 })).toBe('22023');
    expect(await bad({ kind: 'distance', period: 'daily' })).toBe('22023'); // distance is weekly or once
    expect(await bad({ kind: 'distance', period: 'weekly', unit: 'count' })).toBe('22023'); // unit must match the kind
    expect(await bad({ kind: 'distance', period: 'weekly', types: ['skiing'] })).toBe('22023'); // unknown type
    expect(await bad({ kind: 'distance', period: 'weekly', types: [] })).toBe('22023');
    expect(await bad({ kind: 'workouts', period: 'once', raceStart: '2030-01-10', raceEnd: '2030-01-12' })).toBe('22023');
    expect(await bad({ kind: 'steps', period: 'weekly' })).toBe('22023');
    expect(await bad({ kind: 'custom', period: 'once', raceStart: '2030-01-10', raceEnd: '2030-01-12' })).toBe('22023');
    expect(await bad({ kind: 'custom', period: 'daily', goal: 3, unit: 'count' })).toBe('22023'); // custom has no goal
    expect(await bad({ kind: 'custom', period: 'daily', days: null, deadline: '09:00' })).toBe('22023'); // daily needs days
    expect(await bad({ kind: 'distance', period: 'once' })).toBe('22023'); // race dates required
    expect(await bad({ kind: 'distance', period: 'once', raceStart: '2030-01-12', raceEnd: '2030-01-10' })).toBe('22023');
    expect(await bad({ kind: 'distance', period: 'weekly', raceStart: '2030-01-10', raceEnd: '2030-01-12' })).toBe('22023'); // dates only for once
    // show_up with a goal
    const r = await code(
      asUser(db, fx.ownerId, (d) =>
        d.query(`select public.create_pact($1, 't', '{1}', '08:00', '09:00', 500, $2, 'show_up', 'daily', 5, 'count', null, null, null)`, [fx.groupId, TZ]),
      ),
    );
    expect(r).toBe('22023');
    expect(await scalar<number>(db, `select count(*)::int from public.pacts where group_id = $1`, [fx.groupId])).toBe(0);
  });

  it('a race is one instance from race_start 00:00 to race_end + 1 day 00:00; its dates are locked once it opens', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const id = await createGoalPact(fx, { kind: 'distance', period: 'once', raceStart: '2030-01-10', raceEnd: '2030-01-12', goal: 10000 });
    expect(await gen(GEN_NOW)).toBe(1);
    const inst = await rows<{ d: string; o: Date; dl: Date }>(
      db,
      `select to_char(local_date, 'YYYY-MM-DD') d, window_open_at o, deadline_at dl from public.pact_instances where pact_id = $1`,
      [id],
    );
    expect(inst).toHaveLength(1);
    expect(inst[0].d).toBe('2030-01-10');
    expect(inst[0].o.toISOString()).toBe('2030-01-10T08:00:00.000Z');
    expect(inst[0].dl.toISOString()).toBe('2030-01-13T08:00:00.000Z');
    expect(await gen(GEN_NOW)).toBe(0); // idempotent
    // before the window opens the race can still be edited (service role / SQL editor)
    await asService(db, (d) => d.query(`update public.pacts set race_end = '2030-01-13' where id = $1`, [id]));
    await db.query(`update public.pacts set race_end = '2030-01-12' where id = $1`, [id]);
    await tick('2030-01-10T08:00:00Z');
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1`, [id])).toBe('open');
    expect(await code(asService(db, (d) => d.query(`update public.pacts set race_end = '2030-01-20' where id = $1`, [id])))).toBe('23514');
    expect(await code(asService(db, (d) => d.query(`update public.pacts set goal_value = 1 where id = $1`, [id])))).toBe('23514');
    expect(await code(asService(db, (d) => d.query(`update public.pacts set activity_types = '{walking}' where id = $1`, [id])))).toBe('23514');
    // unrelated columns still change
    await asService(db, (d) => d.query(`update public.pacts set title = 'Half marathon' where id = $1`, [id]));
    expect(await scalar(db, `select race_end::text from public.pacts where id = $1`, [id])).toBe('2030-01-12');
  });

  it('a race that already started is not generated (nobody could be on its roster)', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    await createGoalPact(fx, { kind: 'distance', period: 'once', raceStart: '2030-01-05', raceEnd: '2030-01-12', goal: 10000 });
    expect(await gen(GEN_NOW)).toBe(0);
  });
});

// =============================================================================================
describe('join_pact without a place', () => {
  it('goal kinds join with nulls, keep no place history and can join while a week is open; show_up still needs a place', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const id = await createGoalPact(fx, { kind: 'distance', period: 'weekly' });
    await asUser(db, fx.userIds[1], (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [id]));
    // the 1-arg form (defaults) works too
    await asUser(db, fx.userIds[0], (d) => d.query(`select public.join_pact($1)`, [id]));
    expect(await rows(db, `select place_lat, place_lng, place_radius_m, place_label from public.pact_participants where pact_id = $1 and user_id = $2`, [id, fx.userIds[1]]))
      .toEqual([{ place_lat: null, place_lng: null, place_radius_m: null, place_label: null }]);
    expect(await scalar<number>(db, `select count(*)::int from public.pact_participant_places where pact_id = $1`, [id])).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.place_events where pact_id = $1`, [id])).toBe(0);
    // a place passed for a goal kind is ignored, not stored
    await asUser(db, fx.userIds[2], (d) => d.query(`select public.join_pact($1, 47.6, -122.3, 100, 'gym')`, [id]));
    expect(await scalar(db, `select place_lat from public.pact_participants where pact_id = $1 and user_id = $2`, [id, fx.userIds[2]])).toBeNull();

    // the week is open: a 4th member can still join (they are on next week's roster, not this one's)
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [id]);
    await gen(GEN_NOW);
    const inst = await instanceOf(id, '2030-01-07');
    await tick(W1_OPEN);
    const late = await createUser(db, undefined, 'Late');
    await asUser(db, late, (d) => d.query(`select public.join_group($1)`, [fx.inviteCode]));
    await asUser(db, late, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [id]));
    // (the wall clock is 2026; place the join mid-week 2030 where the scenario lives)
    await db.query(`update public.pact_participants set joined_at = '2030-01-09T20:00:00Z' where pact_id = $1 and user_id = $2`, [id, late]);
    const roster = (await rows<{ u: string }>(db, `select u::text from public._instance_participants($1) u`, [inst])).map((r) => r.u).sort();
    expect(roster).toEqual([...fx.userIds].sort());

    // show_up: a place is required
    const showUp = await asUser(db, fx.ownerId, (d) =>
      scalar<string>(d, `select public.create_pact($1, 'class', '{1,2,3,4,5}', '08:00', '09:00', 500, $2)`, [fx.groupId, TZ]),
    );
    expect(await code(asUser(db, fx.userIds[1], (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [showUp])))).toBe('22023');
    expect(await code(asUser(db, fx.userIds[1], (d) => d.query(`select public.join_pact($1)`, [showUp])))).toBe('22023');
    await asUser(db, fx.userIds[1], (d) => d.query(`select public.join_pact($1, 47.6, -122.3, 100, 'class')`, [showUp]));
    expect(await scalar<number>(db, `select count(*)::int from public.pact_participant_places where pact_id = $1`, [showUp])).toBe(1);
  });
});

// =============================================================================================
describe('generate_instances per period', () => {
  it('weekly: one instance per ISO week, Monday local_date, Mon 00:00 to next Mon 00:00 in the pact zone; daily pacts unchanged', async () => {
    const fx = await createGroupFixture(db, { tz: TZ }); // the daily show_up fixture pact (Mon-Fri)
    const weekly = await createGoalPact(fx, { kind: 'distance', period: 'weekly' });
    // Sunday 2030-01-06: the daily pact gets Mon..Fri (5), the weekly pact gets Mon 2030-01-07 (1)
    expect(await gen(GEN_NOW)).toBe(6);
    const w = await rows<{ d: string; o: Date; dl: Date; status: string }>(
      db,
      `select to_char(local_date, 'YYYY-MM-DD') d, window_open_at o, deadline_at dl, status::text from public.pact_instances where pact_id = $1 order by local_date`,
      [weekly],
    );
    expect(w).toHaveLength(1);
    expect(w[0].d).toBe('2030-01-07');
    expect(w[0].o.toISOString()).toBe(W1_OPEN);
    expect(w[0].dl.toISOString()).toBe(W1_DEADLINE);
    expect(w[0].status).toBe('scheduled');
    expect(await scalar<number>(db, `select count(*)::int from public.pact_instances where pact_id = $1`, [fx.pactId])).toBe(5);
    expect(await gen(GEN_NOW)).toBe(0);
    // Monday 00:00 local: the week opens and the following week (exactly 7 days ahead) is generated
    await tick(W1_OPEN);
    expect(await gen(W1_OPEN)).toBeGreaterThanOrEqual(1);
    expect(await rows(db, `select to_char(local_date, 'YYYY-MM-DD') d from public.pact_instances where pact_id = $1 order by local_date`, [weekly]))
      .toEqual([{ d: '2030-01-07' }, { d: '2030-01-14' }]);
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1 and local_date = '2030-01-07'`, [weekly])).toBe('open');
    // mid-week nothing new appears for the weekly pact (the current week is open, next week exists);
    // the daily pact's horizon grows by Tue 15 and Wed 16
    expect(await gen('2030-01-09T20:00:00Z')).toBe(2);
    expect(await scalar<number>(db, `select count(*)::int from public.pact_instances where pact_id = $1`, [weekly])).toBe(2);
  });

  it('weekly across the spring-forward week is 167 hours long (DST handled at both ends)', async () => {
    const fx = await createGroupFixture(db, { pact: false, tz: TZ });
    const weekly = await createGoalPact(fx, { kind: 'distance', period: 'weekly' });
    expect(await gen('2027-03-07T12:00:00Z')).toBe(1); // Sunday: Mon 2027-03-08 is generated
    const w = await rows<{ o: Date; dl: Date }>(db, `select window_open_at o, deadline_at dl from public.pact_instances where pact_id = $1`, [weekly]);
    expect(w[0].o.toISOString()).toBe('2027-03-08T08:00:00.000Z'); // PST
    expect(w[0].dl.toISOString()).toBe('2027-03-15T07:00:00.000Z'); // PDT
    expect((w[0].dl.getTime() - w[0].o.getTime()) / 3_600_000).toBe(167);
  });

  it('paused weekly pacts are skipped and their future week is voided and revived like daily ones', async () => {
    const fx = await goalFixture({ kind: 'distance', period: 'weekly' });
    expect(await gen(GEN_NOW)).toBe(1);
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId]));
    await tick('2030-01-06T13:00:00Z');
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1`, [fx.pactId])).toBe('voided');
    expect(await gen(GEN_NOW)).toBe(0);
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, false)`, [fx.pactId]));
    expect(await gen(GEN_NOW)).toBe(1);
    expect(await scalar(db, `select status::text from public.pact_instances where pact_id = $1`, [fx.pactId])).toBe('scheduled');
  });
});

// =============================================================================================
describe('submit_activities: verdicts, idempotency and access', () => {
  it('accepts a workout and rejects manual, future, unknown-type and implausible ones with reasons', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const now = at(W1_OPEN, 12 * 60); // Monday noon local
    const n = await submitAt(
      a,
      [
        run(at(W1_OPEN, 7 * 60), { external_id: 'ok' }),
        run(at(W1_OPEN, 8 * 60), { external_id: 'manual', is_manual: true }),
        run(at(now, -20), { external_id: 'future', ended_at: at(now, 10) }),
        run(at(now, -40), { external_id: 'almost-future', ended_at: at(now, 4) }), // within the 5 min slack
        run(at(W1_OPEN, 9 * 60), { external_id: 'skiing', activity_type: 'skiing' }),
        run(at(W1_OPEN, 10 * 60), { external_id: 'teleport', distance_m: GOAL_M, duration_s: 20, ended_at: at(W1_OPEN, 10 * 60 + 1) }),
        run(at(W1_OPEN, 11 * 60), { external_id: 'fast-bike', activity_type: 'cycling', distance_m: GOAL_M, duration_s: 1000, ended_at: at(W1_OPEN, 11 * 60 + 17) }),
        run(at(W1_OPEN, 5 * 60), { external_id: 'strava-manual', source: 'strava', is_manual: true }),
      ],
      now,
    );
    expect(n).toBe(8);
    const v = Object.fromEntries((await verdicts(a)).map((r) => [r.external_id, [r.verdict, r.reject_reason]]));
    expect(v['ok']).toEqual(['accepted', null]);
    expect(v['manual'][0]).toBe('rejected_manual');
    expect(v['strava-manual'][0]).toBe('rejected_manual');
    expect(v['future'][0]).toBe('rejected_future');
    expect(v['almost-future'][0]).toBe('accepted');
    expect(v['skiing']).toEqual(['rejected_type', 'unknown activity type']);
    expect(v['teleport']).toEqual(['rejected_type', 'implausible pace']);
    expect(v['fast-bike'][0]).toBe('accepted'); // 24 m/s is under the 25 m/s cycling bound
    // only the two accepted runs count toward the week (the bike ride is not an allowed type here)
    const p = await progressOf(fx.inst);
    expect(p.find((r) => r.user_id === a)).toMatchObject({ value: '10000', goal: '24140', activity_count: 2, reached_at: null });
  });

  it('a second source covering 80 % of an accepted activity is a duplicate; first accepted wins', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const t0 = at(W1_OPEN, 10 * 60);
    const now = at(W1_OPEN, 24 * 60);
    await submitAt(a, [run(t0, { external_id: 'hk-run', ended_at: at(t0, 30) })], now);
    await submitAt(
      a,
      [
        run(at(t0, 2), { source: 'strava', external_id: 'st-dup', ended_at: at(t0, 31) }), // 28 of 29 min overlap
        run(at(t0, 25), { source: 'strava', external_id: 'st-other', ended_at: at(t0, 60) }), // 5 of 30 min overlap
        run(at(t0, 5), { external_id: 'hk-same-source', ended_at: at(t0, 30) }), // same source: not the duplicate rule's business
      ],
      now,
    );
    const v = Object.fromEntries((await verdicts(a)).map((r) => [r.external_id, r.verdict]));
    expect(v).toEqual({ 'hk-run': 'accepted', 'st-dup': 'rejected_duplicate', 'st-other': 'accepted', 'hk-same-source': 'accepted' });
    expect(await scalar(db, `select reject_reason from public.activities where external_id = 'st-dup'`)).toMatch(/healthkit/);
    // a rejected (manual) activity never blocks a real one
    const b = fx.userIds[1];
    await submitAt(b, [run(t0, { external_id: 'b-manual', is_manual: true })], now);
    await submitAt(b, [run(t0, { source: 'strava', external_id: 'b-real' })], now);
    expect((await verdicts(b)).map((r) => r.verdict)).toEqual(['rejected_manual', 'accepted']);
  });

  it('is idempotent per (user, source, external_id); a changed hash updates steps samples only', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const now = at(W1_OPEN, 24 * 60);
    const r1 = run(at(W1_OPEN, 7 * 60), { external_id: 'x', raw_hash: 'h1' });
    expect(await submitAt(a, [r1], now)).toBe(1);
    expect(await submitAt(a, [r1], now)).toBe(0);
    expect(await submitAt(a, [{ ...r1, device: 'other phone' }], now)).toBe(0); // same hash: no-op whatever else changed
    expect(await code(submitAt(a, [{ ...r1, raw_hash: 'h2', distance_m: 9999 }], now))).toBe('23514');
    expect(await scalar(db, `select distance_m from public.activities where external_id = 'x'`)).toBe(5000);
    // steps samples grow during the day
    const s1 = run(W1_OPEN, { external_id: 'steps-2030-01-07', activity_type: 'steps', distance_m: null, steps: 4000, duration_s: 43200, ended_at: at(W1_OPEN, 12 * 60), raw_hash: 's1' });
    expect(await submitAt(a, [s1], now)).toBe(1);
    expect(await submitAt(a, [{ ...s1, steps: 10500, ended_at: at(W1_OPEN, 20 * 60), raw_hash: 's2' }], now)).toBe(1);
    expect(await rows(db, `select steps, raw_hash, verdict::text from public.activities where external_id = 'steps-2030-01-07'`)).toEqual([{ steps: 10500, raw_hash: 's2', verdict: 'accepted' }]);
    expect(await scalar<number>(db, `select count(*)::int from public.activities where user_id = $1`, [a])).toBe(2);
  });

  it('validates every item (22023) and writes nothing when one item is bad', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const now = at(W1_OPEN, 24 * 60);
    const good = run(at(W1_OPEN, 7 * 60), { external_id: 'good' });
    const bad = async (item: any) => code(submitAt(a, [good, item], now));
    expect(await bad({ ...run(W1_OPEN), started_at: null })).toBe('22023');
    expect(await bad({ ...run(W1_OPEN), ended_at: W1_OPEN })).toBe('22023'); // must end after it starts
    expect(await bad({ ...run(W1_OPEN), source: 'garmin' })).toBe('22023');
    expect(await bad({ ...run(W1_OPEN), external_id: '' })).toBe('22023');
    expect(await bad({ ...run(W1_OPEN), distance_m: -5 })).toBe('22023');
    expect(await bad({ ...run(W1_OPEN), duration_s: -1 })).toBe('22023');
    expect(await bad({ ...run(W1_OPEN), activity_type: 'steps', steps: null })).toBe('22023');
    expect(await bad('not an object')).toBe('22023');
    expect(await code(scalar(db, `select public.submit_activities_at($1, '{"a":1}'::jsonb, now())`, [a]))).toBe('22023');
    expect(await scalar<number>(db, `select count(*)::int from public.activities`)).toBe(0);
    expect(await submitAt(a, [], now)).toBe(0);
  });

  it('client RPC runs as the caller; the service RPC takes a user; own rows and shared pact rows are readable, nothing else', async () => {
    const fx = await weeklyFixture();
    const [a, b] = fx.userIds;
    const t = at(W1_OPEN, 7 * 60);
    // the client and service RPCs judge against the wall clock, so their sample runs are in the past
    const past = '2026-01-05T15:00:00Z';
    await asUser(db, a, (d) => d.query(`select public.submit_activities($1::jsonb)`, [JSON.stringify([run(past, { external_id: 'mine' })])]));
    expect(await rows(db, `select user_id, verdict::text from public.activities`)).toEqual([{ user_id: a, verdict: 'accepted' }]);
    await asService(db, (d) => d.query(`select public.submit_activities_for($1, $2::jsonb)`, [b, JSON.stringify([run(past, { external_id: 'svc-b', source: 'strava' })])]));
    expect(await scalar(db, `select user_id from public.activities where external_id = 'svc-b'`)).toBe(b);
    await db.query(`delete from public.activities`);
    await submitAt(a, [run(t, { external_id: 'mine' })], t);
    await submitAt(b, [run(t, { external_id: 'strava-b', source: 'strava' })], t);
    // authenticated cannot act for someone else
    await asUser(db, a, (d) => expectError(d.query(`select public.submit_activities_for($1, '[]'::jsonb)`, [b]), /permission denied/i));
    await asAnon(db, (d) => expectError(d.query(`select public.submit_activities('[]'::jsonb)`)));
    // b also has a run outside any shared window (last year)
    await submitAt(b, [run('2029-06-01T15:00:00Z', { external_id: 'old' })], t);
    // own rows, plus a's run of the shared week
    expect((await asUser(db, b, (d) => rows<{ external_id: string }>(d, `select external_id from public.activities order by external_id`))).map((r) => r.external_id)).toEqual(['mine', 'old', 'strava-b']);
    // a sees b's run of this week through the pact, not the old one
    expect((await asUser(db, a, (d) => rows<{ external_id: string }>(d, `select external_id from public.activities where user_id = $1`, [b]))).map((r) => r.external_id)).toEqual(['strava-b']);
    const shared = await asUser(db, a, (d) => rows<{ user_id: string; external_id: string }>(d, `select pa.user_id, ac.external_id from public.pact_activities pa join public.activities ac on ac.id = pa.activity_id where pa.pact_id = $1 order by 2`, [fx.pactId]));
    expect(shared.map((r) => r.user_id).sort()).toEqual([a, b].sort());
    // an outsider in another group sees nothing
    const other = await createGroupFixture(db, { members: 1, pact: false });
    await asUser(db, other.ownerId, async (d) => {
      expect(await rows(d, `select 1 from public.activities`)).toEqual([]);
      expect(await rows(d, `select 1 from public.pact_activities`)).toEqual([]);
      expect(await rows(d, `select 1 from public.instance_progress`)).toEqual([]);
      expect(await rows(d, `select 1 from public.instance_standings`)).toEqual([]);
    });
    await asAnon(db, async (d) => {
      for (const t of ['activities', 'pact_activities', 'instance_progress', 'instance_standings', 'custom_completions']) {
        await expectError(d.query(`select 1 from public.${t}`), /permission denied/i);
      }
    });
    // clients never write activities directly
    await asUser(db, a, (d) => expectError(d.query(`update public.activities set verdict = 'accepted'`), /permission denied/i));
    await asUser(db, a, (d) => expectError(d.query(`delete from public.activities`), /permission denied/i));
  });
});

// =============================================================================================
describe('progress and standings', () => {
  it('sums accepted activities of the allowed types inside the window; reached_at is the crossing activity\'s end', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    const now = at(W1_DEADLINE, -60);
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [
      run(d1, { external_id: 'a1', distance_m: 10000 }),
      run(at(d1, 24 * 60), { external_id: 'a2', distance_m: 10000, activity_type: 'walking' }), // not an allowed type
      run(at(d1, 48 * 60), { external_id: 'a3', distance_m: 10000 }),
      run(at(d1, 72 * 60), { external_id: 'a4', distance_m: 5000, ended_at: at(d1, 72 * 60 + 25) }), // crosses 24140 here
      run(at(d1, 96 * 60), { external_id: 'a5', distance_m: 3000 }),
      run(at(W1_OPEN, -30), { external_id: 'a0', distance_m: 10000 }), // last week
      run(W1_DEADLINE, { external_id: 'a6', distance_m: 10000 }), // next week (deadline is exclusive)
    ], now);
    await submitAt(b, [run(d1, { external_id: 'b1', distance_m: 8000 })], now);
    const p = await progressOf(fx.inst);
    expect(p).toHaveLength(3);
    expect(p.find((r) => r.user_id === a)).toMatchObject({ value: '28000', goal: '24140', activity_count: 4 });
    expect(p.find((r) => r.user_id === a)!.reached_at!.toISOString()).toBe(at(d1, 72 * 60 + 25));
    expect(p.find((r) => r.user_id === b)).toMatchObject({ value: '8000', activity_count: 1, reached_at: null });
    expect(p.find((r) => r.user_id === c)).toMatchObject({ value: '0', activity_count: 0, reached_at: null });
    const s = await rows<{ user_id: string; rank: number; value: string }>(db, `select user_id, rank, value::text from public.instance_standings where instance_id = $1 order by rank`, [fx.inst]);
    expect(s.map((r) => [r.user_id, r.rank, r.value])).toEqual([[a, 1, '28000'], [b, 2, '8000'], [c, 3, '0']]);
    // standings: two people over the goal rank by reached_at
    await submitAt(c, [run(at(d1, 10), { external_id: 'c1', distance_m: 30000, duration_s: 5400, ended_at: at(d1, 100) })], now);
    const s2 = await rows<{ user_id: string; rank: number }>(db, `select user_id, rank from public.instance_standings where instance_id = $1 order by rank`, [fx.inst]);
    expect(s2.map((r) => r.user_id)).toEqual([c, a, b]);
  });

  it('workouts count only activities of at least 10 minutes', async () => {
    const fx = await goalFixture({ kind: 'workouts', period: 'weekly', goal: 3, types: ['strength', 'yoga', 'running'] });
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    await tick(W1_OPEN);
    const [a] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [
      run(d1, { external_id: 'w1', activity_type: 'strength', distance_m: null, duration_s: 1800 }),
      run(at(d1, 60), { external_id: 'w2', activity_type: 'yoga', distance_m: null, duration_s: 599, ended_at: at(d1, 70) }), // too short
      run(at(d1, 120), { external_id: 'w3', activity_type: 'running', duration_s: 600, ended_at: at(d1, 130) }),
      run(at(d1, 240), { external_id: 'w4', activity_type: 'cycling', duration_s: 3600 }), // not allowed here
      run(at(d1, 300), { external_id: 'w5', activity_type: 'strength', distance_m: null, duration_s: 1200, ended_at: at(d1, 320) }),
    ], at(d1, 400));
    const p = await progressOf(inst);
    const mine = p.find((r) => r.user_id === a)!;
    expect(mine).toMatchObject({ value: '3', goal: '3', activity_count: 3 });
    expect(mine.reached_at!.toISOString()).toBe(at(d1, 320));
  });

  it('Sunday 23:30 local counts for the week that ends at midnight; Monday 00:10 local counts for the next', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    await gen(W1_OPEN);
    const next = await instanceOf(fx.pactId, '2030-01-14');
    await submitAt(a, [
      run('2030-01-14T07:30:00Z', { external_id: 'sun-late', ended_at: '2030-01-14T07:55:00Z' }), // Sun 23:30 PST
      run('2030-01-14T08:10:00Z', { external_id: 'mon-early' }), // Mon 00:10 PST
    ], '2030-01-14T09:00:00Z');
    expect((await progressOf(fx.inst)).find((r) => r.user_id === a)).toMatchObject({ value: '5000', activity_count: 1 });
    expect((await progressOf(next)).find((r) => r.user_id === a)).toMatchObject({ value: '5000', activity_count: 1 });
  });
});

// =============================================================================================
describe('results and money for goal kinds', () => {
  it('at the Monday-midnight close: success when value >= goal (first_success_at = reached_at), failed otherwise, never unverified; payout as for show_up', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 200));
    await submitAt(b, [run(d1, { external_id: 'b1', distance_m: 20000, ended_at: at(d1, 120) })], at(d1, 200));
    // nobody has synced c (no evidence at all) -> failed, not unverified
    await tick(W1_DEADLINE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [fx.inst])).toBe('closed');
    const r = await resultsOf(fx.inst);
    expect(r[a]).toEqual({ status: 'success', first: at(d1, 150) });
    expect(r[b]).toEqual({ status: 'failed', first: null });
    expect(r[c]).toEqual({ status: 'failed', first: null });
    expect(await netsOf(fx.inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });
    expect(await scalar<number>(db, `select coalesce(sum(amount_cents), 0)::int from public.ledger_lines`)).toBe(0);
    const pushes = await rows<{ user_id: string; status: string; net: number }>(
      db,
      `select user_id, payload->>'status' status, (payload->>'net_cents')::int net from public.notification_outbox where kind = 'result' order by user_id`,
    );
    expect(pushes).toHaveLength(3);
    expect(pushes.find((p) => p.user_id === a)).toMatchObject({ status: 'success', net: 1000 });
    // a success can be challenged like any other
    const rev = await asUser(db, b, (d) => scalar<string>(d, `select public.open_review($1, $2, 'challenge', 'treadmill at 2 am?', null)`, [fx.inst, a]));
    expect(rev).toBeTruthy();
  });

  it('frozen and void still apply (one freeze per calendar month for weekly pacts)', async () => {
    const fx = await goalFixture({ kind: 'distance', period: 'weekly' }, 2);
    const [a, b] = fx.userIds;
    await gen(GEN_NOW);
    const w1 = await instanceOf(fx.pactId, '2030-01-07');
    // later weeks, inserted directly so the freeze rule can be checked across months
    const mk = (date: string, open: string, deadline: string) =>
      scalar<string>(db, `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at) values ($1, $2, $3, $4) returning id`, [fx.pactId, date, open, deadline]);
    const w2 = await mk('2030-01-14', '2030-01-14T08:00:00Z', '2030-01-21T08:00:00Z');
    const w3 = await mk('2030-01-21', '2030-01-21T08:00:00Z', '2030-01-28T08:00:00Z');
    const feb = await mk('2030-02-04', '2030-02-04T08:00:00Z', '2030-02-11T08:00:00Z');
    const freeze = (u: string, inst: string, now: string) => db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [u, inst, now]);
    await freeze(b, w2, '2030-01-10T12:00:00Z');
    expect(await scalar(db, `select iso_week from public.freezes where instance_id = $1`, [w2])).toBe('2030-01');
    expect(await code(freeze(b, w3, '2030-01-12T12:00:00Z'))).toBe('23514'); // same month
    await freeze(b, feb, '2030-01-12T12:00:00Z'); // another month
    expect(await code(freeze(a, w2, '2030-01-14T09:00:00Z'))).toBe('23514'); // after the window opened
    // week 1: a freezes before it opens; b alone is one active -> void, no money
    await freeze(a, w1, '2030-01-06T20:00:00Z');
    await tick(W1_OPEN);
    await submitAt(b, [run(at(W1_OPEN, 60), { external_id: 'b1', distance_m: 30000, ended_at: at(W1_OPEN, 230) })], at(W1_OPEN, 240));
    await tick(W1_DEADLINE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [w1])).toBe('voided');
    const r = await resultsOf(w1);
    expect(r[a].status).toBe('frozen');
    expect(r[b].status).toBe('void');
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_lines`)).toBe(0);
  });

  it('late evidence: activities started inside the window that arrive within 24 h recompute the result with a correction; later ones are shown but move no money', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, ended_at: at(d1, 150) })], at(d1, 160));
    await submitAt(b, [run(d1, { external_id: 'b1', distance_m: 10000, ended_at: at(d1, 60) })], at(d1, 160));
    await tick(W1_DEADLINE);
    expect((await resultsOf(fx.inst))[b].status).toBe('failed');
    expect(await netsOf(fx.inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });

    // b's watch syncs Monday 02:00: a Sunday run of 15 km started before the deadline
    const sunday = at(W1_DEADLINE, -5 * 60);
    expect(await submitAt(b, [run(sunday, { external_id: 'b-sunday', distance_m: 15000, duration_s: 5400, ended_at: at(sunday, 90) })], at(W1_DEADLINE, 120))).toBe(1);
    const r = await resultsOf(fx.inst);
    expect(r[b]).toEqual({ status: 'success', first: at(sunday, 90) });
    expect(await netsOf(fx.inst)).toEqual({ [a]: 250, [b]: 250, [c]: -500 });
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction' and instance_id = $1`, [fx.inst])).toBe(1);
    expect(await scalar<number>(db, `select coalesce(sum(amount_cents), 0)::int from public.ledger_lines`)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'result' and payload ? 'correction'`)).toBeGreaterThan(0);

    // c syncs 25 hours late: the run is recorded and visible, the result and the ledger do not move
    const cRun = run(at(d1, 24 * 60), { external_id: 'c-late', distance_m: 30000, ended_at: at(d1, 24 * 60 + 170) });
    expect(await submitAt(c, [cRun], at(W1_DEADLINE, 25 * 60))).toBe(1);
    expect(await scalar(db, `select verdict::text from public.activities where external_id = 'c-late'`)).toBe('accepted');
    expect(await scalar<number>(db, `select count(*)::int from public.pact_activities where user_id = $1`, [c])).toBe(1);
    expect((await resultsOf(fx.inst))[c].status).toBe('failed');
    expect(await netsOf(fx.inst)).toEqual({ [a]: 250, [b]: 250, [c]: -500 });
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction'`)).toBe(1);
    // the view shows the late run's distance while the result stands
    expect((await progressOf(fx.inst)).find((p) => p.user_id === c)).toMatchObject({ value: '30000' });

    // a re-run of the same sync changes nothing (idempotent)
    await submitAt(b, [run(sunday, { external_id: 'b-sunday', distance_m: 15000, duration_s: 5400, ended_at: at(sunday, 90) })], at(W1_DEADLINE, 130));
    expect(await scalar<number>(db, `select count(*)::int from public.ledger_entries`)).toBe(3);
  });

  it('backdated evidence after the 24 h window never changes a settled week either', async () => {
    const fx = await weeklyFixture();
    const [a, b] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, ended_at: at(d1, 150) })], at(d1, 160));
    await tick(W1_DEADLINE);
    // Monday noon local: settlement bills the week that ended at midnight (the group was created at
    // the wall clock, so earlier empty weeks are settled on the way)
    await db.query(`select public.settle_due_groups($1::timestamptz)`, [at(W1_DEADLINE, 12 * 60)]);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [fx.inst])).toBe('settled');
    expect(await scalar<number>(db, `select count(*)::int from public.obligations where status = 'pending'`)).toBe(2);
    const before = await netsOf(fx.inst);
    await submitAt(b, [run(d1, { external_id: 'b-backdated', distance_m: 40000, ended_at: at(d1, 240) })], at(W1_DEADLINE, 30 * 60));
    expect(await netsOf(fx.inst)).toEqual(before);
    expect((await resultsOf(fx.inst))[b].status).toBe('failed');
  });

  it('leaving the group mid-week is allowed for a weekly pact and the leaver is still scored', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    await submitAt(a, [run(at(W1_OPEN, 60), { external_id: 'a1', distance_m: 25000, ended_at: at(W1_OPEN, 200) })], at(W1_OPEN, 210));
    await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId])); // not refused although the week is open
    expect(await scalar(db, `select left_at is not null from public.pact_participants where pact_id = $1 and user_id = $2`, [fx.pactId, c])).toBe(true);
    // (the wall clock is 2026; place the departure mid-week 2030 where the scenario lives)
    await db.query(`update public.pact_participants set left_at = '2030-01-09T20:00:00Z' where pact_id = $1 and user_id = $2`, [fx.pactId, c]);
    await tick(W1_DEADLINE);
    const r = await resultsOf(fx.inst);
    expect(r[c].status).toBe('failed');
    expect(r[b].status).toBe('failed');
    expect(await netsOf(fx.inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });
  });

  it('steps: a daily step total counts; a hand-entered step sample does not', async () => {
    const fx = await goalFixture({ kind: 'steps', period: 'daily', days: [1, 2, 3, 4, 5, 6, 7], goal: 10000 }, 2);
    const [a, b] = fx.userIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    const r0 = await rows<{ o: Date; d: Date }>(db, `select window_open_at o, deadline_at d from public.pact_instances where id = $1`, [inst]);
    expect(r0[0].o.toISOString()).toBe(W1_OPEN);
    expect(r0[0].d.toISOString()).toBe('2030-01-08T07:59:00.000Z');
    await tick(W1_OPEN);
    const sample = (o: Partial<Act>): Act => run(W1_OPEN, { activity_type: 'steps', distance_m: null, duration_s: 43200, ended_at: at(W1_OPEN, 12 * 60), ...o });
    await submitAt(a, [sample({ external_id: 'a-steps', steps: 6000, raw_hash: '1' })], at(W1_OPEN, 12 * 60));
    expect((await progressOf(inst)).find((p) => p.user_id === a)).toMatchObject({ value: '6000', goal: '10000' });
    await submitAt(a, [sample({ external_id: 'a-steps', steps: 10500, raw_hash: '2', ended_at: at(W1_OPEN, 20 * 60) })], at(W1_OPEN, 20 * 60));
    await submitAt(b, [sample({ external_id: 'b-steps', steps: 12000, is_manual: true })], at(W1_OPEN, 20 * 60));
    expect((await verdicts(b))[0].verdict).toBe('rejected_manual');
    await tick('2030-01-08T07:59:00Z');
    const r = await resultsOf(inst);
    expect(r[a]).toEqual({ status: 'success', first: at(W1_OPEN, 20 * 60) });
    expect(r[b].status).toBe('failed');
    expect(await netsOf(inst)).toEqual({ [a]: 500, [b]: -500 });
  });

  it('custom: mark_done before the deadline is a success (challengeable); after it, or on another kind, is refused', async () => {
    const fx = await goalFixture({ kind: 'custom', period: 'daily', days: [1, 2, 3, 4, 5], windowOpen: '08:00', deadline: '09:00', title: 'Read 20 pages' }, 3);
    const [a, b, c] = fx.userIds;
    await gen(GEN_NOW);
    const inst = await instanceOf(fx.pactId, '2030-01-07');
    const open = '2030-01-07T16:00:00Z';
    const deadline = '2030-01-07T17:00:00Z';
    const mark = (u: string, now: string, photo: string | null = null) =>
      db.query(`select public.mark_done_at($1, $2, $3, $4::timestamptz)`, [u, inst, photo, now]);
    expect(await code(mark(a, at(open, -5)))).toBe('23514'); // not open yet
    await tick(open);
    await mark(a, at(open, 30), 'review-photos/a.jpg');
    await mark(a, at(open, 31)); // repeat: idempotent, keeps the first time
    expect(await rows(db, `select to_char(marked_at at time zone 'UTC', 'HH24:MI') m, photo_path from public.custom_completions where instance_id = $1`, [inst]))
      .toEqual([{ m: '16:30', photo_path: 'review-photos/a.jpg' }]);
    const outsider = await createUser(db);
    expect(await code(mark(outsider, at(open, 40)))).toBe('42501');
    await asUser(db, b, (d) => d.query(`select public.mark_done($1, null)`, [inst]).catch(() => undefined)); // wall clock is outside 2030: refused, nothing stored
    expect(await scalar<number>(db, `select count(*)::int from public.custom_completions where user_id = $1`, [b])).toBe(0);
    await tick(deadline);
    expect(await code(mark(b, at(deadline, 1)))).toBe('23514');
    const r = await resultsOf(inst);
    expect(r[a]).toEqual({ status: 'success', first: at(open, 30) });
    expect(r[b].status).toBe('failed');
    expect(r[c].status).toBe('failed');
    expect(await netsOf(inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });
    expect(await asUser(db, b, (d) => scalar<string>(d, `select public.open_review($1, $2, 'challenge', 'no photo of the pages', null)`, [inst, a]))).toBeTruthy();
    // mark_done on a distance pact
    const distance = await goalFixture({ kind: 'distance', period: 'weekly' }, 2);
    await gen(GEN_NOW);
    const dInst = await instanceOf(distance.pactId, '2030-01-07');
    await tick(W1_OPEN);
    expect(await code(db.query(`select public.mark_done_at($1, $2, null, $3::timestamptz)`, [distance.userIds[0], dInst, at(W1_OPEN, 60)]))).toBe('23514');
    // members can read completions, outsiders cannot
    expect(await asUser(db, c, (d) => scalar<number>(d, `select count(*)::int from public.custom_completions where instance_id = $1`, [inst]))).toBe(1);
    expect(await asUser(db, outsider, (d) => scalar<number>(d, `select count(*)::int from public.custom_completions`))).toBe(0);
  });
});

// =============================================================================================
describe('notifications for weekly pacts', () => {
  it('no window_open push at Monday midnight; deadline_soon at Sunday 18:00 local to those short of the goal; result at close', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'window_open'`)).toBe(0);
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, ended_at: at(d1, 150) })], at(d1, 160));
    await submitAt(b, [run(d1, { external_id: 'b1', distance_m: 20000, ended_at: at(d1, 120) })], at(d1, 160));
    await tick(W1_SUNDAY_1759);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'deadline_soon'`)).toBe(0);
    await tick(W1_SUNDAY_1800);
    const soon = await rows<{ user_id: string; minutes_left: number; kind: string; period: string }>(
      db,
      `select user_id, (payload->>'minutes_left')::int minutes_left, payload->>'kind' kind, payload->>'period' period
         from public.notification_outbox where kind = 'deadline_soon' order by user_id`,
    );
    expect(soon.map((s) => s.user_id).sort()).toEqual([b, c].sort());
    expect(soon[0]).toMatchObject({ minutes_left: 360, kind: 'distance', period: 'weekly' });
    await tick(at(W1_SUNDAY_1800, 60)); // only once
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'deadline_soon'`)).toBe(2);
    await tick(at(W1_DEADLINE, -10)); // the 15-minute rule of daily pacts does not fire a second time
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'deadline_soon'`)).toBe(2);
    await tick(W1_DEADLINE);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'result'`)).toBe(3);
    expect(await scalar<number>(db, `select count(*)::int from public.notification_outbox where kind = 'window_open'`)).toBe(0);
  });
});

// =============================================================================================
describe('privileges', () => {
  it('new client RPCs are authenticated-only; cores and the service RPC are not client-callable', async () => {
    const fns = await rows<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
      db,
      `select p.proname name, has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') auth,
              has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('submit_activities', 'mark_done', 'submit_activities_for', 'submit_activities_at', 'mark_done_at')`,
    );
    const by = Object.fromEntries(fns.map((f) => [f.name, f]));
    expect(by.submit_activities).toMatchObject({ anon: false, auth: true });
    expect(by.mark_done).toMatchObject({ anon: false, auth: true });
    expect(by.submit_activities_for).toMatchObject({ anon: false, auth: false, svc: true });
    expect(by.submit_activities_at).toMatchObject({ anon: false, auth: false });
    expect(by.mark_done_at).toMatchObject({ anon: false, auth: false });
    const defs = await rows<{ name: string; secdef: boolean }>(
      db,
      `select p.proname name, p.prosecdef secdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('submit_activities', 'mark_done', 'submit_activities_for', 'create_pact', 'join_pact')
          and not (coalesce(p.proconfig, '{}') @> array['search_path=pg_catalog, public, pg_temp'])`,
    );
    expect(defs).toEqual([]);
  });
});
