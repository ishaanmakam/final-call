import { describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, expectError, rows, scalar } from "./helpers/db";

describe("app support migration", () => {
  it("lets a user set their own venmo username", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await asUser(db, u, (d) => d.query("update profiles set venmo_username = 'ishaan-makam' where id = $1", [u]));
    expect(await scalar(db, "select venmo_username from profiles where id = $1", [u])).toBe("ishaan-makam");
  });

  it("rejects a malformed venmo username", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await expectError(
      asUser(db, u, (d) => d.query("update profiles set venmo_username = 'has spaces!' where id = $1", [u])),
    );
  });

  it("does not let a user change someone else's venmo username", async () => {
    const db = await createDb();
    const a = await createUser(db, "a@x.test", "A");
    const b = await createUser(db, "b@x.test", "B");
    await asUser(db, a, (d) => d.query("update profiles set venmo_username = 'stolen-handle' where id = $1", [b]));
    expect(await scalar(db, "select venmo_username from profiles where id = $1", [b])).toBeNull();
  });

  it("lets a user delete only their own push tokens", async () => {
    const db = await createDb();
    const a = await createUser(db, "a@x.test", "A");
    const b = await createUser(db, "b@x.test", "B");
    await asUser(db, a, (d) => d.query("select register_push_token('ExponentPushToken[a]', 'ios')"));
    await asUser(db, b, (d) => d.query("select register_push_token('ExponentPushToken[b]', 'ios')"));
    await asUser(db, a, (d) => d.query("delete from push_tokens"));
    const left = await rows<{ token: string }>(db, "select token from push_tokens order by token");
    expect(left.map((r) => r.token)).toEqual(["ExponentPushToken[b]"]);
  });

  it("claims each unsent outbox row once until its lease expires", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await db.query("insert into notification_outbox (user_id, kind, payload) values ($1, 'result', '{}'), ($1, 'result', '{}')", [u]);
    const now = "2026-11-09T17:00:00Z";
    const first = await asService(db, (d) => rows(d, "select id from claim_outbox(10, $1)", [now]));
    const second = await asService(db, (d) => rows(d, "select id from claim_outbox(10, $1)", [now]));
    const afterLease = await asService(db, (d) => rows(d, "select id from claim_outbox(10, $1)", ["2026-11-09T17:06:00Z"]));
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
    expect(afterLease).toHaveLength(2);
  });

  it("does not let clients claim outbox rows", async () => {
    const db = await createDb();
    const u = await createUser(db, "a@x.test", "A");
    await expectError(asUser(db, u, (d) => d.query("select * from claim_outbox(10)")));
  });
});
