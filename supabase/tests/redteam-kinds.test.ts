// Red team for challenge kinds (day 2): who can dodge a forfeit, take the pool, or be charged unfairly
// on distance / workouts / steps / custom pacts. One test per suspicion; the ones marked "fixed" failed
// against 20261109000100..300 and pass with 20261109000400_kinds_fixes.sql; the rest are regressions
// of behaviour that was already safe. Attack table: docs/REDTEAM.md "Challenge kinds (day 2)".
//
// Clock: most scenarios live in January 2030 (America/Los_Angeles, PST) like challenge-kinds.test.ts.
// leave_group / join_group / join_pact use the wall clock, so the roster attacks build an instance
// around now() instead.
import { beforeEach, describe, expect, it } from 'vitest';
import { asUser, createDb, createGroupFixture, expectError, rows, scalar, type DB, type GroupFixture } from './helpers/db';

const TZ = 'America/Los_Angeles';
const GEN_NOW = '2030-01-06T12:00:00Z';
const W1_OPEN = '2030-01-07T08:00:00.000Z';
const W1_DEADLINE = '2030-01-14T08:00:00.000Z';
const GOAL_M = 24140;
const at = (iso: string, deltaMin: number) => new Date(Date.parse(iso) + deltaMin * 60_000).toISOString();
const code = async (p: Promise<unknown>) => (await expectError(p)).code;

type Act = {
  source: 'healthkit' | 'strava' | 'manual';
  external_id: string;
  activity_type: string;
  started_at: string;
  ended_at: string;
  distance_m: number | null;
  duration_s: number | null;
  steps: number | null;
  device: string | null;
  app_bundle: string | null;
  is_manual: boolean;
  raw_hash: string | null;
};
let seq = 0;
function run(start: string, o: Partial<Act> = {}): Act {
  const startedAt = new Date(start).toISOString();
  return {
    source: 'healthkit',
    external_id: `hk-${++seq}`,
    activity_type: 'running',
    started_at: startedAt,
    ended_at: at(startedAt, 30),
    distance_m: 5000,
    duration_s: 1800,
    steps: null,
    device: 'Apple Watch',
    app_bundle: 'com.apple.Fitness',
    is_manual: false,
    raw_hash: null,
    ...o,
  };
}
const stepsSample = (dayOpenIso: string, o: Partial<Act>): Act =>
  run(dayOpenIso, { activity_type: 'steps', distance_m: null, duration_s: 43200, ended_at: at(dayOpenIso, 12 * 60), ...o });

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
const verdictOf = (ext: string) =>
  rows<{ verdict: string; reject_reason: string | null }>(db, `select verdict::text, reject_reason from public.activities where external_id = $1`, [ext]).then((r) => r[0]);
const resultsOf = async (inst: string) =>
  Object.fromEntries(
    (await rows<{ user_id: string; status: string; first_success_at: Date | null }>(db, `select user_id, status::text, first_success_at from public.results where instance_id = $1`, [inst])).map(
      (r) => [r.user_id, { status: r.status, first: r.first_success_at?.toISOString() ?? null }],
    ),
  );
const netsOf = async (inst: string) =>
  Object.fromEntries(
    (
      await rows<{ user_id: string; net: number }>(
        db,
        `select a.user_id, sum(l.amount_cents)::int as net
           from public.ledger_lines l join public.ledger_entries e on e.id = l.entry_id join public.ledger_accounts a on a.id = l.account_id
          where e.instance_id = $1 and a.kind = 'member' group by a.user_id`,
        [inst],
      )
    ).map((r) => [r.user_id, r.net]),
  );
const progressOf = async (inst: string, user: string) =>
  (await rows<{ value: string; activity_count: number }>(db, `select value::text, activity_count from public.instance_progress where instance_id = $1 and user_id = $2`, [inst, user]))[0];
const corrections = () => scalar<number>(db, `select count(*)::int from public.ledger_entries where kind = 'correction'`);
const zeroSum = async () => expect(await scalar<number>(db, `select coalesce(sum(amount_cents), 0)::int from public.ledger_lines`)).toBe(0);

