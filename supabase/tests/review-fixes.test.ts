// Guards for the review fixes in 20261107000600_review_fixes.sql (docs/REVIEW.md).
// Each test was written before the migration and failed against 0100..0500 alone.
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, expectError, rows, scalar, type DB } from "./helpers/db";

async function indexDefs(db: DB, table: string): Promise<string[]> {
  return (await rows<{ indexdef: string }>(db, `select indexdef from pg_indexes where schemaname = 'public' and tablename = $1`, [table]))
    .map((r) => r.indexdef);
}

describe("review fixes: indexes (R1-R3)", () => {
  let db: DB;
  beforeAll(async () => {
    db = await createDb();
  });

  it("R1: claim_outbox has a precise partial index (id) where sent_at is null and attempts < 5", async () => {
    const defs = await indexDefs(db, "notification_outbox");
    expect(defs.some((d) => /USING btree \(id\) WHERE \(\(sent_at IS NULL\) AND \(attempts < 5\)\)/.test(d)), defs.join("\n")).toBe(true);
    // the foundation index of the same name (created_at, sent_at is null) shadowed the (id) index 0500 meant to add
    expect(defs.some((d) => /USING btree \(created_at\) WHERE \(sent_at IS NULL\)/.test(d))).toBe(false);
  });

  it("R2: pact_instances has (pact_id, deadline_at) for feed / pact detail / settlement scans", async () => {
    const defs = await indexDefs(db, "pact_instances");
    expect(defs.some((d) => /\(pact_id, deadline_at\)/.test(d)), defs.join("\n")).toBe(true);
  });

  it("R3: ledger_accounts has (group_id, kind) for account_balances by group", async () => {
    const defs = await indexDefs(db, "ledger_accounts");
    expect(defs.some((d) => /\(group_id, kind\)/.test(d)), defs.join("\n")).toBe(true);
  });
});

describe("review fixes: RLS initplan (R4)", () => {
  it("every policy that calls auth.uid() wraps it in a subselect so it is evaluated once per statement", async () => {
    const db = await createDb();
    const pols = await rows<{ polname: string; qual: string | null; wc: string | null }>(
      db,
      `select p.polname, pg_get_expr(p.polqual, p.polrelid) qual, pg_get_expr(p.polwithcheck, p.polrelid) wc
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'`,
    );
    expect(pols.length).toBeGreaterThan(10);
    const bare = pols.filter((p) =>
      [p.qual, p.wc].some((e) => e && e.replaceAll("( SELECT auth.uid() AS uid)", "").includes("auth.uid()")),
    );
    expect(bare.map((p) => `${p.polname}: ${p.qual} / ${p.wc}`)).toEqual([]);
  });

  it("rewritten policies behave as before: own profile, co-member profiles, own push tokens, party obligations", async () => {
    const db = await createDb();
    const a = await createUser(db, "a@x.test", "A");
    const b = await createUser(db, "b@x.test", "B");
    const c = await createUser(db, "c@x.test", "C");
    const g = await asUser(db, a, (d) => scalar<string>(d, `select public.create_group('G', 'UTC')`));
    const code = await scalar<string>(db, `select invite_code from public.groups where id = $1`, [g]);
    await asUser(db, b, (d) => d.query(`select public.join_group($1)`, [code]));

    const seenByA = await asUser(db, a, (d) => rows<{ id: string }>(d, `select id from public.profiles order by display_name`));
    expect(seenByA.map((r) => r.id).sort()).toEqual([a, b].sort());
    const seenByC = await asUser(db, c, (d) => rows<{ id: string }>(d, `select id from public.profiles`));
    expect(seenByC.map((r) => r.id)).toEqual([c]);

    await asUser(db, a, (d) => d.query(`update public.profiles set display_name = 'A2' where id = $1`, [a]));
    await asUser(db, a, (d) => d.query(`update public.profiles set display_name = 'hacked' where id = $1`, [b]));
    expect(await scalar(db, `select display_name from public.profiles where id = $1`, [a])).toBe("A2");
    expect(await scalar(db, `select display_name from public.profiles where id = $1`, [b])).toBe("B");

    await asUser(db, a, (d) => d.query(`select public.register_push_token('ExponentPushToken[a]', 'ios')`));
    await asUser(db, b, (d) => d.query(`select public.register_push_token('ExponentPushToken[b]', 'ios')`));
    expect(await asUser(db, a, (d) => rows(d, `select token from public.push_tokens`))).toEqual([{ token: "ExponentPushToken[a]" }]);
    await asUser(db, b, (d) => d.query(`delete from public.push_tokens`));
    expect(await rows(db, `select token from public.push_tokens`)).toEqual([{ token: "ExponentPushToken[a]" }]);

    await db.query(`insert into public.notification_outbox (user_id, kind) values ($1, 'result'), ($2, 'result')`, [a, b]);
    expect(await asUser(db, b, (d) => scalar<number>(d, `select count(*)::int from public.notification_outbox`))).toBe(1);

    // obligations: a party keeps seeing theirs after leaving the group; outsiders see nothing
    const s = await scalar<string>(db, `insert into public.settlements (group_id, week_start) values ($1, '2026-11-02') returning id`, [g]);
    await db.query(
      `insert into public.obligations (settlement_id, group_id, from_user, to_user, amount_cents) values ($1, $2, $3, $4, 500)`,
      [s, g, b, a],
    );
    await asUser(db, b, (d) => d.query(`select public.leave_group($1)`, [g]));
    expect(await asUser(db, b, (d) => scalar<number>(d, `select count(*)::int from public.obligations`))).toBe(1);
    expect(await asUser(db, c, (d) => scalar<number>(d, `select count(*)::int from public.obligations`))).toBe(0);
  });
});

