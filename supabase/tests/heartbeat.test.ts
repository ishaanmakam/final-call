// Cron heartbeat and ops alerting: 20261108000500_heartbeat.sql (docs/CONTRACT.md "Server jobs").
// Written before the migration; every test here failed against 0100..0400 alone.
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createDb, createGroupFixture, createUser, expectError, rows, scalar, type DB } from "./helpers/db";

const JOBS = ["tick_instances", "generate_instances", "settle_due_groups", "purge_old_locations", "purge_old_outbox", "push_outbox"] as const;

interface Heartbeat {
  job: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  runs: string | number;
}

interface Health {
  job: string;
  expected_every: string;
  last_ok_at: string | null;
  overdue: boolean;
  recent_failures: number;
  never_ran: boolean;
  last_error: string | null;
}

const heartbeat = (db: DB, job: string) =>
  rows<Heartbeat>(db, `select * from public.job_heartbeats where job = $1`, [job]).then((r) => r[0]);

const health = (db: DB, job: string, at?: string) =>
  rows<Health>(db, `select * from public._job_health_at(coalesce($2::timestamptz, now())) where job = $1`, [job, at ?? null]).then((r) => r[0]!);

const setOps = (db: DB, userId: string | null) => db.query(`update public.ops_settings set ops_user_id = $1`, [userId]);

const alerts = (db: DB) =>
  rows<{ user_id: string; payload: { job: string; reason: string } ; created_at: string }>(
    db,
    `select user_id, payload, created_at from public.notification_outbox where kind = 'ops_alert' order by id`,
  );