type Fx = GroupFixture & { pactId: string };
interface GoalPact {
  kind: 'distance' | 'workouts' | 'steps' | 'custom';
  period: 'daily' | 'weekly' | 'once';
  goal?: number | null;
  types?: string[] | null;
  days?: number[] | null;
  deadline?: string | null;
  windowOpen?: string | null;
  title?: string;
}
async function createGoalPact(fx: GroupFixture, p: GoalPact): Promise<string> {
  const unit = p.kind === 'distance' ? 'm' : p.kind === 'workouts' ? 'count' : p.kind === 'steps' ? 'steps' : null;
  const goal = p.goal === undefined ? (p.kind === 'distance' ? GOAL_M : p.kind === 'workouts' ? 3 : p.kind === 'steps' ? 10000 : null) : p.goal;
  return asUser(db, fx.ownerId, (d) =>
    scalar<string>(
      d,
      `select public.create_pact($1, $2, $3::smallint[], $4::time, $5::time, 500, $6, $7::public.pact_kind, $8::public.pact_period, $9::numeric, $10, $11::text[], null, null)`,
      [fx.groupId, p.title ?? `${p.kind} ${p.period}`, p.days ?? null, p.windowOpen ?? null, p.deadline ?? null, TZ, p.kind, p.period, goal, unit,
        p.types === undefined ? (p.kind === 'distance' || p.kind === 'workouts' ? ['running'] : null) : p.types],
    ),
  );
}
/** Everyone joins; joins backdated so they are on every 2030 roster. */
async function goalFixture(p: GoalPact, members = 3): Promise<Fx> {
  const fx = await createGroupFixture(db, { members, pact: false, tz: TZ });
  const pactId = await createGoalPact(fx, p);
  for (const u of fx.userIds) await asUser(db, u, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [pactId]));
  await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pactId]);
  return { ...fx, pactId, participantIds: fx.userIds };
}
async function weeklyFixture(members = 3, p: Partial<GoalPact> = {}): Promise<Fx & { inst: string }> {
  const fx = await goalFixture({ kind: 'distance', period: 'weekly', ...p }, members);
  await gen(GEN_NOW);
  const inst = await instanceOf(fx.pactId, '2030-01-07');
  await tick(W1_OPEN);
  return { ...fx, inst };
}
/** An instance of a weekly / once pact that is open right now on the wall clock (for leave / join attacks). */
async function openNowInstance(pactId: string, hoursAgo = 48, hoursLeft = 120): Promise<{ inst: string; open: string; deadline: string }> {
  const now = Date.now();
  const open = new Date(now - hoursAgo * 3_600_000).toISOString();
  const deadline = new Date(now + hoursLeft * 3_600_000).toISOString();
  const inst = await scalar<string>(
    db,
    `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status) values ($1, $2::date, $3, $4, 'open') returning id`,
    [pactId, open.slice(0, 10), open, deadline],
  );
  return { inst, open, deadline };
}

