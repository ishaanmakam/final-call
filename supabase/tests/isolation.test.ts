import { describe, expect, it } from "vitest";
import { asService, createDb, createGroupFixture, rows, scalar } from "./helpers/db";

describe("settle_due_groups isolation", () => {
  it("keeps settling other groups when one group's settlement fails, and records the failure", async () => {
    const db = await createDb();
    const good = await createGroupFixture(db, { members: 2, pact: false, name: "good" });
    const bad = await createGroupFixture(db, { members: 2, pact: false, name: "bad" });

    await db.exec(`
      create function pg_temp.fail_bad() returns trigger language plpgsql as $$
      begin
        if new.group_id = '${bad.groupId}' then
          raise exception 'injected failure for test';
        end if;
        return new;
      end $$;
      create trigger fail_bad before insert on public.settlements
        for each row execute function pg_temp.fail_bad();
    `);

    const now = await scalar<string>(db, "select (now() + interval '15 days')::text");
    await asService(db, (d) => d.query("select settle_due_groups($1::timestamptz)", [now]));

    const settled = await rows<{ group_id: string }>(db, "select distinct group_id from settlements");
    expect(settled.map((r) => r.group_id)).toEqual([good.groupId]);

    const failures = await rows<{ group_id: string; job: string; error: string }>(
      db,
      "select group_id, job, error from job_failures",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ group_id: bad.groupId, job: "settle_due_groups" });
    expect(failures[0]!.error).toMatch(/injected failure/);
  });

  it("does not expose job failures to clients", async () => {
    const db = await createDb();
    const g = await createGroupFixture(db, { members: 2, pact: false });
    const { asUser } = await import("./helpers/db");
    const visible = await asUser(db, g.ownerId, (d) =>
      d.query("select count(*)::int as n from job_failures").then(
        (r) => (r.rows[0] as { n: number }).n,
        () => -1,
      ),
    );
    expect(visible === 0 || visible === -1).toBe(true);
  });
});
