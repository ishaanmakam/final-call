// Strava integration tables and RPCs: 20261109000200_strava.sql (spec: docs/superpowers/specs/
// 2026-11-08-challenge-kinds-design.md, "Strava"). Written before the migration; every test here
// failed against the migrations up to 20261109000100.
//
// The Edge Function (supabase/functions/strava-sync) is the only writer of integration_tokens and
// strava_webhook_events (service role). Clients see their own connection through my_integrations
// (provider, athlete_id, connected_at) and can only disconnect; tokens never reach a client.
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createDb, createUser, expectError, rows, scalar, type DB } from "./helpers/db";

const code = (p: Promise<unknown>) => expectError(p).then((e) => e.code);

interface TokenRow {
  user_id: string;
  provider: string;
  athlete_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  connected_at: string;
}

const upsert = (
  db: DB,
  userId: string,
  opts: Partial<{ athlete: string; access: string; refresh: string; expires: string; scope: string }> = {},
) =>
  asService(db, (d) =>
    d.query(`select public.upsert_integration_token($1, 'strava', $2, $3, $4, $5::timestamptz, $6)`, [
      userId,
      opts.athlete ?? "12345",
      opts.access ?? "access-1",
      opts.refresh ?? "refresh-1",
      opts.expires ?? "2026-11-09T18:00:00Z",
      opts.scope ?? "read,activity:read_all",
    ]),
  );

const tokenRows = (db: DB, userId: string) =>
  asService(db, (d) => rows<TokenRow>(d, `select * from public.integration_tokens where user_id = $1`, [userId]));

