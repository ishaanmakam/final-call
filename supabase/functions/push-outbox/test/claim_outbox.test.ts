import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const claimSql = readFileSync(new URL("../claim_outbox.sql", import.meta.url), "utf8");

const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table public.notification_outbox(
    id bigserial primary key,
    user_id uuid not null,
    kind text not null,
    payload jsonb not null default '{}',
    created_at timestamptz not null default now(),
    sent_at timestamptz null,
    attempts int not null default 0,
    last_error text null
  );
`;

type Row = { id: number; attempts: number };

describe("claim_outbox", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(claimSql);
    await db.exec(claimSql);
  });

  async function insert(n: number, extra = "") {
    await db.exec(`
      insert into notification_outbox(user_id, kind, payload)
      select gen_random_uuid(), 'result', '{}' from generate_series(1, ${n});
      ${extra}
    `);
  }

  async function claim(limit: number, now = "now()") {
    const res = await db.query<Row>(`select id::int, attempts from claim_outbox(${limit}, ${now}) order by id`);
    return res.rows;
  }

  it("claims unsent rows in id order up to the limit and increments attempts", async () => {
    await insert(5);
    const rows = await claim(3);
    expect(rows).toEqual([
      { id: 1, attempts: 1 },
      { id: 2, attempts: 1 },
      { id: 3, attempts: 1 },
    ]);
  });

  it("skips sent rows and rows that used up their attempts", async () => {
    await insert(4, `update notification_outbox set sent_at = now() where id = 1;
                     update notification_outbox set attempts = 5 where id = 2;`);
    expect((await claim(100)).map((r) => r.id)).toEqual([3, 4]);
  });

  it("does not hand the same row to an overlapping invocation while its lease is live", async () => {
    await insert(3);
    expect((await claim(2)).map((r) => r.id)).toEqual([1, 2]);
    expect((await claim(100)).map((r) => r.id)).toEqual([3]);
    expect(await claim(100)).toEqual([]);
  });

  it("re-offers an unsent row once its lease expires", async () => {
    await insert(1);
    await claim(100);
    const later = await claim(100, "now() + interval '6 minutes'");
    expect(later).toEqual([{ id: 1, attempts: 2 }]);
  });

  it("re-offers a row immediately when the function releases the lease after a failure", async () => {
    await insert(1);
    await claim(100);
    await db.exec(`update notification_outbox set claimed_until = null, last_error = 'x' where id = 1`);
    expect(await claim(100)).toEqual([{ id: 1, attempts: 2 }]);
  });

  it("is not executable by client roles", async () => {
    const res = await db.query<{ anon: boolean; auth: boolean; svc: boolean }>(`
      select has_function_privilege('anon', 'public.claim_outbox(int, timestamptz)', 'execute') as anon,
             has_function_privilege('authenticated', 'public.claim_outbox(int, timestamptz)', 'execute') as auth,
             has_function_privilege('service_role', 'public.claim_outbox(int, timestamptz)', 'execute') as svc`);
    expect(res.rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });
});

describe("claim_outbox.sql stays identical to the migration (F4)", () => {
  it("the function body in claim_outbox.sql equals the one in 20261107000500_app_support.sql", () => {
    const migration = readFileSync(new URL("../../../migrations/20261107000500_app_support.sql", import.meta.url), "utf8");
    const extract = (sql: string) => {
      const m = /create or replace function public\.claim_outbox[\s\S]*?\$\$;/.exec(sql);
      if (!m) throw new Error("claim_outbox definition not found");
      return m[0].replace(/\s+/g, " ").trim();
    };
    expect(extract(claimSql)).toBe(extract(migration));
  });
});
