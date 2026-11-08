# Database tests (PGlite + Vitest)

```
cd supabase/tests
npm install
npx vitest run              # all *.test.ts
npx vitest run foundation   # one file
npm run typecheck
```

Each test gets a fresh in-process Postgres 17 (PGlite) with a Supabase-like stub and **every** file in
`supabase/migrations/` applied in name order, so new migrations are picked up automatically. The first
`createDb()` per test file builds a template and dumps it; later calls clone it (~0.4 s each).

pgTAP versions of the key invariants live in `pgtap/` for `supabase test db` on a real local stack
(copy them into `supabase/tests/database/` if your CLI only looks there). `pgtap-dryrun.test.ts` runs
`pgtap/foundation_test.sql` here against a tiny pgTAP shim, so that file is known to pass.

## Helper API (`helpers/db.ts`)

```ts
createDb(opts?: { filter?: (file: string) => boolean; cache?: boolean }): Promise<PGlite>
asUser<T>(db, userId: string, fn: (db) => Promise<T>): Promise<T>   // role authenticated, auth.uid() = userId
asAnon<T>(db, fn): Promise<T>                                        // role anon, no uid
asService<T>(db, fn): Promise<T>                                     // role service_role (BYPASSRLS), like cron / service key
createUser(db, email?: string, displayName?: string): Promise<string> // inserts auth.users; profile made by trigger
createGroupFixture(db, opts?: {
  members?: number        // default 3; first user is owner
  tz?: string             // default 'America/Los_Angeles' (group settlement tz and pact tz)
  name?: string
  pact?: PactSpec | false // default pact: '9am class', Mon-Fri, 08:00-09:00, 500 cents; false = no pact
  participants?: number   // first N members join the pact (default all)
}): Promise<{ groupId, inviteCode, ownerId, userIds, pactId, participantIds }>
//   participant i's place: lat 47.6553 + i*0.01, lng -122.3035, radius 100 m, label "place i"
rows<T>(db, sql, params?): Promise<T[]>
scalar<T>(db, sql, params?): Promise<T>          // first column of first row
expectError(promise, match?: RegExp | string): Promise<error>  // asserts rejection; returns error (.code, .message)
SUPABASE_STUB_SQL, MIGRATIONS_DIR, migrationFiles()
```

Notes:
- Outside `asUser/asAnon/asService` you are `postgres` (superuser, bypasses RLS): use that for fixtures that
  only server code could create (e.g. inserting `pact_instances` directly).
- The role helpers use session-level `SET ROLE` + `set_config(..., false)` and always reset in `finally`.
  Statements run in autocommit, so a failing statement inside `fn` does not poison later ones.
  Use `db.transaction(async tx => ...)` when you need a transaction (e.g. to test deferred constraints at COMMIT).
- `fixture.pactId` is created by the owner through `create_pact`; all fixture writes go through the real RPCs.
- PGlite is one connection: no concurrency tests are possible here (row locks are still exercised logically).

## Supabase stub (installed before migrations)

- roles `anon`, `authenticated`, `service_role` (BYPASSRLS), if missing.
- `auth.users(id uuid pk default gen_random_uuid(), email text)` exactly; no `raw_user_meta_data`.
  The profile trigger reads metadata via `to_jsonb(new)`, so it works with the stub and with real Supabase.
- `auth.uid()` = `request.jwt.claim.sub` (falls back to `request.jwt.claims->>'sub'`); `auth.role()`, `auth.jwt()`.
- Supabase's default privileges on schema `public` (ALL on tables/sequences/functions to anon,
  authenticated, service_role), so grants/revokes in migrations are tested against production defaults.

## PGlite differences and workarounds

- No `pg_cron` / `pg_net` / `vault`: `20261107000400_cron.sql` is guarded by `pg_available_extensions` and is
  a no-op here (asserted by a test). Cron jobs are tested by calling the job functions with `p_now` directly.
- No Supabase Storage: the `storage.*` blocks in `20261107000500` / `20261107000600` are guarded by
  `to_regclass('storage.buckets')` and skipped here. Bucket policies are only exercised on a real stack.
- `review-fixes.test.ts` guards the indexes, RLS initplan rewrite and `purge_old_outbox` from
  `20261107000600_review_fixes.sql` (see `docs/REVIEW.md`).
- No `pgcrypto`: not needed. Invite codes use `gen_random_uuid()` bytes (built in, strong RNG).
- No pgTAP: see the shim dry run above.
- Constraint triggers (`DEFERRABLE INITIALLY DEFERRED`), RLS, `SET ROLE`, SECURITY DEFINER, `security_invoker`
  views, and `pg_timezone_names` all work natively; nothing is skipped.

## Conventions the foundation migration sets (read before writing migrations)

- Tables/sequences you create in `public` are **not** granted to `anon`/`authenticated` (default privileges
  revoked). Every table already exists in the foundation migration; if you add one, enable RLS and grant
  `select` explicitly.
- Functions still get `EXECUTE` for `PUBLIC` by default (Postgres behaviour). For every function you add:
  `revoke all on function ... from public, anon, authenticated;` then grant client RPCs to `authenticated`
  only, server jobs to `service_role` only. `foundation.test.ts` has a guard that fails if any SECURITY
  DEFINER function in `public` is executable by anon, or by authenticated without being a CONTRACT RPC.
- Every SECURITY DEFINER function must `set search_path = pg_catalog, public, pg_temp` (guarded by a test).
- Error codes used by RPCs: `28000` not authenticated, `42501` not allowed, `P0002` not found,
  `22023` invalid argument, `23514` rule violated (incl. group full, unbalanced entry), `23505` idempotency
  key conflict, `55000` append-only violation.
- Helpers available to later migrations (all in `public`):
  `post_entry(p_group uuid, p_kind entry_kind, p_key text, p_instance uuid, p_memo text, p_lines jsonb) returns uuid`,
  `ensure_account(p_group uuid, p_kind ledger_account_kind, p_user uuid, p_instance uuid, p_pact uuid) returns uuid`
  (pot accounts get `pact_id` filled from the instance; member accounts require the user to be or have been a
  group member), `is_group_member(uuid)`, `is_pact_participant(uuid)`, `is_pact_group_member(uuid)`,
  `is_instance_group_member(uuid)`, `shares_group_with(uuid)`, `is_valid_tz(text)`, `valid_days_of_week(smallint[])`.
- `post_entry` amounts must be JSON numbers with no fractional part (`jsonb_build_object('amount_cents', x)` with
  an int/bigint is fine; strings are rejected).