describe("integration_tokens: service only", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("has the contract columns, RLS on, and the (user_id, provider) primary key", async () => {
    const cols = (
      await rows<{ column_name: string }>(
        db,
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'integration_tokens' order by column_name`,
      )
    ).map((c) => c.column_name);
    expect(cols).toEqual(["access_token", "athlete_id", "connected_at", "expires_at", "provider", "refresh_token", "scope", "user_id"]);
    expect(await scalar<boolean>(db, `select relrowsecurity from pg_class where oid = 'public.integration_tokens'::regclass`)).toBe(true);
    const pk = await rows<{ attname: string }>(
      db,
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.integration_tokens'::regclass and i.indisprimary order by a.attname`,
    );
    expect(pk.map((p) => p.attname)).toEqual(["provider", "user_id"]);
  });

  it("upsert_integration_token inserts, then replaces tokens on reconnect and keeps connected_at", async () => {
    const u = await createUser(db);
    await upsert(db, u, { athlete: "777", access: "a1", refresh: "r1" });
    const first = (await tokenRows(db, u))[0]!;
    expect(first).toMatchObject({ provider: "strava", athlete_id: "777", access_token: "a1", refresh_token: "r1", scope: "read,activity:read_all" });
    expect(first.connected_at).toBeTruthy();

    await upsert(db, u, { athlete: "777", access: "a2", refresh: "r2", expires: "2026-11-10T00:00:00Z" });
    const second = await tokenRows(db, u);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ access_token: "a2", refresh_token: "r2" });
    expect(new Date(second[0]!.expires_at).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(new Date(second[0]!.connected_at).toISOString()).toBe(new Date(first.connected_at).toISOString());
  });

  it("upsert_integration_token rejects unknown providers, missing tokens and unknown users", async () => {
    const u = await createUser(db);
    expect(await code(asService(db, (d) => d.query(`select public.upsert_integration_token($1, 'garmin', '1', 'a', 'r', now(), null)`, [u])))).toBe("22023");
    expect(await code(asService(db, (d) => d.query(`select public.upsert_integration_token($1, 'strava', '1', '', 'r', now(), null)`, [u])))).toBe("22023");
    expect(await code(asService(db, (d) => d.query(`select public.upsert_integration_token($1, 'strava', '', 'a', 'r', now(), null)`, [u])))).toBe("22023");
    expect(await code(asService(db, (d) => d.query(`select public.upsert_integration_token(gen_random_uuid(), 'strava', '1', 'a', 'r', now(), null)`)))).toBe("P0002");
  });

  it("the service RPC is denied to authenticated and anon", async () => {
    const u = await createUser(db);
    await asUser(db, u, (d) => expectError(d.query(`select public.upsert_integration_token($1, 'strava', '1', 'a', 'r', now(), null)`, [u]), /permission denied/));
    await asAnon(db, (d) => expectError(d.query(`select public.upsert_integration_token($1, 'strava', '1', 'a', 'r', now(), null)`, [u]), /permission denied/));
  });

  it("clients cannot read tokens: select * and the secret columns are denied, for the owner too", async () => {
    const u = await createUser(db);
    await upsert(db, u);
    await asUser(db, u, async (d) => {
      await expectError(d.query(`select * from public.integration_tokens`), /permission denied/);
      await expectError(d.query(`select access_token from public.integration_tokens`), /permission denied/);
      await expectError(d.query(`select refresh_token from public.integration_tokens`), /permission denied/);
      await expectError(d.query(`select expires_at from public.integration_tokens`), /permission denied/);
      await expectError(d.query(`insert into public.integration_tokens (user_id, provider, athlete_id, access_token, refresh_token, expires_at) values ($1, 'strava', '1', 'a', 'r', now())`, [u]), /permission denied/);
      await expectError(d.query(`update public.integration_tokens set athlete_id = 'x'`), /permission denied/);
      await expectError(d.query(`delete from public.integration_tokens`), /permission denied/);
    });
    await asAnon(db, (d) => expectError(d.query(`select provider from public.integration_tokens`), /permission denied/));
  });

  it("one athlete can be connected to one account at a time (reconnecting elsewhere moves it)", async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await upsert(db, a, { athlete: "shared-1" });
    await upsert(db, b, { athlete: "shared-1" });
    expect(await tokenRows(db, a)).toHaveLength(0);
    expect((await tokenRows(db, b))[0]).toMatchObject({ athlete_id: "shared-1" });
  });

  it("deleting the account removes its tokens", async () => {
    const u = await createUser(db);
    await upsert(db, u, { athlete: "del-1" });
    await asUser(db, u, (d) => d.query(`select public.delete_my_account()`));
    expect(await tokenRows(db, u)).toHaveLength(0);
  });
});