describe("heartbeat: every job writes its row", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("job_heartbeats exists with the contract columns and job_health lists every scheduled job", async () => {
    const cols = (await rows<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'job_heartbeats' order by column_name`)).map((c) => c.column_name);
    expect(cols).toEqual(["job", "last_error", "last_finished_at", "last_ok_at", "last_started_at", "runs"]);
    const listed = (await rows<{ job: string }>(db, `select job from public.job_health order by job`)).map((r) => r.job);
    expect(listed).toEqual([...JOBS].sort());
  });

  it("tick_instances, generate_instances, settle_due_groups and both purges advance their heartbeat on success", async () => {
    await createGroupFixture(db);
    for (const job of JOBS) expect(await heartbeat(db, job)).toBeUndefined();

    await asService(db, async (d) => {
      await d.query(`select public.generate_instances(7, now())`);
      await d.query(`select public.tick_instances(now())`);
      await d.query(`select public.settle_due_groups(now())`);
      await d.query(`select public.purge_old_locations(now())`);
      await d.query(`select public.purge_old_outbox(now())`);
    });
    for (const job of JOBS.filter((j) => j !== "push_outbox")) {
      const h = await heartbeat(db, job);
      expect(h, job).toBeDefined();
      expect(h!.last_ok_at, job).not.toBeNull();
      expect(h!.last_finished_at, job).not.toBeNull();
      expect(h!.last_started_at, job).not.toBeNull();
      expect(h!.last_error, job).toBeNull();
      expect(Number(h!.runs), job).toBe(1);
    }
    // a second run counts, and the ok stamp moves forward (or stays equal within one transaction clock)
    await asService(db, (d) => d.query(`select public.tick_instances(now())`));
    const again = await heartbeat(db, "tick_instances");
    expect(Number(again!.runs)).toBe(2);
    expect(Date.parse(again!.last_ok_at!)).toBeGreaterThanOrEqual(Date.parse((await heartbeat(db, "generate_instances"))!.last_ok_at!));
  });

  it("the wrapped jobs still return what they did before (generate counts instances, purges count rows)", async () => {
    const { pactId } = await createGroupFixture(db, { name: "counts" });
    const n = await asService(db, (d) => scalar<number>(d, `select public.generate_instances(7, now())`));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(await scalar<number>(db, `select count(*)::int from public.pact_instances where pact_id = $1`, [pactId])).toBeGreaterThan(0);
    expect(await asService(db, (d) => scalar<number>(d, `select public.purge_old_locations(now())`))).toBe(0);
    expect(await asService(db, (d) => scalar<number>(d, `select public.purge_old_outbox(now())`))).toBe(0);
  });

  it("a job that throws records last_error, a job_failures row, and keeps last_ok_at", async () => {
    const before = await heartbeat(db, "generate_instances");
    // an invalid horizon raises 22023 inside the body; the wrapper records it instead of re-raising
    await asService(db, (d) => d.query(`select public.generate_instances(9999, now())`));
    const h = await heartbeat(db, "generate_instances");
    expect(h!.last_error).toMatch(/22023/);
    expect(String(h!.last_ok_at)).toBe(String(before!.last_ok_at));
    expect(Number(h!.runs)).toBe(Number(before!.runs) + 1);
    expect(await scalar<number>(db, `select count(*)::int from public.job_failures where job = 'generate_instances'`)).toBe(1);
    // the next good run clears the error
    await asService(db, (d) => d.query(`select public.generate_instances(7, now())`));
    expect((await heartbeat(db, "generate_instances"))!.last_error).toBeNull();
  });

  it("record_push_heartbeat writes the push_outbox row (ok and error)", async () => {
    await asService(db, (d) => d.query(`select public.record_push_heartbeat(true, null)`));
    let h = await heartbeat(db, "push_outbox");
    expect(h!.last_ok_at).not.toBeNull();
    expect(h!.last_error).toBeNull();
    await asService(db, (d) => d.query(`select public.record_push_heartbeat(false, 'claim_outbox: boom')`));
    h = await heartbeat(db, "push_outbox");
    expect(h!.last_error).toBe("claim_outbox: boom");
    expect(Number(h!.runs)).toBe(2);
  });
});

describe("heartbeat: job_health and overdue detection", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
    await createGroupFixture(db);
  });

  it("a job that never ran is flagged never_ran, not overdue (no alert storm on a fresh deploy)", async () => {
    const h = await health(db, "purge_old_locations");
    expect(h.never_ran).toBe(true);
    expect(h.overdue).toBe(false);
    expect(h.last_ok_at).toBeNull();
  });

  it("expected cadences: tick 1 min, generate 15 min, settle 60 min, purges 1 day, push 1 min", async () => {
    const cadence = Object.fromEntries((await rows<{ job: string; secs: number }>(db, `select job, extract(epoch from expected_every)::int secs from public.job_health`)).map((r) => [r.job, r.secs]));
    expect(cadence).toEqual({
      tick_instances: 60,
      generate_instances: 900,
      settle_due_groups: 3600,
      purge_old_locations: 86400,
      purge_old_outbox: 86400,
      push_outbox: 60,
    });
  });

  it("overdue flips once last_ok_at is older than 3x the cadence, evaluated at p_now", async () => {
    await asService(db, (d) => d.query(`select public.tick_instances(now())`));
    expect((await health(db, "tick_instances")).overdue).toBe(false);
    const inTwoMin = await scalar<string>(db, `select (now() + interval '2 minutes')::text`);
    const inFourMin = await scalar<string>(db, `select (now() + interval '4 minutes')::text`);
    expect((await health(db, "tick_instances", inTwoMin)).overdue).toBe(false);
    expect((await health(db, "tick_instances", inFourMin)).overdue).toBe(true);
    // the daily purge is fine for three days
    await asService(db, (d) => d.query(`select public.purge_old_outbox(now())`));
    const inTwoDays = await scalar<string>(db, `select (now() + interval '2 days')::text`);
    const inFourDays = await scalar<string>(db, `select (now() + interval '4 days')::text`);
    expect((await health(db, "purge_old_outbox", inTwoDays)).overdue).toBe(false);
    expect((await health(db, "purge_old_outbox", inFourDays)).overdue).toBe(true);
  });

  it("a job that has run but never succeeded is overdue at once (a missing Vault secret must not hide for an hour)", async () => {
    await asService(db, (d) => d.query(`select public.record_push_heartbeat(false, 'down')`));
    const h = await health(db, "push_outbox");
    expect(h.never_ran).toBe(false);
    expect(h.overdue).toBe(true);
    expect(h.last_error).toBe("down");
    // a success clears it
    await asService(db, (d) => d.query(`select public.record_push_heartbeat(true, null)`));
    expect((await health(db, "push_outbox")).overdue).toBe(false);
  });

  it("recent_failures counts job_failures rows of the last hour, tick's sub-jobs included", async () => {
    await db.query(`insert into public.job_failures (job, error, failed_at) values
      ('tick_instances', 'x', now() - interval '10 minutes'),
      ('place_timeouts', 'x', now() - interval '20 minutes'),
      ('tick_instances', 'old', now() - interval '2 hours')`);
    expect((await health(db, "tick_instances")).recent_failures).toBe(2);
    expect((await health(db, "settle_due_groups")).recent_failures).toBe(0);
  });
});

describe("heartbeat: check_job_health alerts the ops user", () => {
  let db: DB;
  let ops: string;
  beforeAll(async () => {
    db = await createDb();
    await createGroupFixture(db);
    ops = await createUser(db, "ops@x.test", "Ops");
  });

  it("ops_settings is one row with a nullable ops_user_id; nothing is alerted while it is null", async () => {
    expect(await scalar<number>(db, `select count(*)::int from public.ops_settings`)).toBe(1);
    expect(await scalar<string | null>(db, `select ops_user_id from public.ops_settings`)).toBeNull();
    await asService(db, (d) => d.query(`select public.tick_instances(now())`));
    const inTenMin = await scalar<string>(db, `select (now() + interval '10 minutes')::text`);
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health($1)`, [inTenMin]))).toBe(0);
    expect(await alerts(db)).toEqual([]);
    await expectError(db.query(`insert into public.ops_settings (ops_user_id) values (null)`), /duplicate|check|unique/i);
  });

  it("an overdue job inserts one ops_alert outbox row for the ops user, once per job per hour", async () => {
    await setOps(db, ops);
    const inTenMin = await scalar<string>(db, `select (now() + interval '10 minutes')::text`);
    const n = await asService(db, (d) => scalar<number>(d, `select public.check_job_health($1)`, [inTenMin]));
    expect(n).toBe(1);
    let a = await alerts(db);
    expect(a).toHaveLength(1);
    expect(a[0]!.user_id).toBe(ops);
    expect(a[0]!.payload.job).toBe("tick_instances");
    expect(a[0]!.payload.reason).toMatch(/overdue/);
    // the same minute again: nothing new
    const inElevenMin = await scalar<string>(db, `select (now() + interval '11 minutes')::text`);
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health($1)`, [inElevenMin]))).toBe(0);
    expect(await alerts(db)).toHaveLength(1);
    // an hour later, still overdue: a second alert
    const inTwoHours = await scalar<string>(db, `select (now() + interval '2 hours')::text`);
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health($1)`, [inTwoHours]))).toBe(1);
    a = await alerts(db);
    expect(a).toHaveLength(2);
    expect(a.every((x) => x.payload.job === "tick_instances")).toBe(true);
  });

  it("five job_failures rows in the last hour alert even when the heartbeat is fresh", async () => {
    await asService(db, (d) => d.query(`select public.settle_due_groups(now())`));
    await db.query(`insert into public.job_failures (job, error) select 'settle_due_groups', 'boom ' || g from generate_series(1, 4) g`);
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health(now())`))).toBe(0);
    await db.query(`insert into public.job_failures (job, error) values ('settle_due_groups', 'boom 5')`);
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health(now())`))).toBe(1);
    const mine = (await alerts(db)).filter((x) => x.payload.job === "settle_due_groups");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.payload.reason).toMatch(/5 failures/);
    // idempotent within the hour
    expect(await asService(db, (d) => scalar<number>(d, `select public.check_job_health(now())`))).toBe(0);
  });

  it("the alert payload carries what the ops user needs and a url the app can open", async () => {
    const a = (await rows<{ payload: Record<string, unknown> }>(db, `select payload from public.notification_outbox where kind = 'ops_alert' order by id limit 1`))[0]!;
    expect(a.payload).toMatchObject({ job: "tick_instances", url: "/settings" });
    expect(typeof a.payload.message).toBe("string");
    expect(a.payload).toHaveProperty("last_ok_at");
    expect(a.payload).toHaveProperty("recent_failures");
  });
});