// =============================================================================================
describe('roster: leaving and rejoining', () => {
  it('RK-1 (fixed): leaving the group mid-week and rejoining at once no longer drops you from the open week', async () => {
    const fx = await goalFixture({ kind: 'distance', period: 'weekly' }, 3);
    const [a, b, c] = fx.userIds;
    const { inst, open, deadline } = await openNowInstance(fx.pactId);
    await submitAt(a, [run(at(open, 60), { distance_m: 25000, duration_s: 9000, ended_at: at(open, 210) })], at(open, 240));
    // c is short and wants out of the forfeit: leave the group, rejoin with the invite code, rejoin the pact
    await asUser(db, c, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    await asUser(db, c, (d) => d.query(`select public.join_group($1)`, [fx.inviteCode]));
    await asUser(db, c, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [fx.pactId]));
    const roster = await rows<{ u: string }>(db, `select u from public._instance_participants($1) u`, [inst]);
    expect(roster.map((r) => r.u).sort()).toEqual([a, b, c].sort());
    await tick(deadline);
    const r = await resultsOf(inst);
    expect(r[c]?.status).toBe('failed');
    expect(await netsOf(inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });
    await zeroSum();
    // a rejoin after a real absence (left before this week opened) is a fresh join: next week's roster
    const fx2 = await goalFixture({ kind: 'distance', period: 'weekly' }, 3);
    const z = fx2.userIds[2];
    await asUser(db, z, (d) => d.query(`select public.leave_group($1)`, [fx2.groupId]));
    await db.query(`update public.pact_participants set left_at = now() - interval '2 hours' where pact_id = $1 and user_id = $2`, [fx2.pactId, z]);
    const later = await openNowInstance(fx2.pactId, 1, 100); // opened after z left
    await asUser(db, z, (d) => d.query(`select public.join_group($1)`, [fx2.inviteCode]));
    await asUser(db, z, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [fx2.pactId]));
    const roster2 = await rows<{ u: string }>(db, `select u from public._instance_participants($1) u`, [later.inst]);
    expect(roster2.map((r) => r.u)).not.toContain(z);
  });

  it('RK-9 (fixed): a member of a daily steps pact can leave the group during the day and is still scored for it', async () => {
    const fx = await goalFixture({ kind: 'steps', period: 'daily', days: [1, 2, 3, 4, 5, 6, 7] }, 2);
    const [a, b] = fx.userIds;
    const { inst, open, deadline } = await openNowInstance(fx.pactId, 6, 10);
    await submitAt(a, [stepsSample(open, { steps: 12000, ended_at: at(open, 5 * 60) })], at(open, 5 * 60));
    // used to be 23514 all day long (a steps day is open from 00:00 to 23:59, so nobody could ever leave)
    await asUser(db, b, (d) => d.query(`select public.leave_group($1)`, [fx.groupId]));
    await tick(deadline);
    const r = await resultsOf(inst);
    expect(r[b]?.status).toBe('failed');
    expect(await netsOf(inst)).toEqual({ [a]: 500, [b]: -500 });
    // show_up keeps the refusal: the window is an hour and the roster rule alone is not the only guard
    const su = await createGroupFixture(db, { members: 2 });
    await db.query(`update public.pact_participants set joined_at = now() - interval '1 day' where pact_id = $1`, [su.pactId]);
    const nowOpen = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
       values ($1, current_date, now() - interval '10 minutes', now() + interval '50 minutes', 'open') returning id`,
      [su.pactId],
    );
    expect(nowOpen).toBeTruthy();
    expect(await code(asUser(db, su.userIds[1], (d) => d.query(`select public.leave_group($1)`, [su.groupId])))).toBe('23514');
  });

  it('RK-10 (safe): joining a goal pact while the week is open puts you on the next roster, not this one', async () => {
    const fx = await createGroupFixture(db, { members: 3, pact: false, tz: TZ });
    const pactId = await createGoalPact(fx, { kind: 'distance', period: 'weekly' });
    const [a, b, c] = fx.userIds;
    for (const u of [a, b]) await asUser(db, u, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [pactId]));
    await db.query(`update public.pact_participants set joined_at = '2020-01-01Z' where pact_id = $1`, [pactId]);
    const { inst, open, deadline } = await openNowInstance(pactId);
    await submitAt(c, [run(at(open, 60), { distance_m: 30000, duration_s: 9000, ended_at: at(open, 210) })], at(open, 240));
    await asUser(db, c, (d) => d.query(`select public.join_pact($1, null, null, null, null)`, [pactId])); // joins with 30 km already run
    await submitAt(a, [run(at(open, 300), { distance_m: 25000, duration_s: 9000, ended_at: at(open, 450) })], at(open, 460));
    await tick(deadline);
    const r = await resultsOf(inst);
    expect(Object.keys(r).sort()).toEqual([a, b].sort());
    expect(await netsOf(inst)).toEqual({ [a]: 500, [b]: -500 });
  });
});

// =============================================================================================
describe('submit_activities: a modified client with any JSON', () => {
  it('RK-2 (fixed): an activity first refused as "in the future" gets the full verdict when it is re-judged (pace, duplicate)', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const now = at(W1_OPEN, 12 * 60);
    // 15 miles in 20 seconds, ending 10 minutes from now: rejected_future first, and used to come back as accepted
    const teleport = run(at(now, 9), { external_id: 'teleport', distance_m: GOAL_M, duration_s: 20, ended_at: at(now, 10), raw_hash: 't' });
    await submitAt(a, [teleport], now);
    expect((await verdictOf('teleport')).verdict).toBe('rejected_future');
    expect(await submitAt(a, [teleport], at(now, 20))).toBe(1);
    expect(await verdictOf('teleport')).toEqual({ verdict: 'rejected_type', reject_reason: 'implausible pace' });
    // a Strava copy of an accepted Health run that first ended in the future is a duplicate once re-judged
    const t0 = at(W1_OPEN, 30 * 60);
    const later = at(t0, 40);
    await submitAt(a, [run(t0, { external_id: 'hk', ended_at: at(t0, 30) })], later);
    const copy = run(at(t0, 1), { source: 'strava', external_id: 'st', ended_at: at(later, 10), raw_hash: 's' });
    await submitAt(a, [copy], later);
    expect((await verdictOf('st')).verdict).toBe('rejected_future');
    await submitAt(a, [copy], at(later, 30));
    expect((await verdictOf('st')).verdict).toBe('rejected_duplicate');
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '5000', activity_count: 1 });
  });

  it('RK-5 (fixed): the same run recorded twice by one source (watch + phone, or a HealthKit edit with a new UUID) counts once', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const t0 = at(W1_OPEN, 10 * 60);
    const now = at(W1_OPEN, 24 * 60);
    await submitAt(a, [run(t0, { external_id: 'watch', distance_m: 8000, duration_s: 2400, ended_at: at(t0, 40) })], now);
    await submitAt(a, [run(at(t0, 1), { external_id: 'phone', distance_m: 8050, duration_s: 2350, ended_at: at(t0, 40) })], now);
    expect((await verdictOf('phone')).verdict).toBe('rejected_duplicate');
    expect((await verdictOf('phone')).reject_reason).toBe('duplicate of healthkit watch');
    // edited in Fitness: same instants, a new uuid, a longer distance
    await submitAt(a, [run(t0, { external_id: 'edited-uuid', distance_m: 12000, duration_s: 2400, ended_at: at(t0, 40) })], now);
    expect((await verdictOf('edited-uuid')).verdict).toBe('rejected_duplicate');
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '8000', activity_count: 1 });
    // a real second run right after still counts
    await submitAt(a, [run(at(t0, 45), { external_id: 'second', distance_m: 5000, ended_at: at(t0, 75) })], now);
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '13000', activity_count: 2 });
    // workouts: one session on the watch and on Strava is one workout
    const w = await weeklyFixture(2, { kind: 'workouts', types: ['running', 'strength'], goal: 3 });
    const [x] = w.userIds;
    await submitAt(x, [run(t0, { external_id: 'w-strava', source: 'strava', distance_m: null, ended_at: at(t0, 45), duration_s: 2700 })], now);
    await submitAt(x, [run(at(t0, 2), { external_id: 'w-watch', distance_m: 7000, ended_at: at(t0, 44), duration_s: 2500 })], now);
    expect(await progressOf(w.inst, x)).toMatchObject({ value: '1', activity_count: 1 });
  });

  it('RK-6 (fixed): a moving time longer than the activity itself is clamped, so it cannot hide an implausible pace or pad a workout', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const now = at(W1_OPEN, 24 * 60);
    const t0 = at(W1_OPEN, 10 * 60);
    // 15 miles between 10:00 and 10:01 with "two hours of moving time"
    await submitAt(a, [run(t0, { external_id: 'padded', distance_m: GOAL_M, duration_s: 7200, ended_at: at(t0, 1) })], now);
    expect(await verdictOf('padded')).toEqual({ verdict: 'rejected_type', reject_reason: 'implausible pace' });
    // a 2-minute "workout" with duration 900 s is stored as 120 s and does not count for a workouts goal
    const w = await weeklyFixture(2, { kind: 'workouts', goal: 1 });
    const [x] = w.userIds;
    await submitAt(x, [run(t0, { external_id: 'short', distance_m: 300, duration_s: 900, ended_at: at(t0, 2) })], now);
    expect(await scalar(db, `select duration_s from public.activities where external_id = 'short'`)).toBe(120);
    expect(await progressOf(w.inst, x)).toMatchObject({ value: '0', activity_count: 0 });
    // an honest sample with a second of rounding slack is untouched
    await submitAt(x, [run(at(t0, 60), { external_id: 'honest', duration_s: 1801, ended_at: at(t0, 90) })], now);
    expect(await scalar(db, `select duration_s from public.activities where external_id = 'honest'`)).toBe(1801);
  });

  it('RK-7 (fixed): the client RPC cannot claim the Strava source, and a "manual" source is hand-entered whatever the flag says', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const past = '2026-01-05T15:00:00Z';
    const err = await expectError(asUser(db, a, (d) => d.query(`select public.submit_activities($1::jsonb)`, [JSON.stringify([run(past, { source: 'strava', external_id: 'fake-strava' })])])));
    expect(err.code).toBe('22023');
    expect(await scalar<number>(db, `select count(*)::int from public.activities`)).toBe(0);
    // Health rows still go through
    await asUser(db, a, (d) => d.query(`select public.submit_activities($1::jsonb)`, [JSON.stringify([run(past, { external_id: 'real-hk' })])]));
    expect((await verdictOf('real-hk')).verdict).toBe('accepted');
    // source 'manual' with is_manual false
    await submitAt(a, [run(at(W1_OPEN, 60), { source: 'manual', external_id: 'typed', is_manual: false, distance_m: 30000, duration_s: 9000, ended_at: at(W1_OPEN, 210) })], at(W1_OPEN, 240));
    expect(await verdictOf('typed')).toEqual({ verdict: 'rejected_manual', reject_reason: 'entered by hand' });
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '0' });
  });

  it('RK-8 (fixed): a batch is at most 1000 items', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    const big = Array.from({ length: 1001 }, (_, i) => run(at(W1_OPEN, 60 + i), { external_id: `b${i}`, ended_at: at(W1_OPEN, 61 + i), distance_m: 10, duration_s: 60 }));
    expect(await code(submitAt(a, big, at(W1_OPEN, 48 * 60)))).toBe('22023');
    expect(await scalar<number>(db, `select count(*)::int from public.activities`)).toBe(0);
    expect(await submitAt(a, big.slice(0, 1000), at(W1_OPEN, 48 * 60))).toBe(1000);
  });

  it('RK-17 (safe): a steps sample never counts toward a distance goal and a walk never counts toward a steps goal', async () => {
    const fx = await weeklyFixture(2, { kind: 'distance', types: ['running', 'walking'] });
    const [a] = fx.userIds;
    await submitAt(a, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 50000 })], at(W1_OPEN, 13 * 60));
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '0', activity_count: 0 });
    const s = await goalFixture({ kind: 'steps', period: 'daily', days: [1, 2, 3, 4, 5, 6, 7] }, 2);
    await gen(GEN_NOW);
    const day = await instanceOf(s.pactId, '2030-01-07');
    await tick(W1_OPEN);
    await submitAt(s.userIds[0], [run(at(W1_OPEN, 60), { external_id: 'walk', activity_type: 'walking', steps: 20000, distance_m: 15000, duration_s: 10800, ended_at: at(W1_OPEN, 240) })], at(W1_OPEN, 300));
    expect(await progressOf(day, s.userIds[0])).toMatchObject({ value: '0', activity_count: 0 });
  });
});

// =============================================================================================
describe('steps samples: the one row that may change', () => {
  async function stepsDay(): Promise<Fx & { d1: string; d2: string; a: string; b: string; c: string }> {
    const fx = await goalFixture({ kind: 'steps', period: 'daily', days: [1, 2, 3, 4, 5, 6, 7] }, 3);
    await gen(GEN_NOW);
    const d1 = await instanceOf(fx.pactId, '2030-01-07');
    const d2 = await instanceOf(fx.pactId, '2030-01-08');
    await tick(W1_OPEN);
    const [a, b, c] = fx.userIds;
    return { ...fx, d1, d2, a, b, c };
  }
  const D1_CLOSE = '2030-01-08T07:59:00Z';
  const D2_OPEN = '2030-01-08T08:00:00Z';

  it('RK-3 (fixed): a steps re-send cannot move a day\'s total into another day', async () => {
    const { d1, d2, a } = await stepsDay();
    await submitAt(a, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 10500, ended_at: at(W1_OPEN, 20 * 60), raw_hash: '1' })], at(W1_OPEN, 20 * 60));
    await tick(D1_CLOSE);
    expect((await resultsOf(d1))[a].status).toBe('success');
    await tick(D2_OPEN);
    // Tuesday: the same external id re-sent with Tuesday's instants
    const moved = stepsSample(D2_OPEN, { external_id: 'steps:2030-01-07', steps: 10500, ended_at: at(D2_OPEN, 20 * 60), raw_hash: '2' });
    expect(await submitAt(a, [moved], at(D2_OPEN, 20 * 60))).toBe(0);
    expect((await rows<{ s: Date }>(db, `select started_at s from public.activities where external_id = 'steps:2030-01-07'`))[0].s.toISOString()).toBe(W1_OPEN);
    expect(await progressOf(d2, a)).toMatchObject({ value: '0', activity_count: 0 });
    expect(await progressOf(d1, a)).toMatchObject({ value: '10500' });
  });

  it('RK-4 (fixed): a steps re-send after the 24 h cut-off neither erases an honest success nor inflates a miss', async () => {
    const { d1, a, b, c, groupId } = await stepsDay();
    const hash = (n: number) => `h${n}`;
    await submitAt(a, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 10500, ended_at: at(W1_OPEN, 20 * 60), raw_hash: hash(1) })], at(W1_OPEN, 20 * 60));
    await submitAt(b, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 9000, ended_at: at(W1_OPEN, 20 * 60), raw_hash: hash(1) })], at(W1_OPEN, 20 * 60));
    await tick(D1_CLOSE);
    expect((await resultsOf(d1))[a].status).toBe('success');
    expect((await resultsOf(d1))[b].status).toBe('failed');
    const before = await netsOf(d1);
    // Tuesday: c challenges a, b appeals; both reviews stay open
    await db.query(`select public.open_review_at($1, $2, $3, 'challenge', 'really?', null, $4::timestamptz)`, [c, d1, a, at(D1_CLOSE, 60)]);
    await db.query(`select public.open_review_at($1, $2, $3, 'appeal', 'watch was off', null, $4::timestamptz)`, [b, d1, b, at(D1_CLOSE, 61)]);
    // Wednesday noon (> deadline + 24 h): a's watch adds 100 late steps to Monday; b's modified client adds 1500
    const wed = at(D1_CLOSE, 28 * 60);
    expect(await submitAt(a, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 10600, ended_at: at(W1_OPEN, 23 * 60 + 59), raw_hash: hash(2) })], wed)).toBe(0);
    expect(await submitAt(b, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 10500, ended_at: at(W1_OPEN, 23 * 60 + 59), raw_hash: hash(2) })], wed)).toBe(0);
    expect(await rows(db, `select user_id, steps from public.activities where external_id = 'steps:2030-01-07' order by steps`)).toEqual([{ user_id: b, steps: 9000 }, { user_id: a, steps: 10500 }]);
    // both reviews default at settlement: the results stand
    await db.query(`select public.default_open_reviews($1, $2::timestamptz)`, [groupId, W1_DEADLINE]);
    const r = await resultsOf(d1);
    expect(r[a].status).toBe('success');
    expect(r[b].status).toBe('failed');
    expect(await netsOf(d1)).toEqual(before);
    expect(await corrections()).toBe(0);
    // within the 24 h a late total still counts (the honest late sync): c had nothing, syncs Tuesday 10:00 local
    await submitAt(c, [stepsSample(W1_OPEN, { external_id: 'steps:2030-01-07', steps: 11000, ended_at: at(W1_OPEN, 23 * 60), raw_hash: hash(1) })], at(D1_CLOSE, 10 * 60));
    expect((await resultsOf(d1))[c].status).toBe('success');
    expect(await corrections()).toBe(1);
    await zeroSum();
  });
});

// =============================================================================================
describe('money and reviews on goal kinds', () => {
  it('RK-11 (safe): evidence that changes a settled week within 24 h posts a correction and stays challengeable (D31)', async () => {
    const fx = await weeklyFixture();
    const [a, b] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 160));
    await tick(W1_DEADLINE);
    await db.query(`select public.settle_due_groups($1::timestamptz)`, [at(W1_DEADLINE, 12 * 60)]);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [fx.inst])).toBe('settled');
    // Monday 14:00: b's "Sunday run" lands
    const sunday = at(W1_DEADLINE, -3 * 60);
    await submitAt(b, [run(sunday, { external_id: 'b-late', distance_m: 25000, duration_s: 9000, ended_at: at(sunday, 150) })], at(W1_DEADLINE, 14 * 60));
    expect((await resultsOf(fx.inst))[b].status).toBe('success');
    expect(await corrections()).toBe(1);
    const rev = await scalar<string>(db, `select public.open_review_at($1, $2, $3, 'challenge', 'no such run on Strava', null, $4::timestamptz)`, [a, fx.inst, b, at(W1_DEADLINE, 15 * 60)]);
    expect(rev).toBeTruthy();
    // an appeal of a settled result, or a challenge of an untouched one, is still refused
    expect(await code(db.query(`select public.open_review_at($1, $2, $3, 'challenge', 'x', null, $4::timestamptz)`, [b, fx.inst, a, at(W1_DEADLINE, 15 * 60)]))).toBe('23514');
    await zeroSum();
  });

  it('RK-12 (safe): a run across Sunday midnight counts once, for the week it started in', async () => {
    const fx = await weeklyFixture();
    const [a] = fx.userIds;
    // started 23:50 Sunday before this week, ended 00:30 Monday: last week's run, nothing for this week
    const before = at(W1_OPEN, -10);
    await submitAt(a, [run(before, { external_id: 'straddle-in', distance_m: 8000, duration_s: 2400, ended_at: at(before, 40) })], at(W1_OPEN, 60));
    expect((await verdictOf('straddle-in')).verdict).toBe('accepted');
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '0', activity_count: 0 });
    // started 23:50 Sunday of this week, ended 00:30 next Monday: this week's run, synced after the close
    const sunday = at(W1_DEADLINE, -10);
    await submitAt(a, [run(at(W1_OPEN, 24 * 60), { external_id: 'mid', distance_m: 17000, duration_s: 6000, ended_at: at(W1_OPEN, 24 * 60 + 100) })], at(W1_OPEN, 30 * 60));
    await tick(W1_DEADLINE);
    expect((await resultsOf(fx.inst))[a].status).toBe('failed');
    await submitAt(a, [run(sunday, { external_id: 'straddle-out', distance_m: 8000, duration_s: 2400, ended_at: at(sunday, 40) })], at(W1_DEADLINE, 45));
    expect((await resultsOf(fx.inst))[a]).toEqual({ status: 'success', first: at(sunday, 40) });
    expect(await progressOf(fx.inst, a)).toMatchObject({ value: '25000', activity_count: 2 });
    // the next week (if it existed) would not see it: started_at is in exactly one window
    expect(await scalar<number>(db, `select count(*)::int from public.pact_activities where activity_id = (select id from public.activities where external_id = 'straddle-out')`)).toBe(1);
  });

  it('RK-13 (safe): in a 2-person pact a challenge of a goal success has no voters and defaults; the forged-run suspicion needs a third member', async () => {
    const fx = await weeklyFixture(2);
    const [a, b] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 160));
    await tick(W1_DEADLINE);
    const rev = await scalar<string>(db, `select public.open_review_at($1, $2, $3, 'challenge', 'that was a bike', null, $4::timestamptz)`, [b, fx.inst, a, at(W1_DEADLINE, 60)]);
    expect(await rows(db, `select u from public._review_voters($1) u`, [rev])).toEqual([]);
    expect(await code(db.query(`select public.cast_vote_at($1, $2, true, $3::timestamptz)`, [b, rev, at(W1_DEADLINE, 61)]))).toBe('42501');
    await db.query(`select public.default_open_reviews($1, $2::timestamptz)`, [fx.groupId, W1_DEADLINE]);
    expect(await scalar(db, `select status::text from public.reviews where id = $1`, [rev])).toBe('defaulted');
    expect((await resultsOf(fx.inst))[a].status).toBe('success');
    expect(await netsOf(fx.inst)).toEqual({ [a]: 500, [b]: -500 });
  });

  it('RK-14 (safe): a review resolving does not let evidence that arrived after 24 h into the money', async () => {
    const fx = await weeklyFixture();
    const [a, b] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 160));
    await submitAt(b, [run(d1, { external_id: 'b1', distance_m: 10000, duration_s: 3600, ended_at: at(d1, 60) })], at(d1, 160));
    await tick(W1_DEADLINE);
    const before = await netsOf(fx.inst);
    // Wednesday: b "finds" a Sunday run and appeals the miss
    const sunday = at(W1_DEADLINE, -5 * 60);
    await submitAt(b, [run(sunday, { external_id: 'b-found', distance_m: 15000, duration_s: 5400, ended_at: at(sunday, 90) })], at(W1_DEADLINE, 50 * 60));
    expect(await progressOf(fx.inst, b)).toMatchObject({ value: '25000' }); // shown
    expect((await resultsOf(fx.inst))[b].status).toBe('failed'); // not billed
    await db.query(`select public.open_review_at($1, $2, $3, 'appeal', 'see the run', null, $4::timestamptz)`, [b, fx.inst, b, at(W1_DEADLINE, 51 * 60)]);
    await db.query(`select public.default_open_reviews($1, $2::timestamptz)`, [fx.groupId, at(W1_DEADLINE, 7 * 24 * 60)]);
    expect((await resultsOf(fx.inst))[b].status).toBe('failed');
    expect(await netsOf(fx.inst)).toEqual(before);
    expect(await corrections()).toBe(0);
    // an accepted appeal is the group's call and still works on a goal kind: success at the deadline, correction posted
    const fx2 = await weeklyFixture();
    const [x, y, z] = fx2.userIds;
    await submitAt(x, [run(d1, { external_id: 'x1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 160));
    await tick(W1_DEADLINE);
    const rev = await scalar<string>(db, `select public.open_review_at($1, $2, $3, 'appeal', 'treadmill, no sync', null, $4::timestamptz)`, [y, fx2.inst, y, at(W1_DEADLINE, 60)]);
    await db.query(`select public.cast_vote_at($1, $2, true, $3::timestamptz)`, [x, rev, at(W1_DEADLINE, 61)]);
    await db.query(`select public.cast_vote_at($1, $2, true, $3::timestamptz)`, [z, rev, at(W1_DEADLINE, 62)]);
    expect((await resultsOf(fx2.inst))[y]).toEqual({ status: 'success', first: W1_DEADLINE });
    expect(await netsOf(fx2.inst)).toEqual({ [x]: 250, [y]: 250, [z]: -500 });
    await zeroSum();
  });

  it('RK-15 (safe): pausing the pact mid-week does not cancel the open week; it closes and pays', async () => {
    const fx = await weeklyFixture();
    const [a, b, c] = fx.userIds;
    const d1 = at(W1_OPEN, 7 * 60);
    await submitAt(a, [run(d1, { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(d1, 150) })], at(d1, 160));
    await asUser(db, fx.ownerId, (d) => d.query(`select public.set_pact_paused($1, true)`, [fx.pactId]));
    await tick(at(W1_DEADLINE, -60));
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [fx.inst])).toBe('open');
    await tick(W1_DEADLINE);
    expect(await scalar(db, `select status::text from public.pact_instances where id = $1`, [fx.inst])).toBe('closed');
    expect(await netsOf(fx.inst)).toEqual({ [a]: 1000, [b]: -500, [c]: -500 });
    // no new week while paused
    expect(await gen(at(W1_DEADLINE, -24 * 60))).toBe(0);
  });

  it('RK-16 (safe): no unverified on goal kinds, and the appeal is the only path for a dead watch', async () => {
    const fx = await weeklyFixture(2);
    const [a, b] = fx.userIds;
    await submitAt(a, [run(at(W1_OPEN, 60), { external_id: 'a1', distance_m: 25000, duration_s: 9000, ended_at: at(W1_OPEN, 210) })], at(W1_OPEN, 240));
    await tick(W1_DEADLINE);
    expect((await resultsOf(fx.inst))[b].status).toBe('failed');
    expect(await scalar<number>(db, `select count(*)::int from public.results where status = 'unverified'`)).toBe(0);
    expect(await scalar<number>(db, `select count(*)::int from public.reviews where system_opened`)).toBe(0);
    expect(await scalar<string>(db, `select public.open_review_at($1, $2, $3, 'appeal', 'watch died Thursday', null, $4::timestamptz)`, [b, fx.inst, b, at(W1_DEADLINE, 60)])).toBeTruthy();
  });
});