describe("my_integrations: the owner's non-secret view", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("exposes exactly provider, athlete_id, connected_at", async () => {
    const cols = (
      await rows<{ column_name: string }>(
        db,
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'my_integrations' order by column_name`,
      )
    ).map((c) => c.column_name);
    expect(cols).toEqual(["athlete_id", "connected_at", "provider"]);
  });

  it("the owner sees their row, another user sees nothing, anon is denied", async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await upsert(db, a, { athlete: "A-1" });
    const mine = await asUser(db, a, (d) => rows<{ provider: string; athlete_id: string; connected_at: string }>(d, `select * from public.my_integrations`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ provider: "strava", athlete_id: "A-1" });
    expect(Object.keys(mine[0]!).sort()).toEqual(["athlete_id", "connected_at", "provider"]);
    expect(await asUser(db, b, (d) => rows(d, `select * from public.my_integrations`))).toEqual([]);
    await asAnon(db, (d) => expectError(d.query(`select * from public.my_integrations`), /permission denied/));
  });

  it("is read-only for clients", async () => {
    const a = await createUser(db);
    await upsert(db, a, { athlete: "A-2" });
    await asUser(db, a, async (d) => {
      await expectError(d.query(`delete from public.my_integrations`), /permission denied|cannot delete/);
      await expectError(d.query(`update public.my_integrations set athlete_id = 'x'`), /permission denied|cannot update/);
    });
    expect((await tokenRows(db, a))[0]).toMatchObject({ athlete_id: "A-2" });
  });
});

describe("disconnect_integration", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("deletes the caller's row only, and is idempotent", async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await upsert(db, a, { athlete: "A" });
    await upsert(db, b, { athlete: "B" });
    await asUser(db, a, (d) => d.query(`select public.disconnect_integration('strava')`));
    expect(await tokenRows(db, a)).toHaveLength(0);
    expect(await tokenRows(db, b)).toHaveLength(1);
    expect(await asUser(db, a, (d) => rows(d, `select * from public.my_integrations`))).toEqual([]);
    // again: no error, nothing to delete
    await asUser(db, a, (d) => d.query(`select public.disconnect_integration('strava')`));
    expect(await tokenRows(db, b)).toHaveLength(1);
  });

  it("requires a session and a known provider", async () => {
    await asAnon(db, (d) => expectError(d.query(`select public.disconnect_integration('strava')`), /permission denied/));
    const a = await createUser(db);
    expect(await code(asUser(db, a, (d) => d.query(`select public.disconnect_integration('garmin')`)))).toBe("22023");
    expect(await code(asUser(db, a, (d) => d.query(`select public.disconnect_integration(null)`)))).toBe("22023");
  });

  it("leaves the activities Strava already submitted in place (append-only evidence)", async () => {
    const a = await createUser(db);
    await upsert(db, a, { athlete: "A" });
    const n = await asService(db, (d) =>
      scalar<number>(
        d,
        `select public.submit_activities_for($1, $2::jsonb)`,
        [
          a,
          JSON.stringify([
            {
              source: "strava",
              external_id: "9001",
              activity_type: "running",
              started_at: "2026-11-03T15:00:00Z",
              ended_at: "2026-11-03T15:40:00Z",
              distance_m: 8000,
              duration_s: 2400,
              steps: null,
              device: "Garmin Forerunner 255",
              app_bundle: null,
              is_manual: false,
              raw_hash: "h1",
            },
          ]),
        ],
      ),
    );
    expect(Number(n)).toBe(1);
    await asUser(db, a, (d) => d.query(`select public.disconnect_integration('strava')`));
    const left = await asService(db, (d) => rows<{ external_id: string; verdict: string }>(d, `select external_id, verdict from public.activities where user_id = $1 and source = 'strava'`, [a]));
    expect(left).toEqual([{ external_id: "9001", verdict: "accepted" }]);
  });
});

describe("strava_webhook_events: service-only log", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("has the contract columns and RLS on", async () => {
    const cols = (
      await rows<{ column_name: string }>(
        db,
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'strava_webhook_events' order by column_name`,
      )
    ).map((c) => c.column_name);
    expect(cols).toEqual(["attempts", "error", "event", "id", "processed_at", "received_at"]);
    expect(await scalar<boolean>(db, `select relrowsecurity from pg_class where oid = 'public.strava_webhook_events'::regclass`)).toBe(true);
  });

  it("the service role writes and reads it; clients are denied", async () => {
    const id = await asService(db, (d) =>
      scalar<number>(d, `insert into public.strava_webhook_events (event) values ($1::jsonb) returning id`, [
        JSON.stringify({ object_type: "activity", aspect_type: "create", object_id: 1, owner_id: 2 }),
      ]),
    );
    expect(Number(id)).toBeGreaterThan(0);
    await asService(db, (d) => d.query(`update public.strava_webhook_events set processed_at = now() where id = $1`, [id]));
    expect(await asService(db, (d) => scalar<string | null>(d, `select processed_at from public.strava_webhook_events where id = $1`, [id]))).not.toBeNull();
    const u = await createUser(db);
    await asUser(db, u, (d) => expectError(d.query(`select * from public.strava_webhook_events`), /permission denied/));
    await asUser(db, u, (d) => expectError(d.query(`insert into public.strava_webhook_events (event) values ('{}')`), /permission denied/));
    await asAnon(db, (d) => expectError(d.query(`select * from public.strava_webhook_events`), /permission denied/));
  });
});