describe("heartbeat: clients cannot see or run any of it", () => {
  let db: DB;
  let userId: string;
  beforeAll(async () => {
    db = await createDb();
    const f = await createGroupFixture(db);
    userId = f.ownerId;
    await asService(db, (d) => d.query(`select public.tick_instances(now())`));
  });

  it("authenticated and anon get permission denied on the tables and the view", async () => {
    for (const rel of ["job_heartbeats", "ops_settings", "job_health"]) {
      await expectError(asUser(db, userId, (d) => d.query(`select * from public.${rel}`)), /permission denied/);
      await expectError(asAnon(db, (d) => d.query(`select * from public.${rel}`)), /permission denied/);
    }
    await expectError(asUser(db, userId, (d) => d.query(`update public.ops_settings set ops_user_id = $1`, [userId])), /permission denied/);
  });

  it("authenticated and anon cannot execute the heartbeat functions", async () => {
    const calls = [
      `select public._heartbeat('tick_instances', true, null)`,
      `select public.record_push_heartbeat(true, null)`,
      `select public.check_job_health(now())`,
      `select * from public._job_health_at(now())`,
    ];
    for (const sql of calls) {
      await expectError(asUser(db, userId, (d) => d.query(sql)), /permission denied/);
      await expectError(asAnon(db, (d) => d.query(sql)), /permission denied/);
    }
  });

  it("every new SECURITY DEFINER function pins search_path and is executable by service_role", async () => {
    const fns = await rows<{ proname: string; config: string[] | null; svc: boolean }>(
      db,
      `select p.proname, p.proconfig config, has_function_privilege('service_role', p.oid, 'execute') svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in ('_heartbeat', 'record_push_heartbeat', 'check_job_health', '_job_health_at',
          'tick_instances', 'generate_instances', 'settle_due_groups', 'purge_old_locations', 'purge_old_outbox')`,
    );
    expect(fns.map((f) => f.proname).sort()).toHaveLength(9);
    for (const f of fns) {
      expect(f.svc, f.proname).toBe(true);
      expect((f.config ?? []).some((c) => c.startsWith("search_path=")), f.proname).toBe(true);
    }
  });
});