describe("review fixes: purge_old_outbox (R5)", () => {
  it("deletes sent rows and exhausted rows older than 30 days, keeps everything else, and is idempotent", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    const now = "2026-12-15T12:00:00Z";
    await db.query(
      `insert into public.notification_outbox (user_id, kind, created_at, sent_at, attempts) values
         ($1, 'result', '2026-10-01T00:00:00Z', '2026-10-01T00:01:00Z', 1),  -- old sent: purged
         ($1, 'result', '2026-12-10T00:00:00Z', '2026-12-10T00:01:00Z', 1),  -- recent sent: kept
         ($1, 'result', '2026-10-01T00:00:00Z', null, 5),                    -- old exhausted: purged
         ($1, 'result', '2026-10-01T00:00:00Z', null, 2),                    -- old but still retryable: kept
         ($1, 'result', '2026-12-14T00:00:00Z', null, 0)                     -- fresh unsent: kept`,
      [u],
    );
    const purged = await asService(db, (d) => scalar<number>(d, `select public.purge_old_outbox($1)`, [now]));
    expect(purged).toBe(2);
    const left = await rows<{ sent: boolean; attempts: number }>(
      db,
      `select sent_at is not null as sent, attempts from public.notification_outbox order by id`,
    );
    expect(left).toEqual([
      { sent: true, attempts: 1 },
      { sent: false, attempts: 2 },
      { sent: false, attempts: 0 },
    ]);
    expect(await asService(db, (d) => scalar<number>(d, `select public.purge_old_outbox($1)`, [now]))).toBe(0);
  });

  it("is a server job: not executable by clients", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await expectError(asUser(db, u, (d) => d.query(`select public.purge_old_outbox()`)), /permission denied/i);
    expect(
      await scalar(db, `select has_function_privilege('anon', 'public.purge_old_outbox(timestamptz)', 'execute')`),
    ).toBe(false);
  });
});

describe("review fixes: claim_outbox still drains in id order after the index change", () => {
  it("claims oldest first, skips exhausted rows", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await db.query(
      `insert into public.notification_outbox (user_id, kind, attempts) values ($1, 'result', 5), ($1, 'result', 0), ($1, 'result', 4)`,
      [u],
    );
    const claimed = await asService(db, (d) =>
      rows<{ id: number; attempts: number }>(d, `select id::int, attempts from public.claim_outbox(10, '2026-11-09T17:00:00Z') order by id`),
    );
    expect(claimed.map((r) => r.attempts)).toEqual([1, 5]);
  });
});
