import { expect, it } from 'vitest';
import {
  activityVerdict,
  computeInstancePayout,
  computeProgress,
  computeResults,
  type ActivityRecord,
  type ActivitySource,
  type PactKind,
} from '../../packages/rules/src/index';
import { createDb, createGroupFixture, rows, scalar, type DB } from './helpers/db';

// Differential test for challenge kinds (20261109000100): random weekly distance / workouts pacts and
// daily steps pacts with random activities (sources, manual flags, future ends, unknown types,
// implausible paces, cross-source overlaps, step-sample updates, late arrivals inside and outside the
// 24 h window, freezes) run through submit_activities_at + tick_instances, compared with the oracle:
// every verdict (activityVerdict), the instance_progress view (computeProgress), results
// (computeResults with kind) and the ledger per instance (computeInstancePayout), plus the property
// invariants: zero-sum per instance and an idempotent replay of the whole sync sequence.
// Seed with DIFF_SEED to reproduce.
const SEED = Number(process.env.DIFF_SEED ?? 20261109);
const SCENARIOS = Number(process.env.DIFF_KIND_SCENARIOS ?? 120);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (t: number) => new Date(t).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TYPES = ['running', 'walking', 'cycling', 'swimming', 'hiking', 'rowing', 'strength', 'yoga', 'other'];

