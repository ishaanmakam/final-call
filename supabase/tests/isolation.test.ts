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

describe("tick_instances isolation", () => {
  async function twoGroupsWithInstance(db: Awaited<ReturnType<typeof createDb>>, open: string, deadline: string, status: string) {
    const good = await createGroupFixture(db, { members: 2, name: "good" });
    const bad = await createGroupFixture(db, { members: 2, name: "bad" });
    const ids: Record<string, string> = {};
    for (const [k, fx] of [["good", good], ["bad", bad]] as const) {
      await db.query("update pact_participants set joined_at = '2020-01-01Z' where pact_id = $1", [fx.pactId]);
      ids[k] = await scalar<string>(
        db,
        `insert into pact_instances (pact_id, local_date, window_open_at, deadline_at, status)
         values ($1, '2030-01-07', $2::timestamptz, $3::timestamptz, $4::instance_status) returning id`,
        [fx.pactId, open, deadline, status],
      );
    }
    return { good, bad, ids };
  }

  it("keeps closing other instances when one instance's close fails, and records the failure", async () => {
    const db = await createDb();
    const { bad, ids } = await twoGroupsWithInstance(db, "2030-01-07T16:00Z", "2030-01-07T17:00Z", "open");
    await db.exec(`
      create function pg_temp.fail_close() returns trigger language plpgsql as $$
      begin
        if new.instance_id = '${ids.bad}' then raise exception 'injected close failure'; end if;
        return new;
      end $$;
      create trigger fail_close before insert on public.results for each row execute function pg_temp.fail_close();
    `);
    await asService(db, (d) => d.query("select tick_instances($1::timestamptz)", ["2030-01-07T17:01Z"]));
    expect(await scalar(db, "select status::text from pact_instances where id = $1", [ids.good])).toBe("closed");
    expect(await scalar(db, "select status::text from pact_instances where id = $1", [ids.bad])).toBe("open");
    expect(await scalar<number>(db, "select count(*)::int from results where instance_id = $1", [ids.bad])).toBe(0);
    const failures = await rows<{ group_id: string; job: string; error: string }>(db, "select group_id, job, error from job_failures");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ group_id: bad.groupId, job: "tick_instances" });
    expect(failures[0]!.error).toMatch(/injected close failure/);

    // the next tick retries it once the cause is gone
    await db.exec("drop trigger fail_close on public.results");
    await asService(db, (d) => d.query("select tick_instances($1::timestamptz)", ["2030-01-07T17:02Z"]));
    expect(await scalar(db, "select status::text from pact_instances where id = $1", [ids.bad])).toBe("closed");
  });

  it("keeps opening other instances when one instance's open fails", async () => {
    const db = await createDb();
    const { bad, ids } = await twoGroupsWithInstance(db, "2030-01-07T16:00Z", "2030-01-07T17:00Z", "scheduled");
    await db.exec(`
      create function pg_temp.fail_open() returns trigger language plpgsql as $$
      begin
        if new.id = '${ids.bad}' and new.status = 'open' then raise exception 'injected open failure'; end if;
        return new;
      end $$;
      create trigger fail_open before update on public.pact_instances for each row execute function pg_temp.fail_open();
    `);
    await asService(db, (d) => d.query("select tick_instances($1::timestamptz)", ["2030-01-07T16:01Z"]));
    expect(await scalar(db, "select status::text from pact_instances where id = $1", [ids.good])).toBe("open");
    expect(await scalar(db, "select status::text from pact_instances where id = $1", [ids.bad])).toBe("scheduled");
    const failures = await rows<{ group_id: string; job: string }>(db, "select group_id, job from job_failures");
    expect(failures).toEqual([{ group_id: bad.groupId, job: "tick_instances" }]);
  });
});