type Item = {
  source: ActivitySource;
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
type Submission = { user: string; now: number; items: Item[] };

it(`SQL verdicts, progress, results and payouts match packages/rules on ${SCENARIOS} random goal instances (seed ${SEED})`, async () => {
  const rnd = mulberry32(SEED);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shuffle = <T,>(xs: readonly T[]) => [...xs].sort(() => rnd() - 0.5);

  const db: DB = await createDb();
  const fx = await createGroupFixture(db, { members: 8, pact: false, tz: 'UTC' });

  const mismatches: string[] = [];
  const stats = {
    accepted: 0, rejected_manual: 0, rejected_duplicate: 0, rejected_type: 0, rejected_future: 0, implausible: 0,
    stepsUpdates: 0, conflicts: 0, lateCounted: 0, lateIgnored: 0, success: 0, failed: 0, frozen: 0, void: 0,
    voided: 0, corrections: 0, distance: 0, workouts: 0, steps: 0,
  };
  // Mondays from 2030-01-07 (UTC pact zone: weeks are Monday 00:00Z .. Monday 00:00Z)
  const base = Date.parse('2030-01-07T00:00:00Z');
  let ext = 0;
  // Every record of every user across scenarios, like the activities table: an activity synced in one
  // week that started in the next week's window counts there (the generator makes some on purpose).
  const records: ActivityRecord[] = [];
  const byKey = new Map<string, ActivityRecord>();

  for (let s = 0; s < SCENARIOS; s++) {
    const kind: PactKind = pick(['distance', 'distance', 'workouts', 'steps']);
    stats[kind as 'distance' | 'workouts' | 'steps']++;
    const W = base + s * 7 * DAY;
    const D = kind === 'steps' ? W + DAY - 60_000 : W + 7 * DAY;
    const types = kind === 'distance' ? pick([['running'], ['running', 'walking'], ['cycling'], ['running', 'cycling', 'hiking']])
      : kind === 'workouts' ? shuffle(TYPES).slice(0, int(2, 5)) : [];
    const goal = kind === 'distance' ? pick([10000, 16093, 24140, 30000]) : kind === 'workouts' ? int(2, 4) : pick([6000, 8000, 10000]);
    const stake = pick([100, 250, 500, 1000]);
    const users = shuffle(fx.userIds).slice(0, int(2, 6));

    const pactId = await scalar<string>(
      db,
      `insert into public.pacts (group_id, title, days_of_week, window_open_local, deadline_local, stake_cents, tz, created_by,
                                 kind, period, goal_value, goal_unit, activity_types)
       values ($1, $2, $3::smallint[], $4::time, $5::time, $6, 'UTC', $7, $8::public.pact_kind, $9::public.pact_period, $10, $11, $12::text[])
       returning id`,
      [
        fx.groupId, `kinds ${s}`,
        kind === 'steps' ? [1, 2, 3, 4, 5, 6, 7] : null,
        '00:00', kind === 'steps' ? '23:59' : '23:59',
        stake, fx.ownerId, kind, kind === 'steps' ? 'daily' : 'weekly', goal,
        kind === 'distance' ? 'm' : kind === 'workouts' ? 'count' : 'steps',
        kind === 'steps' ? null : types,
      ],
    );
    for (const u of users) {
      await db.query(`insert into public.pact_participants (pact_id, user_id, joined_at) values ($1, $2, '2020-01-01Z')`, [pactId, u]);
    }
    const inst = await scalar<string>(
      db,
      `insert into public.pact_instances (pact_id, local_date, window_open_at, deadline_at)
       values ($1, ($2::timestamptz at time zone 'UTC')::date, $2::timestamptz, $3::timestamptz) returning id`,
      [pactId, iso(W), iso(D)],
    );
    const frozen = new Set<string>();
    for (const u of users) {
      if (rnd() < 0.12) {
        await db.query(`select public.declare_freeze_at($1, $2, $3::timestamptz)`, [u, inst, iso(W - int(1, 3000) * 1000)]);
        frozen.add(u);
      }
    }
    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(W)]);

    // ---- random sync batches ---------------------------------------------------------------
    const subs: Submission[] = [];
    for (const u of users) {
      const batches = int(0, 3);
      for (let b = 0; b < batches; b++) {
        const late = rnd();
        const now = late < 0.55 ? W + Math.floor(rnd() * (D - W)) : late < 0.85 ? D + int(1, 23) * HOUR : D + int(25, 60) * HOUR;
        const items: Item[] = [];
        for (let k = 0; k < int(1, 4); k++) {
          const insideWindow = rnd() < 0.85;
          const start = insideWindow ? W + Math.floor(rnd() * (D - W)) : (rnd() < 0.5 ? W - int(1, 48) * HOUR : D + int(0, 48) * HOUR);
          let type = kind === 'steps' ? (rnd() < 0.85 ? 'steps' : pick(TYPES))
            : rnd() < 0.75 ? pick(types) : rnd() < 0.8 ? pick(TYPES) : pick(['skiing', 'steps', 'Running ']);
          const source: ActivitySource = pick(['healthkit', 'healthkit', 'strava', 'manual']);
          const isSteps = type.trim().toLowerCase() === 'steps';
          const durMin = isSteps ? int(60, 24 * 60) : pick([5, 9, 10, 12, 30, 45, 60, 90]);
          const dist = isSteps ? null : type.trim().toLowerCase() === 'cycling' ? durMin * 60 * pick([5, 8, 12, 24, 30]) : durMin * 60 * pick([1.5, 2.5, 3, 3.5, 4, 14]);
          const item: Item = {
            source,
            external_id: `e${++ext}`,
            activity_type: type,
            started_at: iso(start),
            ended_at: iso(start + durMin * 60_000 + (rnd() < 0.1 ? int(1, 59) * 1000 : 0)),
            distance_m: dist === null ? null : rnd() < 0.1 ? null : dist,
            duration_s: rnd() < 0.2 ? null : durMin * 60,
            steps: isSteps ? int(500, 12000) : null,
            device: 'Apple Watch',
            app_bundle: null,
            is_manual: rnd() < 0.12,
            raw_hash: rnd() < 0.5 ? `h${ext}` : null,
          };
          items.push(item);
          // a cross-source twin shortly after (overlapping a lot or a little)
          if (!isSteps && rnd() < 0.3) {
            const shift = rnd() < 0.6 ? int(0, 2) : int(5, 40);
            items.push({
              ...item,
              source: item.source === 'strava' ? 'healthkit' : 'strava',
              external_id: `e${++ext}`,
              started_at: iso(start + shift * 60_000),
              ended_at: iso(start + durMin * 60_000 + shift * 60_000),
              is_manual: rnd() < 0.1,
              raw_hash: null,
            });
          }
          // a daily step total re-synced later in the day with more steps (or a conflicting re-submit of a workout)
          if (rnd() < 0.2) {
            const again: Item = isSteps
              ? { ...item, steps: (item.steps ?? 0) + int(1, 5000), ended_at: iso(start + (durMin + 30) * 60_000), raw_hash: `h${ext}b` }
              : { ...item, distance_m: (item.distance_m ?? 0) + 1, raw_hash: `h${ext}c` };
            subs.push({ user: u, now: now + int(1, 120) * 60_000, items: [again] });
          }
        }
        subs.push({ user: u, now, items });
      }
    }
    subs.sort((a, b) => a.now - b.now);

    // ---- run them through SQL and the oracle in the same order -------------------------------
    let closed = false;
    const sqlVerdicts = async (user: string) =>
      rows<{ external_id: string; verdict: string; steps: number | null; ended_at: Date }>(
        db, `select external_id, verdict::text, steps, ended_at from public.activities where user_id = $1`, [user]);
    const runSub = async (sub: Submission, replay: boolean) => {
      if (!closed && sub.now >= D) {
        await db.query(`select public.tick_instances($1::timestamptz)`, [iso(D)]);
        closed = true;
      }
      let sqlErr: string | null = null;
      try {
        await db.query(`select public.submit_activities_at($1, $2::jsonb, $3::timestamptz)`, [sub.user, JSON.stringify(sub.items), iso(sub.now)]);
      } catch (e: any) {
        sqlErr = e.code ?? e.message;
      }
      // oracle: all-or-nothing like the SQL (one conflicting item rejects the whole batch)
      const pending: { key: string; rec: ActivityRecord }[] = [];
      let oracleErr: string | null = null;
      const seen: ActivityRecord[] = [...records];
      for (const it of sub.items) {
        const key = `${sub.user}|${it.source}|${it.external_id}`;
        const cur = byKey.get(key) ?? pending.find((p) => p.key === key)?.rec;
        const input = {
          source: it.source, externalId: it.external_id, activityType: it.activity_type.trim().toLowerCase(),
          startedAt: it.started_at, endedAt: it.ended_at, distanceM: it.distance_m, durationS: it.duration_s, steps: it.steps, isManual: it.is_manual,
        };
        if (cur) {
          if ((cur as any).rawHash === it.raw_hash) continue; // same hash: no-op (rejected_future re-judging is not generated here)
          if (cur.activityType !== 'steps' || input.activityType !== 'steps') { oracleErr = '23514'; break; }
          // only a later (or equal-time, larger) snapshot of the day replaces the row
          const curEnd = Date.parse(cur.endedAt);
          const newEnd = Date.parse(it.ended_at);
          if (newEnd < curEnd || (newEnd === curEnd && (it.steps ?? 0) < (cur.steps ?? 0))) continue;
          const v = it.is_manual ? 'rejected_manual' : Date.parse(it.ended_at) > sub.now + 5 * 60_000 ? 'rejected_future' : 'accepted';
          const rec: ActivityRecord = { ...cur, ...input, verdict: v, submittedAt: iso(sub.now) };
          (rec as any).rawHash = it.raw_hash;
          pending.push({ key, rec });
          if (!replay) stats.stepsUpdates++;
          continue;
        }
        const mine = seen.filter((r) => r.userId === sub.user);
        const { verdict } = activityVerdict(input, mine, iso(sub.now));
        const rec: ActivityRecord = { ...input, id: `z${String(ext + pending.length + records.length).padStart(8, '0')}`, userId: sub.user, verdict, submittedAt: iso(sub.now) };
        (rec as any).rawHash = it.raw_hash;
        pending.push({ key, rec });
        seen.push(rec);
      }
      if (replay) {
        if (sqlErr !== oracleErr) mismatches.push(`s${s} replay: sql=${sqlErr} oracle=${oracleErr}`);
        return;
      }
      if ((sqlErr === null) !== (oracleErr === null) || (sqlErr !== null && sqlErr !== oracleErr)) {
        mismatches.push(`s${s}: batch error sql=${sqlErr} oracle=${oracleErr} ${JSON.stringify(sub.items)}`);
        return;
      }
      if (oracleErr) { stats.conflicts++; return; }
      for (const { key, rec } of pending) {
        const old = byKey.get(key);
        if (old) records.splice(records.indexOf(old), 1);
        byKey.set(key, rec);
        records.push(rec);
        (stats as any)[rec.verdict]++;
        if (rec.verdict === 'rejected_type' && rec.activityType !== 'steps' && TYPES.includes(rec.activityType)) stats.implausible++;
        if (sub.now > D && Date.parse(rec.startedAt) < D && Date.parse(rec.startedAt) >= W && rec.verdict === 'accepted') {
          if (sub.now <= D + DAY) stats.lateCounted++; else stats.lateIgnored++;
        }
      }
      // every verdict and steps value must agree
      const sql = new Map((await sqlVerdicts(sub.user)).map((r) => [r.external_id, r]));
      for (const { rec } of pending) {
        const r = sql.get(rec.externalId);
        if (!r || r.verdict !== rec.verdict || (r.steps ?? null) !== (rec.steps ?? null) || r.ended_at.toISOString() !== rec.endedAt) {
          mismatches.push(`s${s} ${rec.externalId}: sql=${r?.verdict}/${r?.steps} oracle=${rec.verdict}/${rec.steps}`);
        }
      }
      // SQL ids for tie-breaks on equal start instants: take them from the table so both orders agree
      const ids = await rows<{ external_id: string; id: string }>(db, `select external_id, id from public.activities where user_id = $1`, [sub.user]);
      for (const { rec } of pending) rec.id = ids.find((x) => x.external_id === rec.externalId)?.id ?? rec.id;
    };
    for (const sub of subs) await runSub(sub, false);
    if (!closed) await db.query(`select public.tick_instances($1::timestamptz)`, [iso(D)]);

    // ---- progress view vs computeProgress (everything accepted, whenever it arrived) ----------
    const prog = await rows<{ user_id: string; value: string; activity_count: number; reached_at: Date | null }>(
      db, `select user_id, value::text, activity_count, reached_at from public.instance_progress where instance_id = $1`, [inst]);
    if (prog.length !== users.length) mismatches.push(`s${s}: ${prog.length} progress rows for ${users.length} users`);
    for (const u of users) {
      const o = computeProgress(kind, goal, types, { openAt: iso(W), deadlineAt: iso(D) }, records.filter((r) => r.userId === u));
      const r = prog.find((p) => p.user_id === u);
      const rAt = r?.reached_at ? r.reached_at.toISOString() : null;
      if (!r || Math.abs(Number(r.value) - o.value) > 1e-6 || r.activity_count !== o.count || rAt !== o.reachedAt) {
        const sqlActs = await rows(db, `select external_id, source::text, activity_type, started_at, ended_at, distance_m, duration_s, steps, is_manual, verdict::text, reject_reason, submitted_at from public.activities where user_id = $1 order by started_at`, [u]);
        const oracleActs = records.filter((x) => x.userId === u).map((x) => ({ e: x.externalId, t: x.activityType, s: x.startedAt, d: x.distanceM, v: x.verdict, sub: x.submittedAt }));
        mismatches.push(`s${s} progress ${u} (${kind} ${JSON.stringify(types)} goal ${goal} window ${iso(W)}..${iso(D)}): sql=${r?.value}/${r?.activity_count}/${rAt} oracle=${o.value}/${o.count}/${o.reachedAt}\n  SQL ${JSON.stringify(sqlActs)}\n  ORACLE ${JSON.stringify(oracleActs)}`);
      }
    }

    // ---- results vs computeResults (24 h cut-off) ---------------------------------------------
    const oracle = computeResults({
      kind, windowOpenAt: iso(W), deadlineAt: iso(D), goal, activityTypes: types,
      participants: users.map((u) => ({ userId: u, frozen: frozen.has(u) })),
      activities: records,
    });
    const status = await scalar<string>(db, `select status::text from public.pact_instances where id = $1`, [inst]);
    if ((status === 'voided') !== oracle.voided) mismatches.push(`s${s}: instance ${status}, oracle voided=${oracle.voided}`);
    if (oracle.voided) stats.voided++;
    const res = await rows<{ user_id: string; status: string; first_success_at: Date | null }>(
      db, `select user_id, status::text, first_success_at from public.results where instance_id = $1`, [inst]);
    if (res.length !== oracle.results.length) mismatches.push(`s${s}: ${res.length} results vs ${oracle.results.length}`);
    for (const o of oracle.results) {
      const r = res.find((x) => x.user_id === o.userId);
      const sqlFirst = r?.first_success_at ? r.first_success_at.toISOString() : null;
      if (!r || r.status !== o.status || sqlFirst !== o.firstSuccessAt) {
        mismatches.push(`s${s} result ${o.userId}: sql=${r?.status}/${sqlFirst} oracle=${o.status}/${o.firstSuccessAt}`);
      }
      (stats as any)[o.status] = ((stats as any)[o.status] ?? 0) + 1;
      if (r?.status === 'unverified') mismatches.push(`s${s}: unverified result on a goal kind`);
    }

    // ---- ledger vs computeInstancePayout; zero-sum ---------------------------------------------
    const carryIn = Number((await scalar<string | null>(db, `select carry_in_cents::text from public.pact_instances where id = $1`, [inst])) ?? 0);
    const nets = await rows<{ user_id: string | null; kind: string; net: string }>(
      db,
      `select a.user_id, a.kind::text, sum(l.amount_cents)::text as net
         from public.ledger_lines l join public.ledger_entries e on e.id = l.entry_id join public.ledger_accounts a on a.id = l.account_id
        where e.instance_id = $1 group by a.user_id, a.kind`,
      [inst],
    );
    const total = await scalar<string>(db, `select coalesce(sum(l.amount_cents), 0)::text from public.ledger_lines l join public.ledger_entries e on e.id = l.entry_id where e.instance_id = $1`, [inst]);
    if (total !== '0') mismatches.push(`s${s}: instance lines sum to ${total}`);
    const expected = oracle.voided ? { memberDeltas: {}, carryDelta: 0 } : computeInstancePayout({ stakeCents: stake, carryInCents: carryIn, results: oracle.results });
    const sqlMembers = Object.fromEntries(nets.filter((n) => n.kind === 'member' && Number(n.net) !== 0).map((n) => [n.user_id!, Number(n.net)]));
    if (JSON.stringify(sortObj(sqlMembers)) !== JSON.stringify(sortObj(expected.memberDeltas))) {
      mismatches.push(`s${s} payout: sql=${JSON.stringify(sortObj(sqlMembers))} oracle=${JSON.stringify(sortObj(expected.memberDeltas))}`);
    }
    const sqlCarry = Number(nets.find((n) => n.kind === 'carry')?.net ?? 0);
    if (sqlCarry !== expected.carryDelta) mismatches.push(`s${s} carry: sql=${sqlCarry} oracle=${expected.carryDelta}`);
    stats.corrections += await scalar<number>(db, `select count(*)::int from public.ledger_entries where instance_id = $1 and kind = 'correction'`, [inst]);

    // ---- idempotent replay of the whole sync sequence --------------------------------------------
    const entriesBefore = await scalar<number>(db, `select count(*)::int from public.ledger_entries`);
    const actsBefore = await scalar<string>(db, `select coalesce(string_agg(id::text || verdict::text || coalesce(steps::text, ''), ',' order by id), '') from public.activities`);
    for (const sub of subs) await runSub(sub, true);
    await db.query(`select public.tick_instances($1::timestamptz)`, [iso(D + 3 * DAY)]);
    if ((await scalar<number>(db, `select count(*)::int from public.ledger_entries`)) !== entriesBefore) mismatches.push(`s${s}: replay posted ledger entries`);
    if ((await scalar<string>(db, `select coalesce(string_agg(id::text || verdict::text || coalesce(steps::text, ''), ',' order by id), '') from public.activities`)) !== actsBefore) {
      mismatches.push(`s${s}: replay changed activities`);
    }
    const res2 = await rows<{ user_id: string; status: string }>(db, `select user_id, status::text from public.results where instance_id = $1`, [inst]);
    for (const r of res2) if (res.find((x) => x.user_id === r.user_id)?.status !== r.status) mismatches.push(`s${s}: replay changed a result`);
  }

  expect(mismatches.slice(0, 20)).toEqual([]);
  // Coverage of every branch the generator is meant to reach.
  expect(stats.accepted).toBeGreaterThan(150);
  expect(stats.rejected_manual).toBeGreaterThan(20);
  expect(stats.rejected_duplicate).toBeGreaterThan(15);
  expect(stats.rejected_type).toBeGreaterThan(15);
  expect(stats.implausible).toBeGreaterThan(5);
  expect(stats.rejected_future).toBeGreaterThan(5);
  expect(stats.stepsUpdates).toBeGreaterThan(3);
  expect(stats.conflicts).toBeGreaterThan(3);
  expect(stats.lateCounted).toBeGreaterThan(5);
  expect(stats.lateIgnored).toBeGreaterThan(5);
  expect(stats.success).toBeGreaterThan(20);
  expect(stats.failed).toBeGreaterThan(40);
  expect(stats.frozen).toBeGreaterThan(5);
  expect(stats.voided).toBeGreaterThan(3);
  expect(stats.corrections).toBeGreaterThan(3);
  expect(stats.distance).toBeGreaterThan(10);
  expect(stats.workouts).toBeGreaterThan(10);
  expect(stats.steps).toBeGreaterThan(10);
}, 900_000);

function sortObj(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
